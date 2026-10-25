# Shared conversation UI

Product requirements are defined by the [conversation behavior SSOT](../../docs/design/behavior/conversation-mode.md) and [presentation SSOT](../../docs/design/presentation/conversation-mode.md). The [mechanism map](../../docs/architecture/conversation.md) traces current Desktop, Mobile, resource and public API consumers; sharing a component does not by itself prove client parity.

The [client architecture design](../../docs/design/conversation-client-architecture.md) defines target boundaries for unified record presentation, reading protection, progressive rendering and input orchestration. It describes intended responsibilities, not new exports or completed implementation.

`@agentmux/client-ui` contains the same message, native-history, trace, permission-card and Tiptap composer implementations consumed by AgentMux Desktop. It owns presentation and editing; Core and the Host retain all Agent and Run facts. There is no conversation log, Runtime client, Provider adapter or Session store in this package.

`ConversationRecordSequence` presents optional native turn/response metrics from the already-read Core records. It retains source order and mounted reading nodes, shows each loaded turn's latest cumulative sample once, and reuses `NativeProcessObservation` disclosure. Response-only reports retain their own record identity. Import the shared styles (or `styles/conversation-metrics.css` with the host's individual style imports); no additional reader, timer or execution channel is needed.

Applications wrap their view in `ClientUiProvider` with an explicit `ClientUiPlatform`. The adapter supplies clipboard error reporting, the overlay target, editor focus registration and identity/icon rendering. File opening, HTTP navigation, pasted-image IO, send/queue/interrupt and permission responses are typed component props. `DescribeSpeaker` may supply an already-rendered avatar; platform-specific Mote and project discovery stays in Desktop.

