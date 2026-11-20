# `@agentmux/demand`

`@agentmux/demand` is the host-neutral filesystem fact store for AgentMux demands.
It has no Electron, React, Desktop, Core, or Runtime dependency. Callers always pass
an explicit directory; the package never treats the current working directory as a
store root.
The calling application chooses the store root (the Host uses `demands/` beside
its configuration file) and passes it explicitly.

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
asynchronous and bounded (by default `lockTimeoutMs` 5000 and `lockRetryMs` 25),
so it never blocks the Core event loop; ordinary reads and other roots remain
available.
Protocol owners never replace or unlink the lock path.

Old, incomplete or unrecognized lock files remain explicitly unknown. The store
preserves their bytes and permits ordinary reads, but never infers ownership from
a PID, age or an advisory lock. An old live writer may finish and unlink its own
lock; the next explicit call can then enter the new protocol. There is no automatic
legacy lock conversion, and this does not solve abandoned legacy locks. Manual
replacement or deletion of a published lock is outside the protocol guarantee.

Corrupt snapshots and lock failures raise `StoreError` with `code`,
`phase`, and `path`; they never become an empty replacement. A write whose commit
outcome is unknown is never replayed automatically: reread the same Goal and, when
the call carries one, the same operation before deciding. The Goal's body,
relations, revision and operation identity are kept.

The standalone `agentmux-demand` binary reads the same API. Pass `--root` (or set
`AGENTMUX_DEMAND_ROOT`). `agentmux-demand help` prints the current verbs, options
and safety requirements such as `delete --confirm delete`; the parser is
[`src/cli.ts`](src/cli.ts).
On `create`, the store assigns the ID and returns it as `demand.id` in the JSON
response. Pass that ID to commands such as `show --id` and `update --id`.

Goals use the same durable owner. Agents submit `proposeAlignment(id, proposal)`
and `proposeGrounding(id, proposal)`, or CLI `propose-alignment` / `propose-grounding`
with `--id` and `--proposal <json>`. `update` also accepts `--alignment <json>` and
`--grounding <json>`. Proposals cannot provide revisions, submission identities or
acknowledgement timestamps. The owner generates those facts.

Hosts qualify the authenticated current Supervisor or person/device before
`confirmAlignment` stores the exact proposal revision and confirmer.
`acceptGrounding` uses an explicit authenticated human action. Changed goals
invalidate confirmation. Changed results invalidate acceptance. Same-content
proposals retain acknowledgements.
Acceptance requires one known, evidenced result per current confirmed criterion;
remaining gaps require the explicit `acceptGaps` choice and stay recorded as gaps.
A locatable evidence reference does not claim that the owner verified its contents.

Browser clients consume the pure types, parsers and readiness helpers from
`@agentmux/demand/goals`; this subpath has no filesystem or UI dependency.

The existing `sessionIds`, `assigneeSessionIds` and `supervisorSessionId` relation
fields also accept a Source-qualified reference from `@agentmux/demand/relations`:

```ts
const member = {
  kind: 'space-member',
  source: {
    runtimeId: 'source-runtime', spaceId: 'space-id', regionId: 'region-id',
    admission: { kind: 'creation', operationId: 'original-creation-id' },
  },
  execution: { runtimeId: 'execution-runtime', agentSessionId: 'session-id' },
} as const
await store.update(goalId, { assigneeSessionIds: [member] })
```

An association uses `admission.kind: 'association'` and its original Source
association operation. Existing string references keep their exact values. The
parser and `demandAgentReferenceKey` distinguish the complete Source occurrence,
admission and execution Runtime, including equal Session IDs on different Runtimes.
The same original role/subset and revision checks apply to both forms. A relation
does not contain a Host route, credentials, Run, input authority or observed health.
The filesystem store preserves these business facts without contacting an Agent.

`agentmux-demand` accepts repeatable `--agent-ref JSON`, `--assignees JSON` and
`--supervisor-ref JSON` on its relation-writing commands. Core's separate `amux goal`
public owner accepts `--related JSON`, `--assignees JSON` and `--supervisor-ref JSON`;
new qualified references there require current Source access for that operation.
Ordinary edits of unchanged saved references require no remote qualification.

## Goal execution records

The same store also keeps the records behind Supervisor execution, Goal plans
and PMO patrol. They hold business intent and references to Agent work; Core
keeps message transmission, input delivery and Run state.

| Subpath | Records |
| --- | --- |
| `@agentmux/demand/delegations` | A Supervisor's delegation of work to a worker Agent: the frozen intent (owner and worker Sessions and Runs, thread, request text, the confirmed alignment revision and criteria, context sources and the plan node), the worker's report with its grounding proposal, the Supervisor's collection of that report, and attention notices |
| `@agentmux/demand/goal-plan` | A Goal's plan as a dependency graph of nodes, each with an expected outcome, the criteria it covers, a check another party can repeat, and an optional executor. A review that passes a node must record the command it ran, the result and the evidence. Node state (`waiting`, `ready`, `working`, `review`, `changes`, `done`, `cancelled`, `unknown`) is derived from delegation and review facts and never stored |
| `@agentmux/demand/relations` | The roles a Session plays on Goals: `assignee`, `supervisor`, `related`, `create`, `discussion` and `requirements` |
| Root entry | Also exports Goal Start dispatch records, execution responsibility and progress, patrol attempts and reports, and discussion intents |

Store methods follow the same pattern: `prepareDelegation`, `preparePatrol`
and `prepareDispatch` freeze an intent before Core is asked to send anything,
and the matching `mark…Attempt`, `record…` and `inspect…` methods keep each
attempt and its outcome. Behavior is defined in
[Goals behavior](../../docs/design/behavior/goals.md).
