# Git reading surfaces

Git UI stays in this client feature. Repository operations and immutable snapshots belong to the framework-independent `packages/git`; public targeting and codecs belong to Core. Neither depends on these components.

- `history/`: one Space Git read window, virtual rows/graph and observation-only hover. Only the visible sidebar reads History. Repository review projects its durable range and selection without a second list or reading window.
- `commit/`: immutable commit reads and shared message, parent and file presentation. It does not navigate or fetch History.
- `diff/`: read-only Monaco presentation, also used by explicit comparison tabs. Store owns descriptors, request invalidation and resource release.
- `GitWorkbenchPane`: composes the selected reading mode and inline diff. Durable Region descriptors, navigation and persistence stay in the existing workbench store.

Selecting sidebar commits reuses the repository review Region. Explicit fixed-commit opens retain their separate identity. Repository selections and file changes stay in that Region; a separate comparison tab requires its explicit action. History range, selected commit and file are durable descriptors; loaded pages and Monaco models are transient reading resources.
