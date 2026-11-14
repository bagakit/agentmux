# Original parallel task native consumer

Root's Main runner loads this renderer with preview=false and the full production preload.
`window.taskOrchestrationNative.setOriginal({asset,assets,version,current})` receives snapshots
read from the actual original task owner, then mounts production BrowserTaskParallel. It does
not replace any API method. Start and Continue require actual trusted native events; Stop uses
the production component's original exact-group API. `read` reports visible text/mounting only.

Main supplies the real target discovery and task-inspection handlers, the production
parallel IPC handlers, original Browser/TaskAssets owners and public CLI/RPC. Native input
opens target review, fills fresh original fields, queries the same continuation and stops the
same group. Definition, run, item IDs and saved results must remain original across restart.
Main execution, authorization, Browser health and restart assertions belong to Root's runner.

The separate `capture-browser-task-orchestration.mjs` fixture proves production Editor/Pane
presentation with explicit DTO ports; its images cannot replace this native owner evidence.
