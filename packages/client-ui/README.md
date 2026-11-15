# @agentmux/client-ui

`@agentmux/client-ui` is the design system shared by AgentMux clients. Its **components** give an individual action, field or reading surface consistent behavior. Its **interaction patterns** describe how a person completes a task that spans several controls, such as finding the work surfaces for an Agent. A host can implement a pattern with its own layout and navigation.

The package is private to the AgentMux workspace. The portable entries below use React and React DOM `^19.2.0`. The package also owns shared Note syntax and document-format helpers. Some domain-specific entries depend on the public types and functions of the workspace’s `@agentmux/core` package. Hosts supply observations and perform actions. The library has no application store, conversation log or Runtime client.

## Start here

| What you want to do | Where to start |
| --- | --- |
| Use a button, text field or compact editor | [Native actions](#native-actions) and [Inputs](#inputs) cover the import, stylesheet and who owns the value. |
| Apply a pattern in another interface | [Find an Agent's work](docs/patterns/agent-work-location.md) gives the question, required inputs, actions and observable results. It includes cases a host can run with its own data. [Read while work continues](docs/patterns/read-while-work-continues.md) covers independent reading positions. [Original interaction receipts](docs/patterns/interaction-receipts.md) describes request, delivery and recovery states. |
| Plan a component or pattern migration | Start with the [target architecture](ROADMAP.md#target-architecture), [control families](ROADMAP.md#controls-to-extract-strengthen-and-adopt), [pattern catalog](ROADMAP.md#patterns-to-promote) and [priorities](ROADMAP.md#priority-and-dependencies). |
| Qualify an archive in an independent React app | [Standalone archive qualification](CONTRIBUTING.md#qualify-a-standalone-archive) covers local install, dependency provenance and the verification command. |
| Add a control, propose a pattern or change a public behavior | The [maintainer guide](CONTRIBUTING.md) covers ownership, evidence and compatibility. |

For example, a host can label a field and submit its current value. The host supplies its theme tokens and owns the draft.

```tsx
import { useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { FormRow } from '@agentmux/client-ui/components/FormRow'
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
      <FormRow layout="stacked" label="Draft" description="You can edit the draft after saving.">
        {field => <TextInput {...field} value={draft} onChange={event => setDraft(event.currentTarget.value)} />}
      </FormRow>
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
| Selection | `components/Tabs`, `components/SegmentedControl`, `components/SelectionIndicator` | `styles/segmented-control.css` and `styles/selection-indicator.css`. [Panel navigation, a single setting and a current reading position](examples/selection.tsx). |
| Overlays | `components/Modal`, `components/DropdownMenu`, `components/HoverDropdownMenu`, `overlay-host` | `styles/overlays.css` for the stack and attachment slots. [Host document, panel layout and focus](examples/overlays.tsx). |
| Readable feedback | `components/ActionFeedback`, `components/Notice`, `components/InlineRenameField` | `styles/notice.css` for notice surfaces. See the [feedback example](examples/feedback.tsx) for the style imports and a rename with a confirmed result. |
| Work location | `patterns/agent-work-location` | `patterns/agent-work-location.css` and `styles/semantic-icons.css`. [Shared summary and distinct routes](examples/locations.tsx). |
| Theme | `theme`, `theme/model`, `icons` | `styles/theme-defaults.css` for initial tokens, `styles/palette.css` for semantic surfaces and `styles/semantic-icons.css` for icon motion. [Light, dark and reduced motion](examples/theme.tsx). |

Mount `mountThemeRuntime(window)` from `theme` once per browser document to install the shared sprite and tokens. The feedback and location components render glyph references into that sprite. Import the shared palette for error and feedback colors. The host sets density and layout, as in [the example host stylesheet](examples/host.css). Keep Overlay focus and Portal targets in the owning document. Use `DropdownMenu` for ordinary actions that open on click, touch or keyboard. Use `HoverDropdownMenu` where pointer entry should disclose the actions without taking focus.

Node consumers can import the theme model to resolve light and dark tokens without a DOM. Interactive entries render in a React host. Import CSS through a CSS-aware browser bundler.

### Markdown source

Use `syntax="markdown"` on `Textarea` or `ComposerTextarea` to color CommonMark and GFM directly in the field. Import `input/styles.css`. Syntax colors keep delimiters, whitespace, form values and clipboard text intact. The field retains native selection, undo, IME and forced colors. Drafts larger than 4,096 UTF-16 units and input that exceeds the parser budget remain fully editable as plain text.

## Workspace modules

Imports in the table use the prefix `@agentmux/client-ui/`. The package manifest records the complete workspace export map.

| Module | Import | What it provides |
| --- | --- | --- |
| Agent work location | `patterns/agent-work-location` | Location summary trigger, confirmed position count and distinct descriptions for exact routes. [Pattern and example](docs/patterns/agent-work-location.md#react-entry). |
| Conversation | `components/ConversationView`, `components/ConversationMessage`, `components/ConversationRecordSequence` | Messages, native-history reading, reasoning and tool traces, permission and question cards, recorded images and files |
| Composer | `components/AgentComposer`, `components/InlineComposer`, `components/ComposerEditFooter` | Rich message editing and the action row for a compact multiline edit |
| Terminal | `terminal/replay`, `terminal/live-output`, `terminal/input`, `terminal/unicode` | xterm replay, live output, input encoding and the Unicode width table |
| Notes | `note/note-document`, `note/note-wikilinks`, `note/note-live-merge`, `components/NoteReader` | The `.note.md` Markdown codec, wiki links, live three-way merge and a read-only Note reader |
| Theme and icons | `theme`, `icons` | Theme catalog and built-in themes, semantic icons and their animations |
| Native controls | `components/Button`, `components/IconButton`, `components/FormRow`, `input`, `components/Modal` | Buttons, form rows, text inputs and dialogs with one shared style owner |
| Menu and avatars | `components/DropdownMenu`, `components/HoverDropdownMenu`, `components/AvatarGroup` | Menu disclosure and keyboard focus in the host document, plus avatar stacking and overflow |
| Brand assets | `brand/` resource paths | App icons, hero art and illustrations ([brand sources](brand/README.md)) |

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

### Markdown preview

The [shared Markdown renderer](src/lib/markdown-render.ts) limits math input to 4 KiB, code input to 64 KiB, and generated output to 256 KiB of HTML and 3,000 elements. The input check runs before starting a terminable worker. KaTeX uses `trust: false` and `strict: 'error'`. The worker checks generated output against the same budget before returning it. When rendering exceeds a limit, the preview keeps the original source visible and explains why.

## Terminal

The optional xterm entries cover replay, output and input.

- **Replay** writes retained Run bytes to xterm in 128 KiB batches and yields between batches, so a large scrollback never blocks input, navigation or closing the view. A batch boundary is only a scheduling boundary; xterm continues an escape sequence across writes.
- **Live output** coalesces small Runtime events into writes of at most 64 KiB. The unparsed backlog is capped at 2 MiB: on overflow the oldest queued events are dropped, not Runtime history, and the drain recovers the retained bytes from its last parsed cursor before consuming the newer tail. Only a Runtime Gap or a failed recovery produces an omission notice.
- **Unicode width** is set to the Unicode 11 table before any bytes are parsed, because changing the table later cannot repair cells that were already laid out.
- **Input** encodes binary terminal reports and subscribes to xterm input events for the caller's write path.

## Notes

`note/note-document` reads and writes `.note.md` Markdown with stable block IDs. `note/note-wikilinks` builds wiki-link queries and binds resolved targets. `note/note-draft-includes` matches a host-supplied draft include to its original occurrence. Rich-block validation and three-way merging run in workers. `components/NoteReader` renders bytes supplied by the host.

## Icons and themes

Semantic icons come from `@agentmux/client-ui/icons` and the shared styles. Instances accept `size`, `color`, `strokeWidth`, `strokeLinecap`, `strokeLinejoin` and `animation`; explicit props override inline style, then the theme pen and the inherited color. Animation defaults to `none` for every meaning, and current activity must come from the caller's own state:

```tsx
<SemanticIcon name="status.working" /> // Static heading or recorded status.
<SemanticIcon name="status.working" color="var(--success)" size={12}
  animation={currentlyProducing ? 'work' : 'none'} />
```

The animation presets are `none`, `work`, `stream`, `execute`, `wait`, `orbit`, `feedback`, `selection` and `spin`. A preset affects only that instance, respects reduced motion and does not change saved themes or imply Runtime state. `createSemanticIconElement` takes the same options: a static call returns an SVG, and an animated call can return an HTML element that contains the SVG, so keep the returned node rather than assuming it is an SVG.

The shared catalog owns semantic IDs and glyph defaults. Hosts can use the same catalog for their icon pickers and theme settings.

### Theme runtime

Desktop's preload [projects the saved theme snapshot](../../apps/desktop/src/preload/theme-bootstrap.ts) onto the document before the first paint. The shared [theme runtime](src/theme/runtime.ts) then owns that window's media and selection subscriptions. It projects the resolved colors, typography and elevation as [CSS variables](src/theme/css-variables.ts) on `documentElement` and emits `agentmux-theme-change`. Components consume those variables and subscribe to that projection when they need to observe changes.

## Styles and dialogs

Import `@agentmux/client-ui/styles.css` alongside the host’s theme tokens and fonts. Individual styles are also exported for hosts that manage their own cascade order.

Import dialogs from `@agentmux/client-ui/components/Modal`. Hosts that load styles individually also include `@agentmux/client-ui/styles/overlays.css`. The shared module owns modal presentation, attachment slots and focus lifetime on top of Radix. Use `useModalOverlayContainer` for attached custom portals. A `null` target means the slot is still being prepared. Keep the attachment there once ready. Business requests and drafts stay with the caller.

For a tree rendered into a separate document or a dedicated overlay container, import `ClientUiOverlayProvider` from `@agentmux/client-ui/overlay-host`. Pass `host={{ ownerDocument, overlayContainer: () => overlayRoot }}` using the document and container that host the original trigger. Both dialogs and menus use that scope. Pass a container directly to a Portal when it needs its own destination, such as an attachment in an open dialog.

## Native actions

Import `Button` and `IconButton` from `@agentmux/client-ui/components/Button` and `@agentmux/client-ui/components/IconButton`. Both render a native button, default `type` to `button`, and forward native props and React 19 refs; use an explicit `type="submit"` for form submission. Callers keep their handlers, `disabled`, `aria-busy`, requests and drafts; busy presentation never disables an otherwise available action or retries an operation.

`Button` accepts `variant="secondary" | "primary" | "danger"` (default `secondary`). `IconButton` requires `aria-label`, uses it as the default native title, and accepts `intent="neutral" | "danger"`; an explicit title is kept. The `.small-button`, `.primary-button`, `.danger-button` and `.icon-button` classes have one owner in `styles/buttons.css`; include `@agentmux/client-ui/styles/buttons.css` when importing individual styles. Hosts keep surface-specific geometry and supply the theme tokens.

Use `ActionFeedback` next to an action whose result can change in place. Set `bounded` to reserve two text lines and allow longer messages to scroll. Pass `role="status"` for ordinary progress, `role="alert"` for errors that need immediate announcement, and `tabIndex={0}` for a scrollable error the reader needs to reach by keyboard. The caller supplies the message and owns the operation.

Use `Notice` for an inline message with an optional heading and actions. `NoticeSurface` and `NoticeIcon` let an inbox row or recorded failure use the same presentation with its existing structure. Set `messageRole` to announce the message while keeping the action labels out of that announcement. Import `styles/notice.css` and `styles/semantic-icons.css` with individual exports. The caller owns the message's lifetime, actions and status.

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

Use `components/SelectionIndicator` to give native links or buttons one moving background for their current position. Import `styles/selection-indicator.css`. Place the indicator beside the direct `aria-current` controls in a positioned, isolated container. The caller sets the current item and owns focus, navigation and the static selected style. Use `:has(> .selection-indicator:not([hidden]))` to let the indicator take over that background when it is positioned. The indicator follows wrapping and size changes, begins at the current item and moves directly to the new position with reduced motion. The host can style the surface with `--selection-indicator-background`, `--selection-indicator-border` and `--selection-indicator-shadow`. The component uses that document's `ResizeObserver` and `MutationObserver`.

Use `components/HoverDropdownMenu` for commands that run when a menu item is activated. Use `components/SelectionField` for an existing value selected from a list of options. Supply the value, labels and disabled facts. Import `styles/selection-field.css` and the shared input styles when the field needs a query. The current value stays separate from keyboard focus.

Use `components/SearchChoiceDialog` when someone needs to read or type a query before explicitly choosing an action. The dialog takes a named trigger, an editable query and a render function for the currently visible results. Render result buttons with `data-choice`, and call the supplied `choose` callback for explicit activation. The host owns filtering, pending or failed reads and the action. Import `styles/search-choice.css`. The existing overlay host provides the original document and Portal container.

## Tabs and segmented controls

Use `Tabs` for navigating between panels. Supply the panel ID and a stable trigger ID for each option, and connect each panel with `aria-labelledby`. The caller chooses how to keep panels mounted and styles the triggers with `[aria-selected]`.

Use `SegmentedControl` to edit a single value across a few visible choices. Its stylesheet provides equal-width options, a shared selection indicator and reduced-motion support. The caller owns the selected value and any save or navigation action.

## Inputs

Message Tool uses the [native inputs' Markdown syntax colors](#markdown-source) alongside inline attachments and references.

### Compact editors

Use `ComposerTextarea variant="compact"` with `ComposerEditFooter` for a short multiline edit inside an existing surface. The field handles IME, grows with content, and scrolls when it reaches its height limit. For drafts that need more editing room, the caller can set `expanded` on the compact field and link its size toggle to the field ID with `aria-controls`. Both sizes use the same native textarea and selection. Put existing utilities or metadata in `leading` and the action buttons in reading order. Use the shared primary `Button` for the action at the right edge. Hosts importing styles individually need `input/styles.css`, `styles/buttons.css` and `styles/composer.css`.

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

Spread the callback attributes from `FormRow` onto one native control. The label supplies the accessible name, and `description` and `error` supply its descriptions when present. Set `invalid` when the caller confirms the field's value is invalid. Use `layout="stacked"` with the shared input stylesheet for a text field or short editor. The default inline layout fits a checkbox and its label. Keep whole-save feedback with the action group, and let the caller own the input value, validation and persistence.

Use `SearchInput` from `@agentmux/client-ui/input` for a controlled query. Give the field and the clear button their own accessible labels. Clearing emits an empty value and returns focus to the same native input. The caller applies the query to its records and owns any requests or results. [Field example](examples/fields.tsx).

Use `NativeSelect` from the same entry when the host wants the platform's option interaction and form value. Pass the normal select props and native option children. Use `SelectionField` for a searchable popup, rich option labels or choices that need to explain a missing value.

Use `Switch` from `@agentmux/client-ui/input` for an on/off setting. It keeps the native checkbox ref, form value, keyboard activation and disabled state. Use `FormRow` for a visible label and optional help. The shared input stylesheet draws the track and thumb, respects writing direction and reduced motion, and supports forced colors.

`src/input/` is the shared native field module: import `TextInput`, `Textarea` and `InputGroup` from `@agentmux/client-ui/input`, plus `@agentmux/client-ui/input/styles.css` when not using the full stylesheet. Each component forwards native props and React 19 refs; callers keep labels, values, validation and actions. `InputGroup` is the field container with one focus boundary, not an extra wrapper or form-state provider. Surface classes keep their own geometry.

`Textarea` is the native field. `ComposerTextarea` delegates to it while preserving composition and final-value writeback in a controlled draft. Rich messages can use `AgentComposer` with `InlineComposer` (Tiptap). The value and change, references, commands, attachments, actions and feedback are explicit props. The host owns draft persistence, file IO and delivery.

## Verification

From a source checkout of this package, run `pnpm run typecheck` and `pnpm test`. Use the documented public entries in a host fixture. Exercise the real action, focus and result alongside the rendered state. Consumer applications maintain their own integration checks.

The [maintainer guide](CONTRIBUTING.md) covers interaction, visual review, compatibility and standalone verification.
