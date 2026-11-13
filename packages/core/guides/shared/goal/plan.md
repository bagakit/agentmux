# plan

<!-- amux:content -->
A large Goal keeps one outcome and splits its work into a plan inside the Goal, not into
many small Goals. Read goal plan --goal ID first; it returns nodes, dependencies, named
executors, reviews, the plan revision and every node delegation. Node state is derived
from those facts: waiting, ready, working, review, changes, done, cancelled or unknown.
As Supervisor, write the plan with goal plan revise against the revision you read; a
refused revision means someone changed it, so read it again. Name each node's outcome,
dependencies, covered criteria, a check another party can repeat, and its executor
(Host and AgentSession) when known. Cancel a node with work instead of removing it.
Once a node has work, keep its outcome, check and criterion set; cancel it and add a
new node for a different task. A node delegation carries the complete node criterion set.
Delegate only a ready node, or one whose review asked for changes, with goal delegate and
intent.planNodeId, to the executor the plan names. Parallel ready nodes go out together.
A node is done only after goal plan review by someone other than its executor: run the
node's check yourself and record the command, its actual result and evidence locations.
A changes verdict says what to change; send the rework to the same executor on the same
thread. An unknown node means its delivery or applicability to current criteria needs
reconciliation. Read the original delegation receipt and frozen criteria before acting;
never resend an unknown delivery. Changed or missing criteria keep the old review readable
without completing the current work; unchanged criteria keep their accepted work.
Continuous progress on this Goal reports
open nodes each check and pauses when every node passed review; a person still accepts
the Goal results. A node review or plan completion never accepts the Goal.

The plan's executor Host can differ from the Supervisor's Host. A delegation intent.hostId
selects the original Supervisor route; intent.workerHostId selects the executor route.
When workerHostId is absent in an original local record, its original hostId names both.
Each signed original source freezes the actual owner and worker Runtime identities: a route
alias is not a different executor or reviewer. Independent review compares Runtime and
Session identity, so the worker cannot approve itself through another Host alias.

The remote worker reports from its received source MID as described in the executor section.
The Supervisor reads goal delegations and uses goal collect on the original Goal; collection
retrieves signed replies through the original connection before recording the verified report.
If retrieval is unavailable, retain the source and report identities and inspect the same
operation; locally verified replies remain readable. Submission, delivery, collection and
independent review are separate facts. Only the independent passing review releases a
node's dependents, and a person still accepts the Goal.
