# Shared conversation UI

`@agentmux/client-ui` contains the same message, native-history, trace, permission-card and Tiptap composer implementations consumed by AgentMux Desktop. It owns presentation and editing; Core and the Host retain all Agent and Run facts. There is no conversation log, Runtime client, Provider adapter or Session store in this package.

Applications wrap their view in `ClientUiProvider` with an explicit `ClientUiPlatform`. The adapter supplies clipboard error reporting, the overlay target, editor focus registration and identity/icon rendering. File opening, HTTP navigation, pasted-image IO, send/queue/interrupt and permission responses are typed component props. `DescribeSpeaker` may supply an already-rendered avatar; platform-specific Mote and project discovery stays in Desktop.

The optional `renderAgentLink` adapter receives an exact `amux://agent/…` URI and its Core-parsed Session ID. Conversation prose and Markdown links share this inline presentation; code, read-only previews and document mode retain their original presentation. Without the adapter, Markdown remains usable as text. The host resolves current names, Mote appearance, state, details and navigation; message storage and copying retain the original source.

Import `@agentmux/client-ui/styles.css` with the client's theme tokens, font and shell. Styles are also exported individually so Desktop keeps its existing cascade order. Mobile can use these surface rules without importing Desktop's application stylesheet or Zustand store.

The package builds ESM JavaScript for Node runtime consumers; the `browser` export condition gives browser bundlers the same TypeScript source. Node callers use the pure `pasted-images` and `terminal-path-link` leaves, whose import graphs contain no React, Tiptap or DOM runtime. Core has no dependency on this package.

Run `node packages/client-ui/scripts/verify-shared-conversation.mjs --mutation-and-callers` from the workspace. It builds the package, typechecks the actual Desktop Renderer, exercises rendered behaviour, runs isolated mutations and proves actual Desktop invocations outside definitions/imports/tests. It does not mutate the current source during experiments. The Renderer configuration covers all Renderer/shared sources while the original Desktop configuration continues to check Main and preload too. This verification covers shared UI integration; mobile authentication, native devices, terminal attachment and durable recovery are separate implementation tasks.

`node packages/client-ui/scripts/capture-shared-conversation.mjs` builds the actual Desktop Gallery and records normal/narrow scenes in a private Electron profile. Capture receipts and images are retained for independent review; capture success alone is not an aesthetic approval.

## Inputs

`src/input/` is the shared native field module: import `TextInput`, `Textarea` and `InputGroup` from `@agentmux/client-ui/input`, and `@agentmux/client-ui/input/styles.css` when not using the full shared stylesheet. Each component forwards native props and React 19 refs; callers retain labels, values, validation and actions. `InputGroup` is the existing field container with one focus boundary, not an extra wrapper or form state provider. Surface classes retain their own geometry.

`Textarea` is the native presentation layer. Desktop controlled drafts use `ComposerTextarea`, which delegates to it while preserving the composition mirror and final-value writeback. Rich messages use the existing `AgentComposer` with `InlineComposer` (Tiptap): controlled value/change, references, commands, attachments, submit/queue/interrupt and feedback are explicit props. Desktop's `AgentSessionComposer` adapts draft persistence, native file IO and delivery; Core retains Session/Run authority. These responsibilities do not move into the native input module.
