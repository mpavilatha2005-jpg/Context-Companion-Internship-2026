---
name: Chat session ownership
description: Conversation privacy and identity scope for the chatbot.
---

Conversation ownership is scoped to a signed, HTTP-only browser cookie rather than a user account.

**Why:** The first build needed private per-visitor histories without adding an unrequested sign-up flow.

**How to apply:** Keep chat reads and writes filtered by the browser session. Cross-device history or named user profiles require explicit authentication and an ownership migration.
