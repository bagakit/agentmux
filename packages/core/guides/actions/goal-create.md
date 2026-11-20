# goal create

<!-- amux:content -->
Project identity must come from app snapshot, never a Space or Workspace ID.
The original Goal owner records routing risk (low/medium/high/unknown), confirmation
(automatic/user/pending), wikiVersion, the verified caller and its actual recording time.
Defaults risk=unknown and confirmation=pending do not authorize a write. Carry the scoped
authorization actually given; never invent user confirmation or an automatic policy.
These fields are routing provenance. Proposal confirmation and result acceptance
use their own commands.
Project is optional: omit --project to keep the Goal unassigned. An explicit unknown Project is refused.
Pass a stable `--operation-id` and use the Goal ID and link returned by the original
owner. After an uncertain save, use `goal inspect --creation-operation OP`.
If the original owner confirms absence, explicitly retry the same creation operation.
Use `--content-refs JSON` on create or update to record exact
`{hostId,workspaceId,zoneId}` content sources. To append sources to an existing
Goal, use `goal update --expected-updated-at MS` from the original read. Read that
Goal again after a conflict or uncertain update.
goal discuss --mode open opens the dedicated main Mote Tab without another Prompt; grill, grounding and plan
admit real requests through the original queue. Tab/Session navigation does not mean Prompt acceptance.
plan asks the Supervisor to save a dependency plan to this same Goal. Use goal plan append for new
Tickets and goal plan revise for changes to existing nodes. A current
proposal allows planning before confirmation; a missing proposal requires real clarification first.
Only the actual Supervisor or a person can revise the plan. Discussion does not grant that role, start
work, confirm the Goal or accept results. A request receipt is not a saved plan: read goal plan afterwards.
Keep the original --operation-id and exact recipient after an unknown discussion result; inspect that
same input rather than minting a replacement request.
See goal confirm and goal accept for the exact revision, authority and result identities.
