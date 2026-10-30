# `@agentmux/demand`

`@agentmux/demand` is the host-neutral filesystem fact store for AgentMux demands.
It has no Electron, React, Desktop, Core, or Runtime dependency. Callers always pass
an explicit directory; the package never treats the current working directory as a
store root.
Configure `demandDataDirectory` in the calling application and pass that directory
explicitly.

```ts
import { openDemandStore } from '@agentmux/demand'

const store = openDemandStore({ root: demandDataDirectory })
const receipt = await store.create({ title: 'Ship the editor', sessionIds: [] })
await store.linkSession(receipt.demand.id, 'session-id')
await store.addDecision(receipt.demand.id, {
  question: 'Which project owns this?',
  decision: 'AgentMux',
  rationale: 'It spans multiple sessions',
  actorId: null,
})
```

The store is `<root>/store.json` with schema `agentmux.demand-store.v1`. Mutations
use an in-process queue, a nonblocking kernel FD lock on a permanent
`store.lock` inode, an `fsync`ed temporary snapshot, and an atomic rename. The
complete lock marker is published with a no-replace hard link while already
locked; closing the handle or process death releases ownership. Waiting is
asynchronous and bounded; ordinary reads and other roots remain available.
Protocol owners never replace or unlink the lock path.

Old, incomplete or unrecognized lock files remain explicitly unknown. The store
preserves their bytes and permits ordinary reads, but never infers ownership from
a PID, age or an advisory lock. An old live writer may finish and unlink its own
lock; the next explicit call can then enter the new protocol. There is no automatic
legacy lock conversion, and this does not solve abandoned legacy locks. Manual
replacement or deletion of a published lock is outside the protocol guarantee.

Corrupt snapshots and lock failures raise `StoreError` with `code`,
`phase`, and `path`; they never become an empty replacement.

The standalone `agentmux-demand` binary reads the same API. Pass `--root` (or set
`AGENTMUX_DEMAND_ROOT`) and use `list`, `show`, `create`, `update`, `link-session`,
`unlink-session`, `link-project`, `unlink-project`, `activity`, and `decision-log`.

Goals use the same durable owner. Agents submit `proposeAlignment(id, proposal)`
and `proposeGrounding(id, proposal)`, or CLI `propose-alignment` / `propose-grounding`
with `--id` and `--proposal <json>`. `update` also accepts `--alignment <json>` and
`--grounding <json>`. Proposals cannot provide revisions, submission identities or
acknowledgement timestamps. The owner generates those facts.

Hosts expose `confirmAlignment(id, expectedRevision)` and
`acceptGrounding(id, expectedAlignmentRevision, expectedSubmissionId, acceptGaps?)`
only through explicit human actions. Changed goals invalidate confirmation; changed
results invalidate acceptance. Same-content proposals retain acknowledgements.
Acceptance requires one known, evidenced result per current confirmed criterion;
remaining gaps require the explicit `acceptGaps` choice and stay recorded as gaps.
A locatable evidence reference does not claim that the owner verified its contents.

Browser clients consume the pure types, parsers and readiness helpers from
`@agentmux/demand/goals`; this subpath has no filesystem or UI dependency.
