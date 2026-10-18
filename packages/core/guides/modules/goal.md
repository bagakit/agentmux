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

[contract](../shared/goal/contract.md "amux:include")

[activity](../shared/goal/activity.md "amux:include")

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

[patrol](../shared/goal/patrol.md "amux:include")

Read amux goal create --help only when creating or promoting a Goal; that leaf owns the
exact scope, confirmation and source contract.
