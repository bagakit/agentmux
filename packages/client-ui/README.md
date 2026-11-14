# @agentmux/client-ui

`@agentmux/client-ui` holds the React UI and document-format helpers that AgentMux clients share. It owns presentation, editing and shared Note syntax: Core and the Host keep every Agent, Session and Run fact, and the package contains no conversation log, Runtime client, Provider adapter or Session store. Core does not depend on it.

| Module | Import | What it provides |
| --- | --- | --- |
| Conversation | `@agentmux/client-ui` (`ConversationView`, `ConversationMessage`), `components/ConversationRecordSequence` | Messages, native-history reading, reasoning and tool traces, permission and question cards, recorded images and files |
| Composer | `components/AgentComposer`, `components/InlineComposer`, `components/ComposerEditFooter` | Rich message editing and the action row for a compact multiline edit |
| Terminal | `@agentmux/client-ui/terminal/*` | xterm replay, live output, input encoding and the Unicode width table |
| Notes | `@agentmux/client-ui/note/*`, `components/NoteReader` | The `.note.md` Markdown codec, wiki links, live three-way merge and a read-only Note reader |
| Theme and icons | `@agentmux/client-ui/theme`, `@agentmux/client-ui/icons` | Theme catalog and built-in themes, semantic icons and their animations |
| Native controls | `components/Button`, `components/IconButton`, `components/FormRow`, `input`, `components/Modal` | Buttons, form rows, text inputs and dialogs with one shared style owner |
| Menu and avatars | `components/HoverDropdownMenu`, `components/AvatarGroup` | Menu disclosure and keyboard focus in the host document, plus avatar stacking and overflow |
| Brand assets | `@agentmux/client-ui/brand/*` | App icons, hero art and illustrations ([brand sources](brand/README.md)) |

