# executor

<!-- amux:content -->
Read the original finite Start or delegation and its frozen criteria before acting.
Report progress, questions, waiting conditions or blockers against that execution.
Keep responsibility until verified handoff. A discussion or patrol does not start work.

For a remote delegation, keep the Goal at its original owner. Read the received MID
with `message read --message-id SOURCE`.
Use the verified `envelope.application` (`agentmux.goal-delegation.v1`) to identify the
Goal, delegation, proposal revision and criteria. A `planNodeId` binds the delivery to
that node. Run its check for your own verification. An independent reviewer decides the verdict.

Use `goal report --input FILE` at your Core with the original operation, `sourceMessageId`
and actual author. Report each criterion as met, gap or unknown with evidence.
See `goal report --help` for the JSON shape. A `report-submission` with
`submission.transport.state: outbox` saves a signed reply locally. The Supervisor retrieves it
through the existing worker connection. Preserve the report operation, reply MID and
original Run if the result is uncertain. Use the same original thread for questions and rework.
