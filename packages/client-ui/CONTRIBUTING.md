# Maintaining the component and pattern library

Someone adopting a control should be able to find its import, render its important states, and predict what a click or key will do. Someone adopting a pattern should be able to implement the same task in another host and check the result against the same cases. The [package README](README.md) is the entry point for both readers.

Maintain each decision where readers will look for it. Supported entries and usage belong in the README, long-term direction in the [roadmap](ROADMAP.md), and a pattern's observable contract in its own page. Update the affected document in the same change as the behavior. The host project tracks implementation tasks and review evidence.

Write every document and example with fictional identifiers, event order and portable imports. Omit real dates, clock times, machine paths and private evidence locations. Link to material distributed with the package. A host documents its own product rules, source links and integration commands on its side of the boundary.

## Decide what belongs here

| Kind of change | What the library owns | What the caller supplies |
| --- | --- | --- |
| Basic control, such as a field or toggle | Native semantics, accessible name wiring, focus behavior, state styling and relevant component CSS | Value, label, validation result, available actions and theme |
| Interaction pattern, such as finding an Agent's work | The user's question, necessary facts, transitions, expected outcomes and reusable presentation | Original identities and observations, permitted actions, execution and confirmation |
| Host integration | The small interface a control or pattern needs from its caller | Navigation, document and portal selection, persistence, clipboard, remote reads and the host's own layout |

Start from a real consumer. Locate its current owner and look for another surface solving the same task. A single native control can stay a single file. Keep field primitives with the existing `input/` entry. Group components, styles and examples around a shared behavior when consumers need to find them together. A desktop popover and a phone sheet can implement the same pattern. A menu for executing commands and a searchable text field need different keyboard behavior even when their panels look alike.

Keep the dependency direction visible in both code and types. The application imports the library and adapts its records into values and callbacks. A basic control or a portable pattern must be exercisable with a neutral host and plain input. Check its transitive imports for application stores, app routes, business services and product-only types. Put any such wiring in the consuming adapter. Domain-specific entries declare their own dependencies.

## Describe the change

- **For a control**, document its import and styles, a minimal example, meaningful states and the value or event the host receives. Show states that can coexist, such as selected with visible keyboard focus, or a failed save with an editable draft.
- **For a pattern**, name the task in the user's words. Describe what the host knows, what remains unknown, who acts, how a result gets confirmed, and what happens if the subject changes. Give concrete input, action and expected outcome cases that another team can run. Keep portable examples in the package. Each host links back from its own integration notes and records the cases it verified. [Find an Agent's work](docs/patterns/agent-work-location.md) is the first example.
- **For a public entry**, document its React, CSS, DOM, Node and host requirements as applicable. Prefer a named entry a reader can try directly. Keep portable control types usable without an application's stores. Keep Note codecs, terminal machinery and domain adapters reachable by the consumers that need them.

## Verify the experience

| When changing | Exercise | Inspect the result |
| --- | --- | --- |
| Input, focus or selection | Use the real consumer with its keyboard path. Exercise pointer, touch or IME composition where applicable. Open, cancel, reopen and change the subject mid-interaction. | Inspect the active element, selection, draft, accessible name and number of actions received by the caller. |
| A visible state or transition | Show the control at rest and in its meaningful combinations. Try narrow width, long translated labels, keyboard focus, supported themes and reduced motion. Interrupt and reverse a transition. | Check hit targets, contrast, readability and adjacent control positions. On a visual change have an independent reviewer view the actual images, then recapture revisions. |
| Stream or scrolling | Append and prepend content while following and while reading older content. Switch views and return. Add unrelated retained views with the active workload fixed. | Inspect the reader's anchor and input responsiveness in the affected surface. Record frame or latency measurements with the workload and device. |
| Business feedback or navigation | Drive the normal host entry with confirmed, missing, stale and failed observations. Deliberately break the identity match or focus return in an isolated test. | Verify the intended action happens once on the exact target, unrelated work stays usable, and the check catches the injected defect. |

Keep a runnable example close to each promoted public entry. Record which host, input method and state the evidence covers. Run the package checks from a source checkout of the package. Downstream maintainers exercise their normal product path. For documentation changes verify that every public link resolves inside the distributed artifact, sample imports work and examples use synthetic data.

```sh
pnpm run typecheck
pnpm test
```

## Prepare a standalone release

The current distribution is a private workspace package. For a standalone candidate, build and pack it, then install the resulting archive in a clean app outside the monorepo. Try the documented imports, types and CSS with the declared peer versions. Render a basic field and drive a pattern through a neutral host adapter. Measure the entry's actual import graph and bundle cost. The basic field should work without an AgentMux runtime, terminal or rich editor.

Review changes to public types, CSS tokens, roles, keyboard behavior, meanings of states and host events as compatibility changes. For an incompatible change, document the affected entry, a consumer migration and the intended version before release. Keep a list of supported hosts and known gaps alongside release evidence. Before distributing publicly, record the license decision and the redistribution terms for shipped artwork, fonts and third-party marks.