`ConversationMessage` accepts the original Core `inputContext` and `inputContextSource` for a compact Browser observation disclosure. `ConversationView`, captured messages, complete text resources and input-mailbox records use the same reading face. Wire declarations use the [Core parser](../core/src/agent-message-render.ts); a confirmed authored body is not parsed again. A structured producer qualifies only its matching context, independently of recorded authorship. Selection provenance retains its own Browser, navigation and step association. Reading does not navigate, fetch an image, dispatch input or grant Browser control; the [amux contract](../../docs/specs/amux-protocol.md#场景数据) owns the data format.

Copy keeps the original parts or the caller's original `copyText`. Mailbox reading uses an existing frozen wire when present; it does not reconstruct a message from the displayed context. `node packages/client-ui/scripts/verify-browser-context-reading.mjs` exercises the mounted conversation, resource and mailbox consumers with isolated production mutations. `node packages/client-ui/scripts/capture-browser-context-reading.mjs` records private normal/narrow shared-reader scenes using the actual theme runtime. These component captures require independent visual review and do not establish full Desktop, native Browser, input delivery or recovery parity.

Semantic icons use `@agentmux/client-ui/icons` and the shared styles. Instances accept `size`, `color`, `strokeWidth`, `strokeLinecap`, `strokeLinejoin` and `animation`. Explicit props override inline style, then the theme pen and inherited color. Animation defaults to `none` for every meaning; current activity must come from the caller's existing state:

```tsx
<SemanticIcon name="status.working" /> // Static heading or recorded status.
<SemanticIcon name="status.working" color="var(--success)" size={12}
  animation={currentlyProducing ? 'work' : 'none'} />
```

The finite presets are `none`, `work`, `stream`, `execute` and `spin`. They affect this instance only, respect reduced motion and do not change saved themes or establish Runtime state. `createSemanticIconElement` accepts the same presentation options: static calls return an SVG; explicit animation can return an HTML carrier containing that SVG. Retain the returned node rather than assuming an animated result is an SVG.

For choosing an existing meaning, adding a semantic ID or glyph, and opening the live catalog with `pnpm icons:dev`, follow the [semantic icon development guide](../../docs/guides/semantic-icons.md). The shared catalog owns defaults; Settings, public discovery and the workbench derive their inventories from it.

The optional `renderObjectLink` adapter receives an exact `amux://agent|region|tab|space|zone/…` URI and its Core-parsed typed target. Conversation prose and Markdown links share this inline presentation; code, read-only previews and document mode retain their original presentation. Without the adapter, Markdown remains usable as text. The host resolves current names, Mote appearance, state, details and navigation; message storage and copying retain the original source.

Import `@agentmux/client-ui/styles.css` with the client's theme tokens, font and shell. Styles are also exported individually so Desktop keeps its existing cascade order. Mobile can use these surface rules without importing Desktop's application stylesheet or Zustand store.

Dialogs import `@agentmux/client-ui/components/Modal`; hosts importing individual styles also include `@agentmux/client-ui/styles/overlays.css`. The shared module owns modal presentation, attachment slots and focus lifetime over Radix. Use `useModalOverlayContainer` for attached custom portals; a `null` result means the slot is not ready and must not fall through to a document body. Desktop components use its `DocumentOverlayPortal` / `WindowOverlayPortal` adapters. Keep business requests and drafts in their original caller. Layer roles and material follow the [presentation owner](../../docs/design/presentation/shared-rules.md#弹层作用域与层级); exact document, native projection and contribution checks are described by the [implementation map](../../docs/architecture/ui-layering.md). Avoid raw Radix Dialog imports, copied window ranks or manual visibility counters in new consumers.

The package builds ESM JavaScript for Node runtime consumers; the `browser` export condition gives browser bundlers the same TypeScript source. Node callers use the pure `pasted-images` and `terminal-path-link` leaves, whose import graphs contain no React, Tiptap or DOM runtime. Core has no dependency on this package.

Run `node packages/client-ui/scripts/verify-shared-conversation.mjs --mutation-and-callers` from the workspace. It builds the package, typechecks the actual Desktop Renderer, exercises rendered behaviour, runs isolated mutations and proves actual Desktop invocations outside definitions/imports/tests. It does not mutate the current source during experiments. The Renderer configuration covers all Renderer/shared sources while the original Desktop configuration continues to check Main and preload too. This verification covers shared UI integration; mobile authentication, native devices, terminal attachment and durable recovery are separate implementation tasks.

`node packages/client-ui/scripts/capture-shared-conversation.mjs` builds the actual Desktop Gallery and records normal/narrow scenes in a private Electron profile. Capture receipts and images are retained for independent review; capture success alone is not an aesthetic approval.

## Native actions

Import `Button` and `IconButton` from `@agentmux/client-ui/components/Button` and
`@agentmux/client-ui/components/IconButton`. Both render a native button, default
`type` to `button`, and forward native props and React 19 refs. Use an explicit
`type="submit"` for form submission. Callers retain their original handlers,
`disabled`, `aria-busy`, requests and drafts; busy presentation never disables an
otherwise available action or retries an operation.

`Button` accepts `variant="secondary" | "primary" | "danger"` (default secondary).
`IconButton` requires `aria-label`, defaults its native title to that name, and
accepts `intent="neutral" | "danger"`. Explicit titles remain intact. The existing
`.small-button`, `.primary-button`, `.danger-button` and `.icon-button` classes
have one shared owner in `styles/buttons.css`; include
`@agentmux/client-ui/styles/buttons.css` when importing individual styles.
Hosts keep surface-specific geometry and supply the original theme tokens.

## Inputs

`src/input/` is the shared native field module: import `TextInput`, `Textarea` and `InputGroup` from `@agentmux/client-ui/input`, and `@agentmux/client-ui/input/styles.css` when not using the full shared stylesheet. Each component forwards native props and React 19 refs; callers retain labels, values, validation and actions. `InputGroup` is the existing field container with one focus boundary, not an extra wrapper or form state provider. Surface classes retain their own geometry.

`Textarea` is the native presentation layer. Desktop controlled drafts use `ComposerTextarea`, which delegates to it while preserving the composition mirror and final-value writeback. Rich messages use the existing `AgentComposer` with `InlineComposer` (Tiptap): controlled value/change, references, commands, attachments, submit/queue/interrupt and feedback are explicit props. Desktop's `AgentSessionComposer` adapts draft persistence, native file IO and delivery; Core retains Session/Run authority. These responsibilities do not move into the native input module.
