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

Read the client-owned Agent list order with amux space agent-order --display-workspace WORKSPACE.
With --input FILE|- provide {order:[{hostId,agentSessionId}],expectedOrder?:[...]} to change that
exact Workspace preference. An empty order restores creation order; new Sessions append.
This changes no placement, focus or Run. Applied order and confirmed storage durability are
separate receipts. After a partial/unknown save, read that exact scope before another write.

[spatial](../shared/spatial.md "amux:include")
