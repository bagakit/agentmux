# Unified Browser children owner proof

This fixture consumes the original BrowserViewManager and Chromium native creation request. Every child retains its original WebContents, Session, opener policy, form body, referrer, named-window reuse and native close lifecycle, while joining the ordinary Browser target and program owner.

Run from the repository root:

```sh
node apps/desktop/scripts/verify-unified-browser-children.mjs
```

The driver builds the current source into private baseline, mutation and restored variants. It exercises guestful `window.open`, synchronous blank documents, JavaScript-disabled requests, guestless modifier/middle input, sandboxed frames, POST, nested native continuation, beforeunload Stay/Leave, private sessions and native account-request cancellation. A target-count assertion, exact original WebContents equality, observed original navigation and exact server request counts protect against empty collections, URL replays and duplicate creation.

Actual public RPC and freshly compiled CLI discovery/run consume the original Store branches, original preload method mappings over real Electron IPC, original Main handler registrations, and the same native manager. The public source relationship and effects on the exact child are checked independently of the opener. The mutations remove original continuation, child target membership, the public source projection or the CLI page effect; each must reach its owning assertion, followed by a restored pass.

The receipt records consumed source/bundle hashes, original callback identities, API/IPC/CLI receipts, process exit and private cleanup. Each process has a separate private HOME and no user Runtime connection or clipboard writer. `--baseline-only` and `--prepare-only` are development scopes; `--prepared <receipt>` reuses byte-verified unchanged CLI inputs while recompiling a bounded fixture change.

The canonical command then runs the actual Renderer/native-shell restart and capture driver, or validates `--ui-receipt <receipt>` from the same candidate. Its capture-only result never signs the aesthetic review. A separate independent reviewer supplies `--visual-review <artifact>` (default `.tmp/unified-browser-children/visual-review.json`) binding the exact UI receipt, candidate source map and every screenshot hash. Full `passed` requires all three proofs. The default `.tmp/unified-browser-children/latest.json` indexes immutable native, UI and review evidence; unchanged consumed source/external/driver hashes permit reuse across Git HEAD changes. Stale evidence reruns the affected real proof. This fixture does not certify physical OS input or installation.
