# Message workspace production Renderer scene

```sh
pnpm exec vitest run --config apps/desktop/scripts/fixtures/message-tool-workspace/vitest.config.mts apps/desktop/test/message-tool-workspace.test.tsx
node apps/desktop/scripts/verify-message-tool-workspace.mjs --mutations
node apps/desktop/scripts/verify-message-tool-workspace.mjs
```

The behavior contract is [Message Tools mailbox](../../../../../docs/design/behavior/conversation-input.md#message-tools-邮箱); visual hierarchy is owned by [the presentation contract](../../../../../docs/design/presentation/conversation-input.md#message-tools-邮箱).

The mounted tests consume the production `AgentSessionComposer → SessionMailbox` chain, its original history and journal hooks, shared records and queue store. The private transform removes one actual consumer at a time: journal query, either refresh reader, journal detail, retained earlier history, original journal edit selection, Automation form retention, reading selection or unfiltered queue adjacency. The unchanged candidate and restored input must pass; an assertion must reject each mutation. Suite discovery and executed tests must be nonempty. No shared product source or compiled package is rewritten.

The isolated Electron scene imports the existing preview Workbench and uses `WorkspaceWorkbench → SessionPane → AgentSessionComposer → SessionMailbox` with the product styles. Only original Desktop API ports supply bounded fixture records. It operates real Chromium pointer and keyboard input at 640, 380 and 320 Region widths in both themes, plus a short surface. The scene searches and clears Inputs, refreshes both readers, copies a complete journal record, returns from Automation to the same detail and reads the original A2A MID with bounded earlier paging. It visits Sent, Collaboration and Notices, edits and cancels a queued draft, retains an unsaved Automation interval, then closes with Escape. It verifies the original editor, draft, pending identities, terminal instance and geometry remain intact; no dispatch or Automation action is allowed.

The pointer checks read the actual computed styles and hit targets: a resting pending row keeps its Send footer visible and actionable, while a plain registered journal row keeps its time visible on hover. They do not dispatch the pending input.

The script prints a private receipt directory. `compilation.json` records the actual imported source and style hashes; `render.json` records runtime identity, nonempty operations and screenshot hashes. `review.md` links the complete images for an independent visual review. Capture and geometry success do not certify aesthetic quality. These controlled Renderer scenes do not certify a live Host, native CLI delivery, installed application or durable Session recovery, and never operate user Sessions.
