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
goal discuss --goal ID --mode plan --operation-id OP explicitly asks the current Supervisor
to save a plan through the original Host request owner. With no Supervisor, choose one
explicitly before sending; selection itself sends nothing. As the Supervisor, read and
revise the plan directly instead of requesting it from yourself. Planning waits for eligible
input, retaining its original request and target. Read goal plan for the saved request and
its observation: delivered still waits for a saved newer plan revision. A never-attempted
request may use goal patrol continue after same-Session recovery; a planning request never
uses goal patrol report. Old frozen or claimed dedicated-discussion requests only reconcile
their original input, without resending or redirecting. A new explicit operation may ask the
current Supervisor independently. open only navigates. Keep OP after an unknown input result;
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
As Supervisor, write the plan with goal plan revise against the revision you read. An
operation replay must keep the original author, expected revision, proposal revision and
nodes. If a later revision exists, the refusal names where the original operation applied;
read the current plan instead of repeating that old write. Name each node's outcome,
dependencies, covered criteria, a check another party can repeat, and its executor
(Host and AgentSession) when known. Cancel a node with work instead of removing it.
Once a node has work, keep its outcome, check and criterion set; cancel it and add a
new node for a different task. New nodes and changed criterion sets on unrecorded nodes
must cover at least one criterion and only criteria in the current proposal. Unchanged old
criterion sets remain readable and may need reconciliation. A node delegation carries the
complete node criterion set. Explicitly changing a non-null executor supersedes the newest
unreviewed attempt and permits the new executor once dependencies pass; clearing the
executor does not supersede it. An old report stays on its original delegation and thread,
but cannot receive the current node's review. A passed node stays done after reassignment.
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
