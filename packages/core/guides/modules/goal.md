---
summary: "Goal scope, execution responsibility, reports and PMO patrol"
roles: "Executors, managers and people confirming or accepting work"
when: "Discuss, execute, supervise, inspect or report on a Goal"
---

# goal

<!-- amux:content -->
The original Goal owner is the business source of truth. Begin with goal inspect and
goal delegations for the exact original Goal/alignment/execution and current next responsibility.
Use goal activity for durable progress evidence, and the current help for typed progress,
delegation, report, collection and patrol operations. Inspect the same original identities after
an unknown write; do not create another Goal or duplicate input. Navigation, assignment, finite
Start, source-bound delegation and actual execution are different facts.

## Read the original Goal workspace

`goal inspect` exposes `goal.address` when the original owner can confirm it:
`runtimeId`, `namespace`, `goalUrl` and `planUrl`. Copy those canonical URLs unchanged.
They identify the original semantic Runtime, its canonical Goal store and this exact
Goal. They contain no source path and grant no access or execution authority. A Host
alias, Supervisor or current cwd cannot replace that source. If `addressIssue` is
present, the Goal remains readable; read that original source again before sharing a link.

<!-- amux:generated command:goal.focus -->

For source-qualified navigation retain both `--runtime` and `--namespace` from that
address. `--section plan` reveals the same Goal's original graph, including its honest
empty state; opening it never requests planning, creates tasks or sends input. Read
navigation and `presentation.goal` separately: selection alone does not confirm the
requested plan is in view. Missing or mismatched sources keep the current workface and
original link, rather than opening another store's namesake Goal. Without source flags,
existing Goal focus keeps its current-owner meaning. `goal plan` remains the structured
read of the saved plan and its owner-derived states; it does not open the GUI.

[contract](../shared/goal/contract.md "amux:include")

[activity](../shared/goal/activity.md "amux:include")

## Source-qualified relations

The original related, assignee and Supervisor fields accept their existing Session
strings or a complete business reference:

```json
{"kind":"space-member","source":{"runtimeId":"B","spaceId":"SPACE","regionId":"REGION","admission":{"kind":"creation","operationId":"ORIGINAL_C"}},"execution":{"runtimeId":"D","agentSessionId":"SID"}}
```

For an independently coordinated Agent, retain Source association `kind:"association"`
and its original L operation instead. Obtain these fields from the Source's confirmed
`space inspect` or snapshot member and original admission, never a selected Executor,
Host label, alias or a same-named local Session. The execution Runtime remains distinct
from the Source Runtime. Do not infer a Run or permission from this reference.

`goal create` and `goal update` accept `--related JSON`; relation-writing leaves accept
`--assignees JSON` and `--supervisor-ref JSON`. For each newly added qualified relation,
pass `--relation-access JSON`, an array of `{reference:REFERENCE,access:{source:{hostId:HOST}}}`.
The configured Source carrier may include `via:{routeId,adoptedRoute}` from its saved
prefix. Access belongs to this invocation and is never saved in the Goal. It neither
grants receiver permission nor changes the relation's identity. Use the exact full
reference as the access entry key; do not choose the first matching bare Session ID.

Save verifies the original Source C/member or L/reference/resource business tuple.
It does not require the execution Agent to be live or an association's independent
Coordinator to be reachable. Edits that retain existing references do not requalify
them remotely. Read the same Goal after an unknown save and retain its original
request; never automatically repeat the write. An assignment does not submit work,
enable automatic supervision or authorize input. Source-qualified Start requires its
own current execution access; a qualified reference is never converted to a legacy SID.

## One-time Source-qualified Start

Pass the original assigned reference to `goal start --agent-ref JSON --access JSON`.
Access is this call's configured Source carrier, for example
`{"source":{"hostId":"SOURCE_HOST"}}`; an external association also needs its
independently authenticated `coordinator` carrier. Source membership does not grant
Coordinator input permission. The Start owner obtains the actual Run, freezes the
original operation, body and independent note, and uses the original Core controlled
input API. It creates no Loop or automatic supervision permission.

Keep the same `--operation-id` after an uncertain result. `goal inspect --goal GOAL
--dispatch-operation OP --access JSON` checks the original input without sending it.
An ordinary repeated Start also only checks an already submitted operation. To
explicitly continue that retained request use `goal start --goal GOAL --agent-ref JSON
--access JSON --operation-id OP --resume-original`. Core compares the same original
content and source before rejoining its exact waiting reference. No new operation,
Run or waiting generation is supplied. Unknown effects are not automatically resent;
a missing read is not proof of non-submission. The qualified receipt retains its
reference and Run instead of a synthetic local Session ID. Input acknowledgement
is separate from current Run health, Goal completion and human acceptance.

