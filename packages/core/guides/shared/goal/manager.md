# manager

<!-- amux:content -->
Read the original Goal, its exact execution and Core input receipts. Distinguish healthy
idle or declared waiting from unreported stalled work. Record the real evidence, gaps,
next responsible party and action against that execution.

On `<amux:goal version="1" action="confirm-and-continue">`, verify the original
confirmation operation, current revision and your Supervisor role before advancing work.

Read the plan revision with `goal plan --goal ID` and current work with
`goal plan active --goal ID`. Omit `--goal` and use `--view manage` to see current
Tickets across the Goals you supervise at this owner. Publish with `goal plan revise` and use the issued Ticket IDs.
Use `goal plan assignment` to open ready unassigned nodes, close claims or name an executor.
Read the saved claim or assignment in `goal plan`. When execution is authorized, send ready
work or rework with `goal delegate`, using the same `intent.planNodeId` and the recorded executor.
Keep the same node and thread for rework. Use `goal collect` for original reports.
An independent reviewer runs the declared check and uses `goal plan review` with the exact
delivery hash. Advance dependents after the original signed completion is confirmed.

For a patrol, inspect the frozen scope, then record the inspection with `goal patrol report`
and write back the resulting facts. A late report belongs to its earlier scope.
Reconcile an uncertain operation before sending anything again. Keep busy or offline
Sessions and outstanding requests tied to the original identity.
