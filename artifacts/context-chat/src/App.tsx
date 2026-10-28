import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  getHealthCheckQueryKey,
  getListGeminiConversationsQueryKey,
  getListGeminiMessagesQueryKey,
  useCreateGeminiConversation,
  useDeleteGeminiConversation,
  useHealthCheck,
  useListGeminiConversations,
  useListGeminiMessages,
  useSendGeminiMessage,
} from '@workspace/api-client-react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleHelp,
  Clock3,
  MessageCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function Home() {
  const queryClient = useQueryClient();
  const conversationsQuery = useListGeminiConversations();
  const { data: health } = useHealthCheck({
    query: { retry: false, queryKey: getHealthCheckQueryKey() },
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pageError, setPageError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [sendingCount, setSendingCount] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const conversations = conversationsQuery.data ?? [];
  const activeConversation = conversations.find((item) => item.id === activeId);
  const messagesQuery = useListGeminiMessages(activeId ?? '', {
    query: {
      enabled: Boolean(activeId),
      queryKey: getListGeminiMessagesQueryKey(activeId ?? ''),
    },
  });
  const createConversation = useCreateGeminiConversation();
  const sendMessage = useSendGeminiMessage();
  const deleteConversation = useDeleteGeminiConversation();
  const messages = messagesQuery.data ?? [];

  const groupedConversations = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86_400_000;
    const groups: Record<string, typeof conversations> = {};
    [...conversations]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .forEach((conversation) => {
        const date = new Date(conversation.updatedAt).getTime();
        const group = date >= today ? 'Today' : date >= yesterday ? 'Yesterday' : 'Earlier';
        groups[group] = [...(groups[group] ?? []), conversation];
      });
    return groups;
  }, [conversations]);

  useEffect(() => {
    if (activeId && !conversations.some((item) => item.id === activeId)) setActiveId(null);
  }, [activeId, conversations]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sendingCount, activeId]);

  const startConversation = async () => {
    setPageError('');
    try {
      const conversation = await createConversation.mutateAsync();
      await queryClient.invalidateQueries({ queryKey: getListGeminiConversationsQueryKey() });
      setActiveId(conversation.id);
      setDraft('');
      window.setTimeout(() => textareaRef.current?.focus(), 40);
    } catch (error) {
      setPageError(readApiError(error));
    }
  };

  const submitMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || sendMessage.isPending || createConversation.isPending) return;
    setPageError('');
    setDraft('');
    let conversationId = activeId;
    try {
      if (!conversationId) {
        const conversation = await createConversation.mutateAsync();
        conversationId = conversation.id;
        setActiveId(conversation.id);
        await queryClient.invalidateQueries({ queryKey: getListGeminiConversationsQueryKey() });
      }
      setSendingCount(messages.length + 1);
      const turn = await sendMessage.mutateAsync({ conversationId, data: { content } });
      setSendingCount(null);
      queryClient.setQueryData(
        getListGeminiMessagesQueryKey(conversationId),
        (previous: typeof messages | undefined) => {
          const known = new Set(previous?.map((message) => message.id) ?? []);
          return [...(previous ?? []), turn.userMessage, turn.assistantMessage].filter(
            (message, index, all) => known.has(message.id) ? false : all.findIndex((item) => item.id === message.id) === index,
          );
        },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListGeminiMessagesQueryKey(conversationId) }),
        queryClient.invalidateQueries({ queryKey: getListGeminiConversationsQueryKey() }),
      ]);
    } catch (error) {
      setSendingCount(null);
      setDraft(content);
      setPageError(readApiError(error));
      if (conversationId) {
        await queryClient.invalidateQueries({ queryKey: getListGeminiConversationsQueryKey() });
        await queryClient.invalidateQueries({ queryKey: getListGeminiMessagesQueryKey(conversationId) });
      }
    }
  };

  const removeConversation = async (id: string) => {
    try {
      await deleteConversation.mutateAsync({ conversationId: id });
      await queryClient.invalidateQueries({ queryKey: getListGeminiConversationsQueryKey() });
      queryClient.removeQueries({ queryKey: getListGeminiMessagesQueryKey(id) });
      if (activeId === id) setActiveId(null);
      setDeleteTarget(null);
    } catch (error) {
      setPageError(readApiError(error));
      setDeleteTarget(null);
    }
  };

  const isWorking = createConversation.isPending || sendMessage.isPending;
  const isApiReady = health?.status?.toLowerCase() === 'ok' || health?.status?.toLowerCase() === 'healthy';

  return (
    <main className="paper-grain flex h-[100dvh] min-h-[540px] overflow-hidden bg-background text-foreground">
      <aside className="relative z-10 flex w-[286px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground max-md:w-[74px]">
        <div className="flex h-[76px] items-center gap-3 px-6 max-md:justify-center max-md:px-0">
          <div className="brand-mark flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <MessageCircle size={18} strokeWidth={1.8} />
          </div>
          <div className="max-md:hidden">
            <div className="font-semibold tracking-[-.04em]">Context</div>
            <div className="mono text-[9px] uppercase tracking-[.19em] text-muted-foreground">a place to think</div>
          </div>
        </div>

        <div className="px-4 pb-5 max-md:px-3">
          <button
            type="button"
            data-testid="button-new-conversation"
            onClick={startConversation}
            disabled={isWorking}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-sidebar-border bg-background/65 px-3 text-sm font-semibold transition-colors hover:bg-background disabled:opacity-50 max-md:h-11 max-md:px-0"
          >
            <MessageSquarePlus size={16} />
            <span className="max-md:hidden">New conversation</span>
            <Plus size={14} className="ml-auto text-muted-foreground max-md:hidden" />
          </button>
        </div>

        <div className="mb-2 flex items-center justify-between px-6 max-md:hidden">
          <span className="mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">Your threads</span>
          <span className="mono text-[10px] text-muted-foreground">{conversations.length.toString().padStart(2, '0')}</span>
        </div>
        <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {conversationsQuery.isLoading ? (
            <div className="space-y-2 px-2 pt-2" aria-label="Loading conversations">
              {[0, 1, 2].map((item) => <div key={item} className="h-10 animate-pulse rounded-lg bg-sidebar-accent/70" />)}
            </div>
          ) : conversationsQuery.isError ? (
            <div className="px-3 py-4 text-xs leading-5 text-muted-foreground max-md:hidden">
              Couldn’t load your conversations.
              <button type="button" onClick={() => conversationsQuery.refetch()} className="mt-2 block font-semibold text-primary">Try again</button>
            </div>
          ) : conversations.length === 0 ? (
            <div className="px-3 py-4 text-xs leading-5 text-muted-foreground max-md:hidden">Your conversations will find a home here.</div>
          ) : (
            Object.entries(groupedConversations).map(([group, items]) => (
              <section key={group} className="mb-5">
                <p className="mb-1 px-3 py-1 font-mono text-[9px] uppercase tracking-[.16em] text-muted-foreground md:hidden">{group.slice(0, 1)}</p>
                <p className="mb-1 px-3 py-1 text-[10px] font-medium text-muted-foreground max-md:hidden">{group}</p>
                {items.map((conversation) => (
                  <div key={conversation.id} className={`group relative mb-1 flex items-center rounded-lg transition-colors ${activeId === conversation.id ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/70'}`}>
                    <button
                      type="button"
                      data-testid={`button-select-conversation-${conversation.id}`}
                      onClick={() => { setActiveId(conversation.id); setPageError(''); }}
                      className="min-w-0 flex-1 px-3 py-2.5 text-left"
                      title={conversation.title}
                    >
                      <span className="block truncate text-[13px] font-medium">{conversation.title || 'Untitled thought'}</span>
                      <span className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground max-md:hidden">
                        <Clock3 size={10} /> {formatRelativeDate(conversation.updatedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      data-testid={`button-delete-conversation-${conversation.id}`}
                      aria-label={`Delete ${conversation.title || 'conversation'}`}
                      onClick={() => setDeleteTarget(conversation.id)}
                      className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-destructive group-hover:opacity-100 focus:opacity-100 max-md:opacity-100"
                    >
                      <MoreHorizontal size={15} />
                    </button>
                    {deleteTarget === conversation.id && (
                      <div className="absolute right-2 top-9 z-30 w-48 rounded-xl border border-border bg-card p-3 shadow-lg">
                        <p className="text-xs font-medium">Delete this conversation?</p>
                        <p className="mt-1 text-[10px] text-muted-foreground">Its messages will be removed too.</p>
                        <div className="mt-3 flex justify-end gap-2">
                          <button type="button" data-testid={`button-cancel-delete-${conversation.id}`} onClick={() => setDeleteTarget(null)} className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted">Keep</button>
                          <button type="button" data-testid={`button-confirm-delete-${conversation.id}`} disabled={deleteConversation.isPending} onClick={() => removeConversation(conversation.id)} className="rounded-md bg-destructive px-2 py-1 text-[11px] font-medium text-destructive-foreground disabled:opacity-50">Delete</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </section>
            ))
          )}
        </nav>

        <div className="border-t border-sidebar-border px-5 py-4 max-md:flex max-md:justify-center max-md:px-0">
          <div className="flex items-center gap-2.5">
            <span className={`h-1.5 w-1.5 rounded-full ${health?.status ? (isApiReady ? 'bg-emerald-600' : 'bg-amber-600') : 'bg-muted-foreground/40'}`} />
            <div className="text-[11px] text-muted-foreground max-md:hidden">
              {health?.status ? (isApiReady ? 'API server connected' : 'Service is responding') : 'Checking connection'}
            </div>
            <div className="group relative max-md:hidden">
              <CircleHelp size={13} className="text-muted-foreground/70" />
              <div className="pointer-events-none absolute bottom-6 left-1/2 z-20 w-52 -translate-x-1/2 rounded-lg bg-foreground px-3 py-2 text-[10px] leading-4 text-background opacity-0 transition-opacity group-hover:opacity-100">
                Your conversations are kept separate, so each thread remembers its own context.
              </div>
            </div>
          </div>
        </div>
      </aside>

      <section className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-[76px] shrink-0 items-center justify-between border-b border-border/70 px-8 max-sm:px-5">
          <div className="min-w-0">
            <div className="mono mb-1 text-[9px] uppercase tracking-[.17em] text-muted-foreground">Your private thinking space</div>
            <h1 data-testid="text-current-conversation" className="truncate text-[15px] font-semibold tracking-[-.02em]">
              {activeConversation?.title || (activeId ? 'New conversation' : 'A quieter kind of chat')}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {activeConversation && messages.length > 0 && (
              <span className="mono text-[10px] text-muted-foreground max-sm:hidden">{messages.length} turns in this thread</span>
            )}
            <div className="flex h-8 items-center gap-1.5 rounded-full border border-border/80 bg-card px-3 text-[10px] font-medium text-muted-foreground">
              <Sparkles size={12} className="text-primary" /> Gemini
            </div>
          </div>
        </header>

        {(pageError || conversationsQuery.isError) && (
          <div data-testid="status-api-error" role="alert" className="mx-auto mt-4 flex w-[min(760px,calc(100%-40px))] items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <CircleHelp size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">That didn’t go through</p>
              <p className="mt-0.5 break-words text-xs leading-5">{pageError || readApiError(conversationsQuery.error)}</p>
              {(pageError || readApiError(conversationsQuery.error)).toLowerCase().includes('gemini_api_key') && <p className="mt-1 text-xs">The server needs a valid <code className="mono">GEMINI_API_KEY</code> to reply.</p>}
            </div>
            <button type="button" aria-label="Dismiss error" onClick={() => setPageError('')} className="rounded p-1 hover:bg-destructive/10"><X size={14} /></button>
          </div>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {activeId ? (
            <div className="mx-auto w-full max-w-[850px] px-8 pb-8 pt-10 max-sm:px-5 max-sm:pt-7">
              {messagesQuery.isLoading ? (
                <div className="space-y-8" aria-label="Loading conversation">
                  <div className="ml-auto h-20 w-[62%] animate-pulse rounded-2xl bg-accent/50" />
                  <div className="h-32 w-[76%] animate-pulse rounded-2xl bg-card" />
                  <div className="ml-auto h-16 w-[55%] animate-pulse rounded-2xl bg-accent/50" />
                </div>
              ) : messagesQuery.isError ? (
                <div data-testid="status-messages-error" className="mx-auto mt-20 max-w-md rounded-2xl border border-border bg-card p-6 text-center">
                  <p className="serif text-2xl">Couldn’t open this thread</p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{readApiError(messagesQuery.error)}</p>
                  <button type="button" onClick={() => messagesQuery.refetch()} className="mt-4 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground">Try again</button>
                </div>
              ) : messages.length === 0 ? (
                <div className="fade-in flex min-h-[45vh] flex-col items-center justify-center text-center">
                  <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-card text-primary shadow-sm"><MessageCircle size={23} strokeWidth={1.5} /></div>
                  <p className="mono text-[10px] uppercase tracking-[.18em] text-muted-foreground">A fresh page</p>
                  <h2 className="serif mt-3 max-w-lg text-4xl leading-[1.03] tracking-[-.025em] sm:text-[48px]">What’s on your mind?</h2>
                  <p className="mt-4 max-w-sm text-sm leading-6 text-muted-foreground">Start anywhere. This conversation will remember what you share here.</p>
                </div>
              ) : (
                <div className="space-y-8">
                  {messages.map((message, index) => (
                    <article key={message.id} data-testid={`message-${message.role}-${message.id}`} className={`fade-in flex gap-3.5 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`} style={{ animationDelay: `${Math.min(index * 30, 180)}ms` }}>
                      {message.role === 'assistant' && (
                        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-primary"><Sparkles size={15} /></div>
                      )}
                      <div className={`max-w-[min(78%,650px)] ${message.role === 'user' ? 'rounded-2xl rounded-tr-sm bg-[#eadfd3] px-5 py-3.5 dark:bg-[#392b23]' : 'pt-1'}`}>
                        {message.role === 'assistant' && <div className="mb-2 mono text-[9px] uppercase tracking-[.16em] text-primary">Context</div>}
                        <div className="whitespace-pre-wrap break-words text-[14px] leading-[1.75]">{message.content}</div>
                        <div className={`mt-2 text-[9px] text-muted-foreground ${message.role === 'user' ? 'text-right' : ''}`}>{formatTime(message.createdAt)}</div>
                      </div>
                    </article>
                  ))}
                  {sendingCount !== null && (
                    <div data-testid="status-assistant-thinking" className="fade-in flex gap-3.5">
                      <div className="mt-1 flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-card text-primary"><Sparkles size={15} /></div>
                      <div className="pt-1">
                        <div className="mb-2 mono text-[9px] uppercase tracking-[.16em] text-primary">Thinking it through</div>
                        <div className="flex gap-1.5 py-2"><i className="thinking-dot" /><i className="thinking-dot delay-1" /><i className="thinking-dot delay-2" /></div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="fade-in mx-auto flex min-h-full max-w-[960px] flex-col justify-center px-10 pb-8 pt-12 max-sm:px-6">
              <div className="mb-5 flex items-center gap-2">
                <span className="h-px w-8 bg-primary/60" />
                <span className="mono text-[10px] uppercase tracking-[.2em] text-primary">A little room to think</span>
              </div>
              <h2 className="serif max-w-[690px] text-[58px] leading-[.99] tracking-[-.035em] sm:text-[76px]">Let the thought<br /><em className="text-primary">unfold.</em></h2>
              <p className="mt-6 max-w-[425px] text-[15px] leading-7 text-muted-foreground">A conversation that can hold onto the details. Pick up a thread whenever you’re ready.</p>
              <div className="mt-12 grid max-w-[730px] grid-cols-2 gap-3 max-sm:grid-cols-1">
                {[
                  ['Untangle an idea', 'I have a thought I can’t quite put into words…'],
                  ['Think through a decision', 'Help me look at this from a few angles…'],
                  ['Make a small plan', 'I want to make progress on something this week…'],
                  ['Start from scratch', 'There’s something I’ve been meaning to ask…'],
                ].map(([label, prompt], index) => (
                  <button key={label} type="button" data-testid={`button-prompt-${index + 1}`} onClick={() => { setDraft(prompt); textareaRef.current?.focus(); }} className="group flex items-start justify-between rounded-xl border border-border/80 bg-card/55 px-4 py-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:bg-card">
                    <span><span className="block text-[13px] font-semibold">{label}</span><span className="mt-1.5 block text-xs text-muted-foreground">{prompt}</span></span>
                    <ArrowDown size={14} className="mt-0.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 px-6 pb-5 pt-3 max-sm:px-4 max-sm:pb-3">
          <form onSubmit={submitMessage} className="mx-auto max-w-[790px]">
            <div className="relative rounded-2xl border border-border bg-card p-2 shadow-[0_7px_24px_-16px_hsl(27_22%_17%/.28)] transition-colors focus-within:border-primary/45">
              <textarea
                ref={textareaRef}
                data-testid="input-message"
                value={draft}
                onChange={(event) => setDraft(event.target.value.slice(0, 12000))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void submitMessage();
                  }
                }}
                placeholder="Write what’s on your mind…"
                rows={2}
                maxLength={12000}
                aria-label="Your message"
                className="block max-h-40 min-h-[54px] w-full resize-y bg-transparent px-3 pt-2.5 pr-14 text-[14px] leading-6 outline-none placeholder:text-muted-foreground/75"
              />
              <div className="flex items-center justify-between px-2 pb-1">
                <span className="text-[10px] text-muted-foreground">{draft.length > 0 ? `${draft.length.toLocaleString()} / 12,000` : 'Your words stay in this conversation'}</span>
                <button type="submit" data-testid="button-send-message" disabled={!draft.trim() || isWorking} aria-label="Send message" className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-35">
                  {isWorking ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <ArrowUp size={17} />}
                </button>
              </div>
            </div>
            <p className="mt-2 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground/75"><Check size={10} /> Separate conversations, thoughtful context</p>
          </form>
        </div>
      </section>
    </main>
  );
}

function readApiError(error: unknown): string {
  if (error && typeof error === 'object') {
    const maybe = error as { message?: string; data?: { error?: string }; response?: { data?: { error?: string } } };
    const backendMessage = maybe.data?.error ?? maybe.response?.data?.error;
    if (backendMessage) return backendMessage;
    if (maybe.message) {
      try {
        const parsed = JSON.parse(maybe.message) as { error?: string };
        if (parsed.error) return parsed.error;
      } catch {
        return maybe.message;
      }
      return maybe.message;
    }
  }
  return 'Something went wrong. Please try again.';
}

function formatRelativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