Use the [component index](../../docs/design/agentmux-surface-density.md#按控件开始贡献) to find import paths, current consumers and design requirements. `components/` contains renderable components, `input/` owns native field primitives and their styles, and `lib/` provides the hooks and formatting that those components consume. Client adapters supply overlays, file and clipboard access, and business actions.

Product requirements are defined by the [conversation behavior SSOT](../../docs/design/behavior/conversation-mode.md) and [presentation SSOT](../../docs/design/presentation/conversation-mode.md). The [mechanism map](../../docs/architecture/conversation.md) traces the current Desktop, Mobile, resource and public API consumers; sharing a component does not by itself make the two clients equivalent. How these components read and render today is described in the [Desktop reading chain](../../docs/architecture/conversation.md#desktop-阅读链): `useConversationView` reads accepted windows through Core's public Reader; `projectConversationRecordSequence` groups the ordered records into messages and process groups with stable display identities; `useConversationRecordLayout` is the one commit owner per reading position and protects selection, focus and the scroll anchor while a new layout is applied; and `ConversationBodyWork` mounts at most one heavy body per animation frame, so heavy content renders progressively inside a bounded window rather than through a full virtual list.

## Platform adapter

Applications wrap their view in `ClientUiProvider` with an explicit `ClientUiPlatform`. The adapter supplies clipboard error reporting, the overlay target, editor focus registration and identity and icon rendering. File opening, HTTP navigation, pasted-image IO, send / queue / interrupt and permission responses are typed component props. `DescribeSpeaker` may supply an already rendered avatar; Mote and project discovery stay in Desktop.

## Node consumers

The package builds ESM JavaScript for Node consumers, and its `browser` export condition gives browser bundlers the TypeScript source. Node support belongs to the selected entry and its purpose:

| Entry | Node responsibility and dependencies |
| --- | --- |
| `pasted-images`, `terminal-path-link` | Pure value helpers; their import graphs contain no React, Tiptap or DOM runtime. |
| `agent-avatar-svg`, `mote-avatar-svg` and their static artwork dependencies | Shared static avatar rendering, including React and `react-dom/server` where needed. The Host supplies saved appearance and owned raster resources; rendering does not mount an editor or browser DOM. |
| `note/*` document codecs, merge and provenance helpers, including `note-content-schema` | Read and serialize the shared Note format and validate it with the same Tiptap schema as the editor. The Host's [Note writer](../../apps/host/src/note-file-writer.ts) uses these without creating an editor DOM; the original Files owner keeps IO, revision checks, CAS and write receipts. |

These entries do not make the package root, interactive components or every wildcard export suitable for Node. Host code imports the required entry directly; Core remains independent of `client-ui` and its UI dependencies.

## Conversation reading

`ConversationRecordSequence` shows native turn and response metrics from records Core has already read. It keeps source order and the mounted reading nodes, shows each loaded turn's latest cumulative sample once, and reuses the `NativeProcessObservation` disclosure; response-only reports keep their own record identity. Import the shared styles (or `styles/conversation-metrics.css` with the host's individual style imports); no extra reader, timer or execution channel is needed.

`ConversationMessage` accepts Core's `inputContext` and `inputContextSource` and shows them as a compact Browser observation disclosure. `ConversationView`, captured messages, complete text resources and mailbox records use the same reading surface. Wire declarations are parsed by the [Core reader](../core/src/agent-message-render.ts); a body already confirmed as authored is not parsed again. A structured producer qualifies only the context it matches, independently of recorded authorship, and a selection keeps its own Browser, navigation and step association. Reading never navigates, fetches an image, sends input or grants Browser control; the data format belongs to the [amux protocol](../../docs/specs/amux-protocol.md#场景数据).

Copy keeps the original parts or the caller's `copyText`. Mailbox reading uses a stored frozen wire when there is one and never rebuilds a message from the displayed context.

The optional `renderObjectLink` adapter receives an exact `amux://agent|region|tab|space|zone|capsule/…` URI and its Core-parsed target. Conversation prose and Markdown links share this inline presentation; code, read-only previews and document mode keep plain text. Without the adapter, Markdown stays readable as text. The host resolves current names, Mote appearance, state, details and navigation; stored messages and Copy keep the original source.

## Terminal

Desktop and Mobile render Agent terminals with the same modules:

- **Replay** writes retained Run bytes to xterm in 128 KiB batches and yields between batches, so a large scrollback never blocks input, navigation or closing the view. A batch boundary is only a scheduling boundary; xterm continues an escape sequence across writes.
- **Live output** coalesces small Runtime events into writes of at most 64 KiB. The unparsed backlog is capped at 2 MiB: on overflow the oldest queued events are dropped, not Runtime history, and the drain recovers the retained bytes from its last parsed cursor before consuming the newer tail. Only a Runtime Gap or a failed recovery produces an omission notice.
- **Unicode width** is set to the Unicode 11 table before any bytes are parsed, because changing the table later cannot repair cells that were already laid out.
- **Input** encodes binary terminal reports and subscribes to xterm input events for the caller's write path.

## Notes

`note/` holds the `.note.md` Markdown codec with stable block IDs and wiki links ([file format](../../docs/specs/note-markdown.md)), rich-block validation, draft includes and the live merge used when a person and Agents edit the same Note. Rich validation and the diff3 merge run in a worker, off the input thread. `NoteReader` renders bytes the host has already read; every file read stays with the host.

## Icons and themes

Semantic icons come from `@agentmux/client-ui/icons` and the shared styles. Instances accept `size`, `color`, `strokeWidth`, `strokeLinecap`, `strokeLinejoin` and `animation`; explicit props override inline style, then the theme pen and the inherited color. Animation defaults to `none` for every meaning, and current activity must come from the caller's own state:

```tsx
<SemanticIcon name="status.working" /> // Static heading or recorded status.
<SemanticIcon name="status.working" color="var(--success)" size={12}
  animation={currentlyProducing ? 'work' : 'none'} />
```

The animation presets are `none`, `work`, `stream`, `execute`, `wait`, `orbit`, `feedback`, `selection` and `spin`. A preset affects only that instance, respects reduced motion and does not change saved themes or imply Runtime state. `createSemanticIconElement` takes the same options: a static call returns an SVG, and an animated call can return an HTML element that contains the SVG, so keep the returned node rather than assuming it is an SVG.

To choose a meaning, add a semantic ID or glyph, or open the live catalog with `pnpm icons:dev`, follow the [semantic icon guide](../../docs/guides/semantic-icons.md). The shared catalog owns the defaults; Settings, public discovery and the workbench derive their lists from it.

## Styles and dialogs

Import `@agentmux/client-ui/styles.css` together with the client's theme tokens, font and shell. Styles are also exported individually so Desktop keeps its cascade order; Mobile uses these surface rules without Desktop's application stylesheet or Zustand store.

Dialogs import `@agentmux/client-ui/components/Modal`; hosts that import individual styles also include `@agentmux/client-ui/styles/overlays.css`. The shared module owns modal presentation, attachment slots and focus lifetime on top of Radix. Use `useModalOverlayContainer` for attached custom portals; a `null` result means the slot is not ready yet and must not fall back to the document body. Desktop components use its `DocumentOverlayPortal` / `WindowOverlayPortal` adapters. Business requests and drafts stay with the caller. Layer roles and materials follow the [presentation owner](../../docs/design/presentation/shared-rules.md#弹层作用域与层级), and document, native projection and contribution checks are described in the [implementation map](../../docs/architecture/ui-layering.md). New consumers should not import Radix Dialog directly, copy window ranks or keep manual visibility counters.

## Native actions

Import `Button` and `IconButton` from `@agentmux/client-ui/components/Button` and `@agentmux/client-ui/components/IconButton`. Both render a native button, default `type` to `button`, and forward native props and React 19 refs; use an explicit `type="submit"` for form submission. Callers keep their handlers, `disabled`, `aria-busy`, requests and drafts; busy presentation never disables an otherwise available action or retries an operation.

`Button` accepts `variant="secondary" | "primary" | "danger"` (default `secondary`). `IconButton` requires `aria-label`, uses it as the default native title, and accepts `intent="neutral" | "danger"`; an explicit title is kept. The `.small-button`, `.primary-button`, `.danger-button` and `.icon-button` classes have one owner in `styles/buttons.css`; include `@agentmux/client-ui/styles/buttons.css` when importing individual styles. Hosts keep surface-specific geometry and supply the theme tokens.

## Inputs

### Compact editors

Use `ComposerTextarea variant="compact"` with `ComposerEditFooter` for a short multiline edit inside an existing surface. The field handles IME, grows with content, and scrolls when it reaches its height limit. Put existing utilities or metadata in `leading` and the action buttons in reading order. Use the shared primary `Button` for the action at the right edge. Hosts importing styles individually need `input/styles.css`, `styles/buttons.css` and `styles/composer.css`.

```tsx
import { ComposerTextarea } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { ComposerEditFooter } from '@agentmux/client-ui/components/ComposerEditFooter'

<ComposerTextarea variant="compact" aria-label="Message" value={draft} onValueChange={setDraft} />
<ComposerEditFooter>
  <Button onClick={onCancel}>Cancel</Button>
  <Button variant="primary" disabled={saving} aria-busy={saving} onClick={onSave}>
    {saving ? 'Saving' : 'Save'}
  </Button>
</ComposerEditFooter>
```

The [queued message editor](../../apps/desktop/src/renderer/src/components/ComposerQueuedMessageEditor.tsx) and [conversation annotation](../../apps/desktop/src/renderer/src/components/ConversationAnnotationNote.tsx) show the same field and footer with different action, draft and error owners.

### Labels and single fields

`FormRow` from `@agentmux/client-ui/components/FormRow` renders one native label with a separate title and description. Its child callback supplies `id`, `aria-labelledby` and `aria-describedby`; spread them onto the native control. The whole row is the label, and only the title supplies the accessible name. `controlId` keeps an explicit field ID when needed. The caller keeps the input's ref, name, value, checked state, handlers and disabled state. FormRow has no field state or validation model, clones no control and adds no styles; pass the surface's row class. Whole-save errors stay with the caller's save feedback.

`src/input/` is the shared native field module: import `TextInput`, `Textarea` and `InputGroup` from `@agentmux/client-ui/input`, plus `@agentmux/client-ui/input/styles.css` when not using the full stylesheet. Each component forwards native props and React 19 refs; callers keep labels, values, validation and actions. `InputGroup` is the field container with one focus boundary, not an extra wrapper or form-state provider. Surface classes keep their own geometry.

`Textarea` is the native presentation layer. Desktop's controlled drafts use `ComposerTextarea`, which delegates to it while keeping the composition mirror and final-value writeback. Rich messages use `AgentComposer` with `InlineComposer` (Tiptap): controlled value and change, references, commands, attachments, submit / queue / interrupt and feedback are explicit props. Desktop's `AgentSessionComposer` adapts draft persistence, native file IO and delivery; Core keeps Session and Run authority. These responsibilities stay out of the native input module.

## Verification

`node packages/client-ui/scripts/verify-shared-conversation.mjs --mutation-and-callers` builds the package, type-checks the Desktop Renderer, exercises rendered behavior, runs isolated mutations and checks that real Desktop call sites exist outside definitions, imports and tests; it does not modify the source tree during the experiments. The Renderer configuration covers all Renderer and shared sources, while the original Desktop configuration continues to check Main and preload too. It covers the shared UI integration only; Mobile authentication, native devices, terminal attachment and durable recovery are verified separately. `node packages/client-ui/scripts/verify-browser-context-reading.mjs` exercises the conversation, resource and mailbox readers with isolated production mutations.

`node packages/client-ui/scripts/capture-shared-conversation.mjs` and `capture-browser-context-reading.mjs` record normal and narrow scenes in a private Electron profile using the real theme runtime. Captures are inputs to an [independent visual review](../../docs/guides/agent-visual-e2e-review.md); a successful capture is not an aesthetic approval and does not cover full Desktop, native Browser, input delivery or recovery.
