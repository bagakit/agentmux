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

### Use a system workflow

In Desktop, open **Settings → Goals → Workflows** to view and configure
the system workflows. **Execution and review** (`execution-review`) pairs
work with independent review. **Evidence synthesis** (`evidence-synthesis`)
organizes evidence gathering, independent challenges and a synthesis.
Use the current Goal criteria to specify the work, checks and exact roles.
Publish through the original plan revision. Its saved Ticket IDs and
dependencies are the record of this Goal's plan.

Use `settings inspect goals.workflow` to read the saved template, reviewer
and budget on the serving owner. The `goals.workflow.reviewer` setting is one
JSON value with `hostId`, `runtimeId` and `sessionId`. An empty value clears
it. Read the owner before editing and use `settings set --help` for the write
form. After an uncertain write, keep the original operation and read back
the settings. Selecting `off` disables workflow use in settings. Start and
delegation use the original Goal and role authorization independently of
these settings. Goal acceptance remains a person's decision.

For a new plan delegation in a budgeted workflow, read the original Goal's
active continuation and put its ID in `intent.workflowLoopId` in the existing
`goal delegate` input. `maxConcurrent` counts current attempts in that loop
still awaiting a report. `maxAttempts` counts the new attempts admitted for
that loop. Reconcile an uncertain delegation under its original operation and
loop ID. At the budget boundary, read the original plan for completed work and
pending nodes. A new loop requires the existing explicit stop and start actions.

### Create or revise a plan

Keep decomposition and follow-up work within the original Goal when it serves
that Goal's current criteria. Use `goal plan append` to save the new Tickets there,
then share their returned links in the conversation. An appended Ticket can
depend on an already completed Ticket and keeps its original completion.
Use `goal plan append --help` for the input and receipt. If the work changes
the Goal's agreed criteria, clarify the scope before publishing it.

`goal discuss --goal ID --mode plan --operation-id OP` asks the current
Supervisor to save a plan. Choose a Supervisor explicitly when none exists. As the
Supervisor, publish directly. Use `goal plan revise` against the version you read
when editing existing nodes. Planning can
use a real unconfirmed proposal. Clarify missing criteria first. Discussion and planning
grant neither execution nor confirmation. A delivered request or textual breakdown
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
  When every relevant Ticket passes and execution is complete, move the original Goal
  to `in_review` with `goal update --goal ID --status in_review`. Report the evidence
  still missing or the exact result ready for the person's acceptance.

### Recheck only the affected work

1. Read `goal inspect --goal ID` and `goal plan --goal ID` on the original
   owner. For each affected Ticket, identify the current criteria text,
   delivered artifact version, recorded check and frozen predecessor
   completion proofs.
2. Compare the proposed change with those facts. Keep the original node IDs,
   attempts and reviews for unaffected work. Trace changed evidence or a
   changed upstream completion through the dependencies that actually
   reference it.
3. Revise the plan through its current revision. Use a new node for changed
   work when the published node already has an attempt. Rerun the relevant
   checks against the exact delivery version and record the independent
   verdict through the original review path. Preserve earlier evidence and
   its version when a newer result needs review.
4. If a send or review outcome is unknown, inspect the same original
   operation before trying another write. Use a new attempt for actual
   rework, with the source report and reasons carried forward.
