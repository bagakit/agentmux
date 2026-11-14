# plan

<!-- amux:content -->
A large Goal keeps one outcome and splits its work into a plan inside the Goal, not into
many small Goals. Read goal plan --goal ID first; it returns nodes, dependencies, named
executors, reviews, the plan revision and every node delegation. Node state is derived
from those facts: waiting, ready, working, review, changes, done, cancelled or unknown.
planState carries that derivation as the Goals page shows it, with each node's current
attempt (delegation operation, source MID and thread) and every unknown reason; use it
instead of deriving state yourself. Goal records carry the same planState with their plan.
Without planState the owner gave no derivation: node states are unknown to you, while the
plan and delegations still read as returned.
goal discuss --goal ID --mode plan --operation-id OP explicitly requests a saved plan in the
original dedicated discussion. open only navigates. Keep OP after an unknown input result;
an acknowledgement or a textual breakdown does not prove that a plan was saved. Read the
same Goal plan to observe its actual revision and nodes. Planning does not start work,
enable continuous progress, confirm the Goal or accept results.
Use the current alignment revision; human confirmation is not a prerequisite for planning.
If the proposal or meaningful criteria are missing, clarify the real intent and propose
alignment for this same Goal first, without inventing standards or a placeholder graph.
The discussion Agent is not automatically the Supervisor. Only the exact current Supervisor
or a person may revise the plan; otherwise preserve the original discussion and explain the
explicit management selection or coordination needed. Never assign yourself or impersonate
a person to make the graph appear.
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
thread. An unknown node names why it needs reconciliation. dispatch-link: read the original
delegation receipt before acting and never resend that delivery. criteria: the node names no
criterion, names one the current proposal no longer has, or one whose text changed since its
attempt was sent; revise the plan or the proposal. Changed or missing criteria keep the old
review readable without completing the current work; unchanged criteria keep their accepted
work. Each new continuous-progress input on this Goal freezes the same owner snapshot that
qualified the check: plan revision, every ready, working, review, changes or unknown node,
its named executor, original delegation/source/thread and all unknown reasons. Read node
outcomes and checks through goal plan; manage this work as Supervisor rather than taking
over every node. An unconfirmed input keeps that frozen handoff and manager guidance even
after the plan changes. Progress pauses when every node passed review; a person still
accepts the Goal results. A node review or plan
completion never accepts the Goal.

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

An unlinked remote outbox remains unknown: it proves only the original owner save. After
restoring the exact route or message trust, explicitly repeat goal delegate with the same
operation, source MID and frozen intent to reconcile the worker receipt. Reading or observing
the Goal never retries the original delivery. goal delegation bind never sends; it links a
remote source only after an exact read of the worker inbox confirms that original source.
A later offline worker does not erase an already confirmed original link.
