# Git reading surfaces

Git UI stays in this client feature. Repository operations and immutable snapshots belong to the framework-independent `packages/git`; public targeting and codecs belong to Core. Neither depends on these components.

- `history/`: one component-owned read window, virtual rows/graph and observation-only hover. The active workspace provider shares that window between sidebar and repository reading. An exact workspace handoff transfers completed facts and scroll position; pending requests retain their original owner.
- `commit/`: immutable commit reads and shared message, parent and file presentation. It does not navigate or fetch History.
- `diff/`: read-only Monaco presentation, also used by explicit comparison tabs. Store owns descriptors, request invalidation and resource release.
- `GitWorkbenchPane`: composes the selected reading mode and inline diff. Durable Region descriptors, navigation and persistence stay in the existing workbench store.

Selecting a sidebar commit opens fixed details. Opening repository History is explicit. Repository selections and file changes stay in that Region; a separate comparison tab requires its explicit action. History range, selected commit and file are durable descriptors; loaded pages and Monaco models are transient reading resources.
