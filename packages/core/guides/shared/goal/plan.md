# plan

<!-- amux:content -->
1. **Read.** Use `goal plan --goal ID`. Read the owner's `planState`, then match
   the node's current `delegationOperationId` to its original report, worker and thread.
   To find active Tickets across Goals, use `goal plan active --view manage`.
   If `planStateIssue` is present, read the Goal again or update its serving Host.
   Node states stay unknown while the derivation is unavailable. Keep the saved plan,
   delegations and any write receipt. For all state fields use `goal plan --help`.
2. **Delegate.** Use `goal delegate` with `intent.planNodeId` and the complete node
   criteria. A ready node or a node with changes requested can go to its named executor.
   Independent ready nodes can run in parallel. For rework, preserve the node and original
   thread. Use `intent.workerHostId` for the exact worker route on another Host.
3. **Review.** In Desktop choose **View delivery → Record review**, or use
   `goal plan review --input FILE`. Judge the current reported attempt. The reviewer
   runs the declared check independently. A pass records the actual check, result and
   evidence. A dependent task becomes ready once all its dependencies pass.
   A changes verdict records what to fix. An executor cannot approve its work through a Host alias.
   After a lost receipt, read `goal plan --goal ID` and match the saved review operation,
   node and delegation. Node review and the person's Goal acceptance are separate decisions.

### Claim an open node

The Supervisor or a person opens a ready node with `goal plan assignment --input FILE`.
An authorized Agent can find it with `goal plan active`. For one Goal use
`--goal ID --view claimable`. Pin reads and claims to the original address with
`--runtime RUNTIME --namespace NS`. If the active index is rebuilding, read the original
plan for history and retry the active query.

### Create or revise a plan

`goal discuss --goal ID --mode plan --operation-id OP` asks the current
Supervisor to save a plan. Choose a Supervisor explicitly when none exists. As the
Supervisor, use `goal plan revise` directly against the version you read. Planning can
use a real unconfirmed proposal. Clarify missing criteria first. Discussion and planning
grant neither execution nor human confirmation. A delivered request or textual breakdown
does not prove a plan was saved. Read the current plan revision and keep OP when receipt
is uncertain. Never-attempted requests can continue on the recovered same Session using
`goal patrol continue`. Frozen or claimed older requests only reconcile their original
input. A saved plan revision completes planning.

A node names its outcome, dependencies, criteria, repeatable check and optional executor.
Name each new node with a distinct draft ID inside the revision. New dependencies
can point to a draft ID from that revision or to an already published node ID.
The original owner issues signed Ticket records in dependency order and returns
canonical IDs in `plan.nodes`. Match each original draft to its `createdTickets`
record, then use the issued ID for assignments, delegation, and links.
Retire a published node by cancelling it. Once it has work, preserve its outcome,
check and criterion set. Create a new node for different work. Explicit reassignment to a different executor supersedes the
newest unreviewed attempt. Clearing the executor does not. A passed node stays done.
The previous attempt and its thread remain readable. For input and revision rules use
`goal plan revise --help`.

Read `goal plan` for `plan.nodes` and `ticketLinks`. Each link carries the original
node ID in its `#T-<nodeId>` fragment. Use `goal focus --link URL` to open the exact
Ticket. If your workflow uses Git, use the published URL as the `Goal-Node` trailer.

The owner signs a stable proof during claim or direct dispatch, then signs the
completion when independent review passes. Its referenced hashes identify exact
upstream completions and the original execution. If a receiver needs offline
validation, use `goal plan verify --input FILE --goal ID --hash HASH --fingerprint SHA256`.
Use the expected hash from the original link or related proof and a signing key
fingerprint independently approved for this Goal and purpose.

For a reviewed Ticket, use the exact delivery hash from its original report receipt.
An appended Ticket can cite its original proposal reply with a revision proposal
containing `nodeId`, `delegationOperationId` and `replyMessageId`.

### Reconcile before advancing

- `dispatch-link` unknown means read the original Core delivery receipt. Keep the same
  operation and source. For a remote outbox, see `goal delegate --help` to reconcile
  the same operation after restoring its route or trust. `goal delegation bind` links
  a confirmed worker inbox entry without sending it.
- `criteria` unknown means missing or changed criteria. Read the current proposal.
  An old passing review remains history. Unchanged criteria retain their accepted work.
- `completion-proof` unknown means a passing review is missing its original signed
  completion. Read the original owner’s review and receipt before advancing its dependents.
- The Supervisor uses `goal collect` to retrieve original signed replies through the
  existing worker connection. An outbox receipt is local custody. A verified collection
  records the original report. Preserve those identities if retrieval is unavailable.
- Continuous progress freezes the plan revision, actionable nodes and original attempt
  references for each input. Follow that frozen scope after an uncertain input.
  When every node passes, wait for the person's Goal acceptance.
