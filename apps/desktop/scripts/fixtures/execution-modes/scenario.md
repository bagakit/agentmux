# Execution arrangement Renderer proof

This fixture mounts the production `App`, including its `WorkspaceWorkbench`, `NewTabSurface`, `SurfaceToolDock`, Files, Git, Store, Editor, theme and full CSS. Host/configuration/Session/file and Git API responses are controlled external inputs. Spatial read/commit/subscribe use the real Core AgentMuxSpatialStateStore through private Main IPC and a file inside the private profile. It never operates the user App or a real remote Agent.

Owning behavior: `docs/design/behavior/workface-launcher.md#agent-运行端与项目工具端`; presentation: `docs/design/presentation/spaces-and-layout.md#初始-launcher-的现代工作台密度`. Product handlers and selectors are compiled unchanged. A mode is a projection of the original two workspace addresses; no fixture mode selector substitutes for product logic.

Prepare and run an exact private candidate:

```sh
node apps/desktop/scripts/capture-execution-modes.mjs --prepare
node apps/desktop/scripts/capture-execution-modes.mjs --run EXACT_PREPARED_DIRECTORY
```

`--first` gives an early full viewport only and cannot satisfy the final journey/restore receipt. The full run drives native Electron mouse/key events through visible product controls. Native macOS select popup changes are explicit synthetic setup; the exact directory is still chosen with a native Renderer click. It captures default local arrangements in dark/light and narrow views; remote Agent setup/cancel/selection, observation failure and short view; remote project navigation; actual Files and Git marker consumption; reverse custom arrangements; first empty-project draft materialization; and the retained final arrangement. The original prepareRendererUpdate checkpoint flushes Core and Renderer storage; a second real private Electron process uses the same profile and original persistence to verify the same Tabs, layouts, selection, draft, names and options.

The original Session/Run/binding facts are fixed controlled inputs and checked for preservation. They are not real remote execution or semantic recovery evidence. The final native Renderer click on Launch records the exact original request at the controlled external API and returns an authoritative `not_applied` disposition; the same Launcher tuple and every draft must be restored. Earlier mode/navigation actions must leave unexpected Agent calls empty. Same-candidate `launcher-tool-execution.test.tsx` production consumer tests independently cover both launch directions. Files and Git responses contain distinct per-project markers and their exact API calls are retained, proving App routing to its selected registered project, not physical remote disk contents.

The capture receipt is `captureOnly` and starts with independent visual review `not-performed`. Reviewers must actually open complete PNGs, inspect hierarchy/legibility/density, selected and focus states, wide/narrow/short behavior and configuration clarity. If product pixels change, prepare/capture the changed owners again. A successful capture is not an aesthetic verdict or an installed release.

For a later candidate that changes the public spatial owner, `EXECUTION_MODES_RESTORE_SOURCE=EXACT_PREVIOUS_CAPTURE node apps/desktop/scripts/capture-execution-modes.mjs --run EXACT_NEW_CAPTURE --restore` reads the original private profile and expected checkpoint without reseeding. The new `restore-receipt.json` binds both source snapshots and the original journey/driver; it qualifies only the new process restoration. It does not claim the earlier 14-frame journey was repeated on the new candidate. `--configuration-review` likewise qualifies only the changed Host inventory states. `EXECUTION_MODES_STYLE_INPUTS=EXACT_CSS_INPUTS_JSON` replaces the single stylesheet with the retained, fully compiled production cascade; `review-execution-modes-css.mjs` captures the changed compact layouts and kills the actual one-column CSS mutant with native geometry and hit-target assertions.
