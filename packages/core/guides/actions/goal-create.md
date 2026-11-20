# goal create

<!-- amux:content -->
Project identity must come from app snapshot, never a Space or Workspace ID.
The original Goal owner records routing risk (low/medium/high/unknown), confirmation
(automatic/user/pending), wikiVersion, the verified caller and its actual recording time.
Defaults risk=unknown and confirmation=pending do not authorize a write. Carry the scoped
authorization actually given; never invent user confirmation or an automatic policy.
These fields do not accept Goal alignment or results, which remain human actions.
Project is optional: omit --project to keep the Goal unassigned. An explicit unknown Project is refused.
Hold an exact optional --goal ID before creating. Read goal inspect --goal with that same ID after
an uncertain save; do not title-match, replay create or generate another ID. Duplicate IDs are refused.
Only an explicit save after the original owner confirms absence may use that same ID again.
goal create/update --content-refs JSON records exact {hostId,workspaceId,zoneId} content provenance, independently of executing Session links. Updates append sources atomically. Use goal update --expected-updated-at MS from goal inspect when adding existing associations; a conflict requires reading the same Goal again. Unknown writes are inspected with the original Goal ID before any explicit retry.
goal discuss --mode open opens the dedicated main Mote Tab without another Prompt; grill, grounding and plan
admit real requests through the original queue. Tab/Session navigation does not mean Prompt acceptance.
plan asks the Supervisor to save a dependency plan to this same Goal. Use goal plan append for new
Tickets and goal plan revise for changes to existing nodes. A current
proposal allows planning before human confirmation; a missing proposal requires real clarification first.
Only the actual Supervisor or a person can revise the plan. Discussion does not grant that role, start
work, confirm the Goal or accept results. A request receipt is not a saved plan: read goal plan afterwards.
Keep the original --operation-id and exact recipient after an unknown discussion result; inspect that
same input rather than minting a replacement request.
goal confirm/accept require a transport-approved human/device and exact proposal/result CAS identities.
