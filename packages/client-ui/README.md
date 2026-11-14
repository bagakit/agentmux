# @agentmux/client-ui

`@agentmux/client-ui` is the design system shared by AgentMux clients. Its **components** give an individual action, field or reading surface consistent behavior. Its **interaction patterns** describe how a person completes a task that spans several controls, such as finding the work surfaces for an Agent. A host can implement a pattern with its own layout and navigation.

The package is private to the AgentMux workspace. The portable entries below use React and React DOM `^19.2.0`. The package also owns shared Note syntax and document-format helpers. Some domain-specific entries depend on the public types and functions of the workspace’s `@agentmux/core` package. Hosts supply observations and perform actions. The library has no application store, conversation log or Runtime client.

## Start here

| What you want to do | Where to start |
| --- | --- |
| Use a button, text field or compact editor | [Native actions](#native-actions) and [Inputs](#inputs) cover the import, stylesheet and who owns the value. |
| Apply a pattern in another interface | [Find an Agent's work](docs/patterns/agent-work-location.md) gives the question, required inputs, actions and observable results. It includes cases a host can run with its own data. [Original interaction receipts](docs/patterns/interaction-receipts.md) describes request, delivery and recovery states. |
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

## Portable entries

Use these exact import paths under `@agentmux/client-ui/`. Each example imports its own styles. Render its default export in a React host, then try it with keyboard focus, at narrow width and with reduced motion.

| Purpose | Imports | Local styles and example |
| --- | --- | --- |
| Actions | `components/Button`, `components/IconButton` | `styles/buttons.css`. [Toggle, disabled action and pending save](examples/actions.tsx). |
| Fields | `input`, `components/FormRow` | `input/styles.css`. [Label, help, error and multiline draft](examples/fields.tsx). |
| Overlays | `components/Modal`, `components/HoverDropdownMenu`, `overlay-host` | `styles/overlays.css` for the stack and attachment slots. [Host document, panel layout and focus](examples/overlays.tsx). |
| Readable feedback | `components/InlineRenameField` | `input/styles.css`, `styles/semantic-icons.css` and `styles/inline-rename-field.css`. [Rename, pending receipt and retryable error](examples/feedback.tsx). |
| Work location | `patterns/agent-work-location` | `patterns/agent-work-location.css` and `styles/semantic-icons.css`. [Shared summary and distinct routes](examples/locations.tsx). |
| Theme | `theme`, `theme/model`, `icons` | `styles/theme-defaults.css` for initial tokens, `styles/palette.css` for semantic surfaces and `styles/semantic-icons.css` for icon motion. [Light, dark and reduced motion](examples/theme.tsx). |

Mount `mountThemeRuntime(window)` from `theme` once per browser document to install the shared sprite and tokens. The feedback and location components render glyph references into that sprite. Import the shared palette for error and feedback colors. The host sets density and layout, as in [the example host stylesheet](examples/host.css). Keep Overlay focus and Portal targets in the owning document.

Node consumers can import the theme model to resolve light and dark tokens without a DOM. Interactive entries render in a React host. Import CSS through a CSS-aware browser bundler.

## Workspace modules

Imports in the table use the prefix `@agentmux/client-ui/` unless written in full.

| Module | Import | What it provides |
| --- | --- | --- |
| Agent work location | `patterns/agent-work-location` | Location summary trigger, confirmed position count and distinct descriptions for exact routes. [Pattern and example](docs/patterns/agent-work-location.md#react-entry). |
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

Agent views that need platform services import `ClientUiProvider` and `ClientUiPlatform` from `@agentmux/client-ui/platform`. The adapter supplies clipboard error reporting, an overlay target, editor focus registration and identity rendering. File opening, HTTP navigation, pasted-image IO, send, queue, interrupt and permission responses are typed callbacks. A host can supply a rendered avatar through `DescribeSpeaker`.

## Node consumers

The package builds ESM JavaScript for Node consumers, and its `browser` export condition gives browser bundlers the TypeScript source. Each Node entry has a specific purpose.

| Entry | Node responsibility and dependencies |
| --- | --- |
| `theme/model` | Read and validate the theme catalog, its serialized format, icon metadata and terminal palettes in Node. Browser mounting and theme observation of a document live in `theme`. |
| `pasted-images`, `terminal-path-link` | Pure value helpers; their import graphs contain no React, Tiptap or DOM runtime. |
| `agent-avatar-svg`, `mote-avatar-svg` and their static artwork dependencies | Shared static avatar rendering, including React and `react-dom/server` where needed. The Host supplies saved appearance and owned raster resources; rendering does not mount an editor or browser DOM. |
| `note/note-document`, `note/note-content-schema` and `note/note-provenance` | Read and serialize the shared Note format and validate it with the same Tiptap schema as the editor. The schema and codecs work without an editor DOM. Editor transactions use `note/note-editor-extensions` for reference ID authoring and history boundaries. The host owns file IO, revision checks, compare-and-swap and write receipts. |

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

For a tree rendered into a separate document or a dedicated overlay container, import `ClientUiOverlayProvider` from `@agentmux/client-ui/overlay-host`. Pass `host={{ ownerDocument, overlayContainer: () => overlayRoot }}` using the document and container that host the original trigger. Both dialogs and menus use that scope. Pass a container directly to a Portal when it needs its own destination, such as an attachment in an open dialog.

## Native actions

Import `Button` and `IconButton` from `@agentmux/client-ui/components/Button` and `@agentmux/client-ui/components/IconButton`. Both render a native button, default `type` to `button`, and forward native props and React 19 refs; use an explicit `type="submit"` for form submission. Callers keep their handlers, `disabled`, `aria-busy`, requests and drafts; busy presentation never disables an otherwise available action or retries an operation.

`Button` accepts `variant="secondary" | "primary" | "danger"` (default `secondary`). `IconButton` requires `aria-label`, uses it as the default native title, and accepts `intent="neutral" | "danger"`; an explicit title is kept. The `.small-button`, `.primary-button`, `.danger-button` and `.icon-button` classes have one owner in `styles/buttons.css`; include `@agentmux/client-ui/styles/buttons.css` when importing individual styles. Hosts keep surface-specific geometry and supply the theme tokens.

### Action menu

Use the menu parts when each row invokes an action. The trigger opens the menu with the keyboard or pointer, and the menu moves focus among available rows. Give each row a clear action label and supply the panel and focus styles from the host.

```tsx
import * as Menu from '@agentmux/client-ui/components/HoverDropdownMenu'

export function ItemActions({ canRename, onRename, onDuplicate }: {
  canRename: boolean
  onRename(): void
  onDuplicate(): void
}) {
  return (
    <Menu.Root>
      <Menu.Trigger>Item actions</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content sideOffset={6}>
          <Menu.Item disabled={!canRename} onSelect={onRename}>Rename item</Menu.Item>
          <Menu.Item onSelect={onDuplicate}>Duplicate item</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
```

## Choose a control for the task

Use `components/HoverDropdownMenu` for commands that run when a menu item is activated. Use `components/SelectionField` for an existing value selected from a list of options. Supply the value, labels and disabled facts. Import `styles/selection-field.css` and the shared input styles when the field needs a query. The current value stays separate from keyboard focus.

Use `components/SearchChoiceDialog` when someone needs to read or type a query before explicitly choosing an action. The dialog takes a named trigger, an editable query and a render function for the currently visible results. Render result buttons with `data-choice`, and call the supplied `choose` callback for explicit activation. The host owns filtering, pending or failed reads and the action. Import `styles/search-choice.css`. The existing overlay host provides the original document and Portal container.

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
