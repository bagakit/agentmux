---
summary: "Goal plans, workflows, execution responsibility, reports and PMO patrol"
roles: "Executors, managers and people confirming or accepting work"
when: "Discuss, execute, supervise, inspect or report on a Goal"
---

# goal

<!-- amux:content -->
Start with `goal inspect --goal ID` for the original Goal, its current criteria and result.
Use `goal plan --goal ID` for dependencies and current delivery attempts, or
`goal delegations --goal ID` for original assignments, reports and execution responsibility.
Read the chosen command's `--help` for exact inputs.

## Plan and review

[plan](../shared/goal/plan.md "amux:include")

## Execution and management

[contract](../shared/goal/contract.md "amux:include")

## Open or share the original Goal

Copy `goal.address.goalUrl` or `planUrl` from `goal inspect`. Bound Goals have a
short link. The reading owner checks the original creation binding when opened.
If `addressIssue` is present, recheck the original source before sharing.

<!-- amux:generated command:goal.focus -->

Pass both `--runtime` and `--namespace` from the address when targeting another
source. `--section plan` opens the original plan, including its empty state.
Check both navigation and `presentation.goal`. Opening the view only reads.

## Assign or start work

Use `goal create --help` and `goal update --help` for creation, confirmation
provenance and relationship edits. Assignment alone does not send input.

The current Supervisor uses `goal confirm --goal ID --revision N` to record
its own confirmation and continue work already authorized. Read `goal inspect`
for the current revision and saved confirmer.

A person can use `goal confirm --goal ID --revision N --continue-with JSON --operation-id OP`
to confirm the displayed version and ask its original Supervisor to continue.
`JSON` is `{hostId,agentSessionId}`. Read `goal inspect` for the saved confirmation
and `goal delegations` for its notification receipt. Keep the original operation after an
unknown response. A continuation notice asks the Supervisor to read that exact Goal, confirm
its current version and role, and advance its current plan.
Related, assignee and Supervisor fields accept a Session string or a qualified member:

```json
{"kind":"space-member","source":{"runtimeId":"SOURCE","spaceId":"SPACE","regionId":"REGION","admission":{"kind":"creation","operationId":"ADMISSION"}},"execution":{"runtimeId":"EXECUTION","agentSessionId":"SESSION"}}
```

For an independent association, use its original `admission.kind: "association"`
and operation. Read the member and admission through the original `space inspect`
or snapshot. Use the full reference in `--relation-access`, with
`{reference:REFERENCE,access:{source:{hostId:HOST}}}` per newly added relation.
The Source carrier may include its configured `via:{routeId,adoptedRoute}`.
Access is for this call. Saving an unchanged relation does not recheck it remotely.
Saving a new relation verifies the original Source admission, independent of Run liveness
or Coordinator availability.

For a finite task use `goal start --agent-ref JSON --access JSON` with the original
assigned reference and current Source carrier. An independent association also needs
its authenticated Coordinator carrier. Start saves the original request before using
Core controlled input. `requested` has the Goal version, member and body, without
a prepared Run or input. `rejected` records an exact version or assignee refusal.
After reading that refusal, prepare a new operation only for an explicit new task.

If the result is uncertain, keep OP and read
`goal inspect --goal ID --dispatch-operation OP [--access JSON]`. Check sends nothing.
For a saved original request, explicitly continue with
`goal start --goal ID --agent-ref JSON --access JSON --operation-id OP --resume-original`.
Use the same original content and Source with current access. Core reuses the original
waiting input when present. A plain repeated Start only checks already submitted input.
A missing read does not establish that input was never sent.

When checking an existing original input, `access.coordinator` may stand alone,
for example `{"coordinator":{"hostId":"COORDINATOR"}}`. It reads the original Core
input even when the Source is unreadable. Denied or mismatched access stays with that
reader. Start, resume and relation saves still need their Source access.
Read these states from the serving owner. A recognized command does not establish that a
remote owner supports it or that an input acknowledgement proves Run health.

## Cite file evidence

For an openable Grounding or delegation report citation, read the exact file with
`file read --zone ZONE --path result.log --host HOST --workspace WORKSPACE --workspace-path ROOT`.
Use `{kind:"file",resource:RESOURCE,revision:REVISION,location:{line:LINE,column:COLUMN}}`.
Copy the complete returned `resource` and document or binary revision.
`location` is optional and `revision:null` records an unspecified revision.
A plain citation string remains readable without an inferred Host, Workspace or file revision.
When adding to existing Grounding, keep its alignment revision and other checks, and use
`goal update --expected-updated-at` with the original read. A later file revision is current
content. Keep the cited revision and other evidence when a read fails.

## Read activity or run an inspection

[activity](../shared/goal/activity.md "amux:include")

`goal patrol all --operation-id ID` opens an inspection discussion in the original primary
PMO Mote. Check an uncertain result with `space inspect --operation-id ID`. An open
discussion or delivered input does not establish inspection completion.

[patrol](../shared/goal/patrol.md "amux:include")
