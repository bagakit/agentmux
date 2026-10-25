---
summary: "Durable spatial identities, display layout and exact navigation"
roles: "Agents opening, arranging or navigating workfaces"
when: "Inspect a visible layout or move an exact presentation"
---

# space

<!-- amux:content -->
Core owns durable Space/Zone/Tab/Region identities, topology and bindings; the client
owns presentation, navigation and input focus. Inspect exact locations and display
Workspace/Group occurrences before changing a layout. A presentation move leaves execution
Host, cwd, Session and Run intact. Keep original operation receipts and all location candidates.
space inspect --operation-id reads the original creation even after its Agent is closed: retired
reports its original Session/Run and retirement fact, not a missing creation or a live Agent.
Inspection never creates or reopens. A newly authorized takeover after retirement needs a new
operation ID; keep the previous receipt. Unknown results always keep their original operation.

For a new Agent, `amux agent open --executor ID --execution-workspace AGENT_WORKSPACE
--tool-workspace RESOURCE_WORKSPACE --zone ZONE --new-tab` keeps the Agent Run location
separate from the project/tool resource and display destination. Both Workspace references must
be explicit; this mode requires a transport-authenticated user/device without a managed Agent
caller. It cannot be combined with native resume, fork or new Zone resources. Spatial receipts
retain the original Session toolExecution binding alongside its Agent Host/cwd; moving its
presentation or inspecting it never changes either execution identity.

Read the client-owned Agent list order with amux space agent-order --display-workspace WORKSPACE.
With --input FILE|- provide {order:[{hostId,agentSessionId}],expectedOrder?:[...]} to change that
exact Workspace preference. An empty order restores creation order; new Sessions append.
This changes no placement, focus or Run. Applied order and confirmed storage durability are
separate receipts. After a partial/unknown save, read that exact scope before another write.

Read the connected client Survey list with amux space survey-list. Global
space ls --presentation includes the same organization and all original items,
even inside collapsed groups. Groups organize Zone references only; they are not
spatial Tab Groups. With --input FILE|- provide {organization:{ungrouped:[ZONE],
groups:[{groupId,name,collapsed,zoneIds:[ZONE]}]},expected:originalStoredOrganization}.
Use exact saved Zone and list-group IDs, each item once. Create, rename, collapse,
dissolve and reorder by replacing that organization at its exact expected value.
Organization writes preserve membership; omitted members return to ungrouped.
Read collectedZoneIds from the same list. Explicit collection/restoration uses
{collection:{zoneIds:[ZONE],expectedZoneIds:originalCollectedZoneIds}}. These IDs
are a set; organization still owns order. New members require a confirmed exact
Zone; an unavailable saved member can remain. Both changes can share one atomic
input. Never infer original membership from all Browser/Tab topology. Content,
selection, layout, cwd and Runs stay unchanged. Applied preferences and disk confirmation
are separate. After a partial or unknown save, read this same list before changing it.
A missing client owner is unavailable, never an empty confirmed list.

[spatial](../shared/spatial.md "amux:include")
