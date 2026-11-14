# @agentmux/client-ui

`@agentmux/client-ui` is the design system shared by AgentMux clients. Its **components** give an individual action, field or reading surface consistent behavior. Its **interaction patterns** describe how a person completes a task that spans several controls, such as finding the work surfaces for an Agent. A host can implement a pattern with its own layout and navigation.

The package is private to the AgentMux workspace. The React entries use React and React DOM `^19.2.0`. The package also owns shared Note syntax and document-format helpers. Some domain-specific entries depend on the public types and functions of the workspace’s `@agentmux/core` package. Hosts supply observations and perform actions. The library has no application store, conversation log or Runtime client.

## Start here

| What you want to do | Where to start |
| --- | --- |
| Use a button, text field or compact editor | [Native actions](#native-actions) and [Inputs](#inputs) cover the import, stylesheet and who owns the value. |
| Apply a pattern in another interface | [Find an Agent's work](docs/patterns/agent-work-location.md) gives the question, required inputs, actions and observable results. It includes cases a host can run with its own data. |
| Plan a component or pattern migration | Start with the [target architecture](ROADMAP.md#target-architecture), [control families](ROADMAP.md#controls-to-extract-strengthen-and-adopt), [pattern catalog](ROADMAP.md#patterns-to-promote) and [priorities](ROADMAP.md#priority-and-dependencies). |
| Add a control, propose a pattern or change a public behavior | The [maintainer guide](CONTRIBUTING.md) covers ownership, evidence and compatibility. |

For example, a host can label a field and submit its current value. The host supplies its theme tokens and owns the draft.

```tsx
import { useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { TextInput } from '@agentmux/client-ui/input'
import '@agentmux/client-ui/input/styles.css'
import '@agentmux/client-ui/styles/buttons.css'

export function DraftForm({ onSave }: { onSave: (text: string) => void }) {
  const [draft, setDraft] = useState('')
  return (
    <form onSubmit={event => {
      event.preventDefault()
      onSave(draft)
    }}>
      <label>Draft <TextInput value={draft} onChange={event => setDraft(event.currentTarget.value)} /></label>
      <Button type="submit">Save draft</Button>
    </form>
  )
}
```

## Modules

Imports in the table use the prefix `@agentmux/client-ui/` unless written in full.

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

Use the named entry for the control or capability you need. The `components/` entries render UI, and `input` owns native field primitives. Import component CSS or the shared stylesheet. Hosts supply their theme, overlay container and actions.

## Platform adapter

Views that need platform services use `ClientUiProvider` with an explicit `ClientUiPlatform`. The adapter supplies clipboard error reporting, an overlay target, editor focus registration and identity rendering. File opening, HTTP navigation, pasted-image IO, send, queue, interrupt and permission responses are typed callbacks. A host can supply a rendered avatar through `DescribeSpeaker`.

## Node consumers

The package builds ESM JavaScript for Node consumers, and its `browser` export condition gives browser bundlers the TypeScript source. Node support belongs to the selected entry and its purpose:

| Entry | Node responsibility and dependencies |
| --- | --- |
| `pasted-images`, `terminal-path-link` | Pure value helpers; their import graphs contain no React, Tiptap or DOM runtime. |
| `agent-avatar-svg`, `mote-avatar-svg` and their static artwork dependencies | Shared static avatar rendering, including React and `react-dom/server` where needed. The Host supplies saved appearance and owned raster resources; rendering does not mount an editor or browser DOM. |
| `note/*` document codecs, merge and provenance helpers, including `note-content-schema` | Read and serialize the shared Note format and validate it with the same Tiptap schema as the editor. These work without an editor DOM. The host owns file IO, revision checks, compare-and-swap and write receipts. |

Node consumers import a supported subpath directly. Interactive components require a rendering host.

## Conversation reading

`ConversationRecordSequence` shows native turn and response metrics from records Core has already read. It keeps source order and the mounted reading nodes, shows each loaded turn's latest cumulative sample once, and reuses the `NativeProcessObservation` disclosure; response-only reports keep their own record identity. Import the shared styles (or `styles/conversation-metrics.css` with the host's individual style imports); no extra reader, timer or execution channel is needed.

`ConversationMessage` accepts `inputContext` and `inputContextSource` and shows a compact browser-observation disclosure. Supply parsed records with their original authorship and provenance. Each selection keeps its browser, navigation and step association. Reading a record performs no navigation, input or permission action.

Copy uses the original parts or the caller’s `copyText`. A host with a frozen source record can pass that original text.

The optional `renderObjectLink` adapter receives an object URI and its parsed target. Markdown and conversation prose share inline rendering. Code, read-only previews and document mode keep plain text. The host resolves names, appearance, details and navigation. Stored text and Copy retain the original source.

## Terminal

The optional xterm entries cover replay, output and input.

- **Replay** writes retained Run bytes to xterm in 128 KiB batches and yields between batches, so a large scrollback never blocks input, navigation or closing the view. A batch boundary is only a scheduling boundary; xterm continues an escape sequence across writes.
- **Live output** coalesces small Runtime events into writes of at most 64 KiB. The unparsed backlog is capped at 2 MiB: on overflow the oldest queued events are dropped, not Runtime history, and the drain recovers the retained bytes from its last parsed cursor before consuming the newer tail. Only a Runtime Gap or a failed recovery produces an omission notice.
- **Unicode width** is set to the Unicode 11 table before any bytes are parsed, because changing the table later cannot repair cells that were already laid out.
- **Input** encodes binary terminal reports and subscribes to xterm input events for the caller's write path.

## Notes

The `note/*` entries provide the `.note.md` Markdown codec with stable block IDs and wiki links, rich-block validation, draft includes and live three-way merge. Rich validation and merging run in a worker, off the input thread. `NoteReader` renders bytes supplied by the host.

## Icons and themes

Semantic icons come from `@agentmux/client-ui/icons` and the shared styles. Instances accept `size`, `color`, `strokeWidth`, `strokeLinecap`, `strokeLinejoin` and `animation`; explicit props override inline style, then the theme pen and the inherited color. Animation defaults to `none` for every meaning, and current activity must come from the caller's own state:

```tsx
<SemanticIcon name="status.working" /> // Static heading or recorded status.
<SemanticIcon name="status.working" color="var(--success)" size={12}
  animation={currentlyProducing ? 'work' : 'none'} />
```

The animation presets are `none`, `work`, `stream`, `execute`, `wait`, `orbit`, `feedback`, `selection` and `spin`. A preset affects only that instance, respects reduced motion and does not change saved themes or imply Runtime state. `createSemanticIconElement` takes the same options: a static call returns an SVG, and an animated call can return an HTML element that contains the SVG, so keep the returned node rather than assuming it is an SVG.

The shared catalog owns semantic IDs and glyph defaults. Hosts can use the same catalog for their icon pickers and theme settings.

## Styles and dialogs

Import `@agentmux/client-ui/styles.css` alongside the host’s theme tokens and fonts. Individual styles are also exported for hosts that manage their own cascade order.

Import dialogs from `@agentmux/client-ui/components/Modal`. Hosts that load styles individually also include `@agentmux/client-ui/styles/overlays.css`. The shared module owns modal presentation, attachment slots and focus lifetime on top of Radix. Use `useModalOverlayContainer` for attached custom portals. A `null` target means the slot is still being prepared. Keep the attachment there once ready. Business requests and drafts stay with the caller.

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

Two hosts can use this same field and footer with different drafts, error handling and save actions.

### Labels and single fields

`FormRow` from `@agentmux/client-ui/components/FormRow` renders one native label with a separate title and description. Its child callback supplies `id`, `aria-labelledby` and `aria-describedby`; spread them onto the native control. The whole row is the label, and only the title supplies the accessible name. `controlId` keeps an explicit field ID when needed. The caller keeps the input's ref, name, value, checked state, handlers and disabled state. FormRow has no field state or validation model, clones no control and adds no styles; pass the surface's row class. Whole-save errors stay with the caller's save feedback.

`src/input/` is the shared native field module: import `TextInput`, `Textarea` and `InputGroup` from `@agentmux/client-ui/input`, plus `@agentmux/client-ui/input/styles.css` when not using the full stylesheet. Each component forwards native props and React 19 refs; callers keep labels, values, validation and actions. `InputGroup` is the field container with one focus boundary, not an extra wrapper or form-state provider. Surface classes keep their own geometry.

`Textarea` is the native field. `ComposerTextarea` delegates to it while preserving composition and final-value writeback in a controlled draft. Rich messages can use `AgentComposer` with `InlineComposer` (Tiptap). The value and change, references, commands, attachments, actions and feedback are explicit props. The host owns draft persistence, file IO and delivery.

## Verification

From a source checkout of this package, run `pnpm run typecheck` and `pnpm test`. Use the documented public entries in a host fixture. Exercise the real action, focus and result alongside the rendered state. Consumer applications maintain their own integration checks.

The [maintainer guide](CONTRIBUTING.md) covers interaction, visual review, compatibility and standalone verification.
