---
summary: "Saved scripts, persistent TUI tools, display evaluation and metrics"
roles: "Authorized local tool operators"
when: "Inspect, install, edit, run or stop a saved tool"
---

# toolkit

<!-- amux:content -->
The Toolkit owner holds saved definitions, exact admissions and results. Reading this
module, inspect/script/ls and passive watch do not execute scripts. Creating or enabling a
TUI loads its shell command; Host startup reconnects its original Run or starts one confirmed
new execution. Source edits affect the next execution. Distinguish configuration, action
execution, display evaluation, TUI Run binding and each retained invocation before acting.
Unknown creation or Run state retains its original identity; never automatically replay it.
Local package file changes are read on the next explicit execution or source inspection.

For the fixed read-only Performance tool, an unknown creation with no confirmed Run can
start a separate observation through explicit `run --input FILE` containing
`{invocationId,expectedExecutionId}`. Use the current unknown execution as the expectation
and a new invocation identity; keep that same invocation after an unknown reply. The owner
atomically retains the original admission and failure before dispatching the new creation.
Ordinary opening, watch and run without that input never replace the unknown. Inspect the
original with `inspect performance --execution-id ID`; `--failure-evidence` explicitly reads
retained private failure material. A known original Run keeps its existing reconciliation
path. New data does not prove the old creation failed or never ran.

Finite scripts may publish one `ToolkitResultDocument` through the original
`@agentmux/core/toolkit-result-channel` capability, ending a single JSON line with LF and EOF.
The public `@agentmux/core/toolkit-result-document` parser accepts optional
`capsules: [{label, capsuleId}]` (at most 16 distinct fixed-width object IDs) inside the same
document budget. Publish the ID returned by `capsule.create`, never a localhost URL or a
script-declared execution identity. The enclosing authenticated execution supplies the real
tool/configuration/execution provenance. Capsule references grant no authority; explicit
Open uses the original Capsule owner and Copy uses its `amux://capsule/<ID>` object link.
Reading or copying a result never reruns the tool. Keep uncertain original opens and query
their retained operation instead of opening a replacement.

A Custom TUI can wrap the same Capsule management CLI. Keep it a client: the tool's
`toolId`, `executionId` and terminal Run differ from Capsule's independent service Run.
Closing or stopping the tool does not stop that service. Core owns the service's saved
run intent and keepalive; a shell loop or a second HTTP owner in the tool does not.

For a one-shot status query, save an ordinary disabled Custom TUI with this shape, replacing
the workspace, installed CLI executable and endpoint with exact discovered values:

```json
{
  "name": "Capsule status",
  "icon": "terminal",
  "enabled": false,
  "statusBar": "icon",
  "mode": "tui",
  "workspacePath": "/absolute/tool/workspace",
  "script": "exec \"$1\" --endpoint \"$2\" capsule runtime inspect",
  "args": ["/absolute/installed/amux", "unix:/absolute/core/control.sock"]
}
```

Use `amux toolkit create <TOOL_ID> --input FILE` for that saved definition, then explicitly
enable it when the saved command should run under the original Toolkit authorization.
The example queries once and exits, retaining its terminal result; it does not install a
built-in tool or an interactive menu.
`capsule runtime inspect` needs no input. Explicit runtime start accepts
`{operationId,expectedRevision}` and stop also binds `expectedRun:{runId}|null`;
pass that JSON through `--input FILE|-` and read the actual leaf help before a mutation.
Preserve the original management operation after unknown results; inspect the runtime and
match its `operationId`. An absent or different operation does not confirm the original
action. Do not create a replacement Run. A remote endpoint is the original execution environment:
its loopback address is not a browser URL on this computer and grants no network access.

Read amux toolkit --help for the configuration/execution journey and the exact action's help
before running or changing a tool. Preserve the original operation after unknown results.
