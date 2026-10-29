import { GoogleGenAI } from "@google/genai";
import {
  and,
  asc,
  desc,
  eq,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  CreateGeminiConversationResponse,
  DeleteGeminiConversationParams,
  ListGeminiConversationsResponse,
  ListGeminiMessagesParams,
  ListGeminiMessagesResponse,
  SendGeminiMessageBody,
  SendGeminiMessageParams,
  SendGeminiMessageResponse,
} from "@workspace/api-zod";
import {
  chatMessagesTable,
  conversationsTable,
  db,
} from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();
const MODEL_CANDIDATES = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
] as const;
const HISTORY_LIMIT = 20;
const RETRYABLE_PROVIDER_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const SESSION_COOKIE = "context_chat_session";
const SYSTEM_INSTRUCTION = `You are Rowan, a thoughtful and practical conversation partner. Help people think clearly, learn, and make progress. Be warm, curious, and concise without sounding robotic. Use details from the conversation when relevant, ask a focused follow-up when it would help, and be honest when you are uncertain. Do not claim to remember anything outside the conversation provided to you.`;

function getSessionId(req: Request, res: Response): string {
  const existingId = req.signedCookies?.[SESSION_COOKIE];
  if (typeof existingId === "string") {
    return existingId;
  }

  const sessionId = randomUUID();
  res.cookie(SESSION_COOKIE, sessionId, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 365,
    path: "/",
  });
  return sessionId;
}

async function findOwnedConversation(
  conversationId: string,
  ownerId: string,
) {
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, conversationId),
        eq(conversationsTable.ownerId, ownerId),
      ),
    )
    .limit(1);

  return conversation;
}

function statusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.status === "number") {
    return candidate.status;
  }
  if (typeof candidate.statusCode === "number") {
    return candidate.statusCode;
  }
  return undefined;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    /timeout|timed out|aborted/i.test(error.message)
  );
}

function safeProviderMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  let message = error.message;
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    message = message.replaceAll(apiKey, "[redacted]");
  }
  return message
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 400);
}

router.get("/gemini/conversations", async (req, res): Promise<void> => {
  const ownerId = getSessionId(req, res);
  const conversations = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.ownerId, ownerId))
    .orderBy(desc(conversationsTable.updatedAt));

  res.json(ListGeminiConversationsResponse.parse(conversations));
});

router.post("/gemini/conversations", async (req, res): Promise<void> => {
  const ownerId = getSessionId(req, res);
  const [conversation] = await db
    .insert(conversationsTable)
    .values({ ownerId })
    .returning();

  res
    .status(201)
    .json(CreateGeminiConversationResponse.parse(conversation));
});

router.get(
  "/gemini/conversations/:conversationId/messages",
  async (req, res): Promise<void> => {
    const params = ListGeminiMessagesParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid conversation ID." });
      return;
    }

    const ownerId = getSessionId(req, res);
    const conversation = await findOwnedConversation(
      params.data.conversationId,
      ownerId,
    );
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    const messages = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.conversationId, conversation.id))
      .orderBy(asc(chatMessagesTable.sequence));

    res.json(ListGeminiMessagesResponse.parse(messages));
  },
);

