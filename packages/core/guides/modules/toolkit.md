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

Read amux toolkit --help for the configuration/execution journey and the exact action's help
before running or changing a tool. Preserve the original operation after unknown results.