For an existing original input, an explicit `access.coordinator` selects its independent
current Runtime reader. For Check, that carrier can stand alone, for example
`{"coordinator":{"hostId":"ORIGINAL_COORDINATOR"}}`, without inventing Source access.
Check reads its frozen key, body, note and API source even
when the Source is unreadable; it never submits or rejoins. A denied or mismatched
Coordinator read does not switch to another channel. Without that selector, Check
uses the original Source read strategy. Start and explicit continuation still
require their original Source admission and current input authority. Start, continuation
and relationship Save do not accept Coordinator-only access.

## File evidence

Grounding checks accept original reference strings and exact file evidence. A string
is the author's citation: a local path has no inferred Host or Workspace and is kept
readable/copyable. To make it openable, read the selected original file using `file read`
and copy its complete `result.resource` plus the returned document/binary revision.
Use `{kind:"file",resource:RESOURCE,revision:REVISION,location:{line:LINE,column:COLUMN}}`
as an evidence entry. `location` is optional; `revision:null` explicitly means no
revision was recorded. Never fill these fields from the Goal's Project, current display,
an assignee or an execution cwd. A file address/revision is not verified success.

For example, first read `file --skill` and `file read --help`, discover the exact
Host/Workspace/Zone, then save that read and the current Goal:

```sh
amux file read --zone ZONE --path result.log --host HOST --workspace WORKSPACE --workspace-path WORKSPACE_PATH > original-file.json
amux goal inspect --goal GOAL > original-goal.json
```

Create the new proposal from those original receipts, retaining every other check:

```sh
python3 - CRITERION <<'PY'
import json, sys
file = json.load(open('original-file.json'))['result']
goal = json.load(open('original-goal.json'))['result']['goal']
assert file['resource'] and file['result']['status'] in ('read', 'binary')
revision = file['result']['document']['revision'] if file['result']['status'] == 'read' else file['result']['revision']
proposal = {key: goal['grounding'][key] for key in ('alignmentRevision', 'summary', 'checks')}
check = next(item for item in proposal['checks'] if item['criterionId'] == sys.argv[1])
check['evidence'].append({'kind': 'file', 'resource': file['resource'], 'revision': revision})
json.dump(proposal, open('grounding.json', 'w'), ensure_ascii=False)
PY
amux goal update --goal GOAL --expected-updated-at ORIGINAL_UPDATED_AT --grounding "$(cat grounding.json)"
```

The same evidence entry is valid inside `goal report --input FILE` under
`report.grounding.checks[].evidence`; retain the original delegation, author and
operation/message IDs. Collection preserves each source. Changed files are identified
as current content, never substituted for the reported revision. A failed read keeps
the original reference and other evidence usable; after an unknown write inspect the
same Goal and operation before any further action.

## Global inspection

goal patrol all --operation-id ID opens one new discussion in the original primary PMO
Mote. Keep its exact original agent.open operation and inspect it with space inspect
--operation-id ID after an unknown reply; never create another discussion to recover it.
Creation, input, actual work and inspection completion remain separate facts.

## Plan

[plan](../shared/goal/plan.md "amux:include")

[patrol](../shared/goal/patrol.md "amux:include")

Read amux goal create --help only when creating or promoting a Goal; that leaf owns the
exact scope, confirmation and source contract.

`goal activity` returns a limited tail plus coverage: original Goal order then append order,
matching Goal and activity counts, limit and truncation. It never claims the tail is full history.
For one Goal use `goal activity history --goal ID [--limit N] [--cursor FILE|-]`. Save the whole
nextCursor unchanged. Its Goal/through/before activity IDs bind a fixed original append-order cut;
new appends do not enter later pages. Missing anchors explicitly expire the read; begin a new read
only when intended. Empty history is an explicit zero-count page. Original full SDK activity reads
keep their semantics, and no history inspection appends an event or replays a business operation.

Aggregate Goal filtering and activity confirmation are two observations: the original Goal list
selects IDs, then their activities are read and file/directory synchronization is confirmed once
under the original Store lock. Coverage names this `selected-goals-then-confirmed-activity` cut;
it does not claim atomic filtering across both observations or an original business-operation ACK.
`goal.activity.collection` is the exact-ID SDK composition read used by this aggregate. It has
no separate CLI because `goal activity` owns the user workflow; it creates no second event Store.
