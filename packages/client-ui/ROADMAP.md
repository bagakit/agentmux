# Roadmap

The goal is an independently usable design system for software where people work with Agents. A team should be able to install a control in its own app. A team using a different UI toolkit should be able to read a pattern, implement it and pass the same behavioral cases.

The [README](README.md) describes the current package. The milestones below describe the intended order of work and the evidence needed to call each outcome ready. The package is currently private and has a workspace dependency on AgentMux Core.

## 1. Make everyday controls dependable

Start with a keyboard-operated action menu, selected icon buttons, and save feedback in a compact editor. These small controls test three different obligations.

| Interaction | What a person should experience | How to check it |
| --- | --- | --- |
| Choose a mode | A keyboard user can open the menu, move between modes, select once and return to the trigger on cancel. A pointer user can inspect the menu while preserving the editor's caret. | Check the actual focused element and count host calls. Moving focus issues zero mode changes. A current-mode mark requires an observation of that mode. Searchable command fields also exercise text entry and IME. |
| Toggle an icon action | Its selected state is recognizable at rest, with the pointer away. Keyboard focus is visible on either state. | Compare selected, unselected and focused states in supported themes and reduced motion. Verify the accessible pressed state and a visible cue beyond color. |
| Save a draft | The adjacent action stays under the pointer while feedback changes. Failure leaves the original draft available. | With an unchanged set of actions at a fixed width, sample their hit areas throughout the update. Exercise long translations, narrow widths, rapid re-entry and reduced motion. Verify exactly one request for one activation. |

A maintainer delivers each control through its normal product entry with a small runnable state example. The host continues to own the draft, the available actions and any save or mode-setting result.

## 2. Prove one Agent pattern across three hosts

Start [Find an Agent's work](docs/patterns/agent-work-location.md) alongside the first control. It asks who is working, where execution and project resources live, and which open view a person can enter. Desktop may use a details popover, Mobile a sheet, and an outside app its own navigation list.

Use the same cases on all three. Cover a confirmed empty list, an incomplete observation, multiple views with identical names, two routes to one view, a target that changes and a late result for an earlier Agent. The host supplies identities, observations and navigation. It revalidates the chosen location. The library can share the summary and chooser after these implementations reveal the necessary props. Completion requires reaching the chosen view in each host while preserving the original work when the choice fails or is cancelled.

## 3. Extend the families and the pattern catalog

| Family | Next consumer and observable outcome |
| --- | --- |
| Inputs and editing | Queued edits and annotations retain composition, undo, selection, focus and the caller's draft. Labels, hints and errors remain available at narrow widths and with a screen reader. |
| Reading and scrolling | In a conversation and an activity stream, new output follows a reader at the end. While someone reads history, appending content or prepending an older page keeps the passage in view. Verify the terminal separately in a live session. |
| Overlays and feedback | Actions, selectable values and searchable commands have the keyboard behavior their roles promise. Closing an overlay gives focus to the right element in the originating document. |
| Agent actions and receipts | The UI distinguishes a request, a saved response, an unconfirmed result and confirmed completion. A delayed receipt updates only its original operation. |

Grow from the existing input, component, style and theme entries. Group files when a change has the same owner and callers. Measure both the runtime imports and the declaration dependencies a consumer sees. A basic field should load without a terminal, rich editor or Agent runtime. Give overlays a narrow interface for document, portal and focus services so an independent host can type-check a menu without domain-specific types. Document a platform variation alongside its common behavior.

## 4. Qualify independent distribution

Build a release candidate and install its packed artifact into a clean React host outside the workspace. Verify the documented JS, types, styles and theme requirements. Drive the location pattern with that host's own data. Publish the supported environments, examples, behavior changes and migration instructions. Resolve licensing and asset provenance before public distribution. The [maintainer guide](CONTRIBUTING.md) owns the verification and release procedure.

Revisit a milestone when its public outcome or adoption evidence changes. Per-change tasks, dates, measurements and review logs belong to the implementing project. An independent implementation passing the same cases is evidence of portability. External adoption is a separate result to report when it happens.