router.post(
  "/gemini/conversations/:conversationId/messages",
  async (req, res): Promise<void> => {
    const params = SendGeminiMessageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid conversation ID." });
      return;
    }

    const parsedBody = SendGeminiMessageBody.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: "Enter a message of up to 12,000 characters." });
      return;
    }

    const ownerId = getSessionId(req, res);
    const conversation = await findOwnedConversation(
      params.data.conversationId,
      ownerId,
    );
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(503).json({
        error:
          "Gemini is not configured yet. Add GEMINI_API_KEY in Replit Secrets to start chatting.",
      });
      return;
    }

    const previousMessages = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.conversationId, conversation.id))
      .orderBy(asc(chatMessagesTable.sequence));

    let contextMessages = previousMessages.slice(-HISTORY_LIMIT);
    // Gemini expects a conversation to begin with a user turn.
    while (contextMessages[0]?.role === "assistant") {
      contextMessages = contextMessages.slice(1);
    }

    try {
      const ai = new GoogleGenAI({ apiKey });
      const contents = [
        ...contextMessages.map((message) => ({
          role: message.role === "assistant" ? ("model" as const) : ("user" as const),
          parts: [{ text: message.content }],
        })),
        { role: "user" as const, parts: [{ text: parsedBody.data.content }] },
      ];
      let response:
        | Awaited<ReturnType<typeof ai.models.generateContent>>
        | undefined;

      let lastProviderError: unknown;
      for (
        let modelIndex = 0;
        modelIndex < MODEL_CANDIDATES.length && !response;
        modelIndex += 1
      ) {
        const model = MODEL_CANDIDATES[modelIndex];
        const hasFallback = modelIndex < MODEL_CANDIDATES.length - 1;
        const attemptsForModel = hasFallback ? 1 : 2;

        for (let attempt = 0; attempt < attemptsForModel; attempt += 1) {
          try {
            response = await ai.models.generateContent({
              model,
              contents,
              config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                maxOutputTokens: 8192,
                httpOptions: { timeout: 30_000 },
              },
            });
            break;
          } catch (error) {
            lastProviderError = error;
            const providerStatus = statusFromError(error);
            const retryable =
              RETRYABLE_PROVIDER_STATUSES.has(providerStatus ?? 0);

            if (retryable && attempt < attemptsForModel - 1) {
              req.log.warn(
                {
                  providerStatus,
                  attempt: attempt + 1,
                  model,
                  providerMessage: safeProviderMessage(error),
                },
                "Retrying Gemini request after a transient provider error",
              );
              await new Promise((resolve) =>
                setTimeout(resolve, 500 * 2 ** attempt),
              );
              continue;
            }

            if (hasFallback && (retryable || providerStatus === 404)) {
              req.log.warn(
                {
                  providerStatus,
                  model,
                  fallbackModel: MODEL_CANDIDATES[modelIndex + 1],
                  providerMessage: safeProviderMessage(error),
                },
                "Falling back to another Gemini model",
              );
              break;
            }

            throw error;
          }
        }
      }

      if (!response) {
        throw lastProviderError ?? new Error("Gemini did not return a response.");
      }

      const assistantContent = response.text?.trim();
      if (!assistantContent) {
        req.log.warn("Gemini returned an empty response");
        res.status(502).json({
          error: "Gemini returned an empty response. Please try again.",
        });
        return;
      }

      const nextTitle =
        conversation.title === "New conversation"
          ? parsedBody.data.content.replace(/\s+/g, " ").trim().slice(0, 60) ||
            conversation.title
          : conversation.title;
      const [result] = await db.transaction(async (tx) => {
        const [userMessage] = await tx
          .insert(chatMessagesTable)
          .values({
            conversationId: conversation.id,
            role: "user",
            content: parsedBody.data.content,
          })
          .returning();
        const [assistantMessage] = await tx
          .insert(chatMessagesTable)
          .values({
            conversationId: conversation.id,
            role: "assistant",
            content: assistantContent,
          })
          .returning();
        const [updatedConversation] = await tx
          .update(conversationsTable)
          .set({ title: nextTitle, updatedAt: new Date() })
          .where(
            and(
              eq(conversationsTable.id, conversation.id),
              eq(conversationsTable.ownerId, ownerId),
            ),
          )
          .returning();

        return [{ userMessage, assistantMessage, conversation: updatedConversation }];
      });

      res.json(
        SendGeminiMessageResponse.parse({
          conversation: result.conversation,
          userMessage: result.userMessage,
          assistantMessage: result.assistantMessage,
          contextMessageCount: contextMessages.length + 1,
        }),
      );
    } catch (error) {
      const status = statusFromError(error);
      if (isTimeout(error)) {
        res.status(504).json({
          error: "Gemini took too long to respond. Please try again.",
        });
        return;
      }
      if (status === 504) {
        req.log.warn(
          { providerStatus: status, providerMessage: safeProviderMessage(error) },
          "Gemini request exceeded its deadline",
        );
        res.status(504).json({
          error: "Gemini took too long to respond. Please try again.",
        });
        return;
      }
      if (status === 429) {
        res.status(503).json({
          error: "Gemini is busy right now. Wait a moment and try again.",
        });
        return;
      }
      if (status === 503) {
        req.log.warn(
          { providerStatus: status, providerMessage: safeProviderMessage(error) },
          "Gemini is temporarily unavailable",
        );
        res.status(503).json({
          error: "Gemini is temporarily unavailable. Please try again shortly.",
        });
        return;
      }
      if (status === 401 || status === 403) {
        req.log.error(
          { providerStatus: status, providerMessage: safeProviderMessage(error) },
          "Gemini rejected its API key",
        );
        res.status(502).json({
          error: "Gemini rejected the API key. Check GEMINI_API_KEY in Replit Secrets.",
        });
        return;
      }

      req.log.error(
        { providerStatus: status, providerMessage: safeProviderMessage(error) },
        "Gemini request failed",
      );
      res.status(502).json({
        error: "Gemini could not respond. Please try again in a moment.",
      });
    }
  },
);

router.delete(
  "/gemini/conversations/:conversationId",
  async (req, res): Promise<void> => {
    const params = DeleteGeminiConversationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid conversation ID." });
      return;
    }

    const ownerId = getSessionId(req, res);
    const [deletedConversation] = await db
      .delete(conversationsTable)
      .where(
        and(
          eq(conversationsTable.id, params.data.conversationId),
          eq(conversationsTable.ownerId, ownerId),
        ),
      )
      .returning({ id: conversationsTable.id });

    if (!deletedConversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    res.sendStatus(204);
  },
);

export default router;
