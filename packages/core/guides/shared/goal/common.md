# common

<!-- amux:content -->
The original Goal owner holds criteria, execution bindings, progress and reports.
Core supplies authenticated Session, Run, input and delivery facts. ctxmux owns process state.
Keep the same Goal, version, operation, Host, Session, Run and message/thread after uncertain
results. Inspect those originals before another write. Preserve healthy Agents and their input.

A person confirms the exact proposal and accepts the exact current report. Execution
permission grants neither choice. `goal accept` accepts without closing the Goal.
`goal accept --finish` also ends this Goal's scheduled follow-up and preserves gaps,
execution history and the original Agents. Idle, exit, delivery, `worker_done` and a
Done status alone do not establish acceptance.
