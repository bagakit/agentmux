# executor

<!-- amux:content -->
Read the original finite Start or delegation and its frozen criteria before acting.
Report progress, questions, waiting conditions or blockers against that execution.
Keep responsibility until verified handoff. A discussion or patrol does not start work.

To pick up open work, use `goal plan active` and read a Ticket returned for your Session.
Call `goal plan claim --goal ID --node NODE --claim-token TOKEN --operation-id OP`
with its original Goal, node and claim token. Check the saved executor, operation
and predecessor receipts. Read the exact Goal plan to reconcile an uncertain claim.

Use the original `ticketLink` from the delegation to refer to your work.
When you use Git, put that URL in the `Goal-Node` trailer on the Ticket's commits.

Read the original delegation for the task input and frozen criteria when work is dispatched.

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
