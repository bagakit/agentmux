/** Domain guidance shared by local module skill and exact command help. */
export const NATIVE_RESUME_GUIDE = `Discover original Provider conversations with agent native ls --host HOST --executor EXECUTOR.
Query a retained Agent's inputs with agent history --host HOST --session SESSION --source captured|native
--kind user-message --query TEXT. Queries are literal and case-sensitive; --limit counts matches,
--scan-limit counts examined original records. A zero-match page with nextCursor is not an empty history.
Follow that cursor with the same Host, Agent, source and query. Current appends do not move this window.
The typed userMessages retain original source/author/channel facts; Native role=user does not prove Terminal.
Read complete text resources with the original recorded resource API before copying or reusing their full text.
Query leases are bounded readonly snapshots, not a new history ledger. Expiry asks for a fresh first page;
it never removes the Agent or input. Raw non-query history and its exact fragment protocol stay available.
Use --workspace-path PATH to filter their original execution directory; listing starts no Run.
Read saved conversation details with agent native history --input FILE|- using JSON containing
hostId, executorId and that exact source; limit and cursor page the original Provider history.
Follow nextCursor with the same source. Reading and cancellation operate no Session or Run.
Use agent native history resource --input FILE|- for a recorded resource, preserving nativeSource,
source, recordId, turnId, partIndex and expectedReference from that exact page.
Keep partial issues and unsupported availability visible. A managed candidate names the original
AgentMux Session, Executor and Run. Inspect and reuse that Session: attach its healthy Run,
recover its active identity, or agent reopen its exact retired identity. Do not create a duplicate.
For an unmanaged candidate, save only its exact source {nativeHandle,workspacePath,revision}
to FILE and use agent open --executor EXECUTOR --native-source FILE at a discovered destination.
Select --execution-workspace WORKSPACE when display and execution differ. Its Host, directory
and Provider must match the source; presentation placement never changes execution cwd.
Omit --prompt when only continuing the conversation: no user request is invented.
Keep the same --operation-id after an unknown result and inspect space inspect --operation-id ID;
do not relaunch or replay input with new identities. A refused source retains existing work.`
export const GIT_GUIDE = `Discover the original workspace ID, hostId and path with amux app snapshot.
Pass all three to git history, commit, diff and open; an endpoint or current cwd is not that target.
History pages bind fixed roots. Reuse nextCursor unchanged; omit cursor to refresh.
Commit reads return the full message, all direct parents, a chosen-parent snapshot and entries.
Use a complete OID, and preserve snapshot plus both file paths for git diff --input FILE|-.
Reading never checks out, stages or writes Git. git open changes Desktop presentation only;
read and presentation are separate facts. Missing presentation replies remain unconfirmed.
Inspect app snapshot and space inspect for the exact existing Git Region before another open.
Wrong or unavailable targets reject only this request; existing workspaces and Agents remain available.`

export const DIAGNOSTIC_GUIDE = `Read system diagnostics inspect --list for actual injected readers.
For mote.context.client, use --input FILE|- containing the complete typed query.
Freeze scope.hostId/directoryPath from the resource Workspace row in app snapshot --include workspaces,
topicId from Mote discovery, and Tab/reference from app inspect or space ls. A Mote's physical
HomeZone or logical topic directory is not its captured resource Workspace path.
The outer hostId selects the client reader route; scope.hostId can be a different resource Host.
prepare reads one exact resource/Topic/Tab action; open-space additionally requires the complete
captured display reference (or actual null). Do not substitute another occurrence.
These are latest-per-scope-action observations, with original action/failure times, not historical
logs or Agent health. Default raw stays withheld before IPC; explicitly requested original text
requires original source authorization and fits the query budget. No retry, focus or Run starts.`

export const SPATIAL_GUIDE = `## Delegation and opening playbook (advisory)
"subagent" can mean Provider-native delegation or an independent AgentMux Session.
Choose from the user's purpose, available context and capabilities, how results return,
whether they need to see or continue the collaborator, and any specified Executor,
Host or execution Workspace. Briefly explain a clear choice; clarify material ambiguity.
Native delegation often suits a check within the current collaboration; an independent
Session often suits a directly accessible, continuing collaborator or another Executor/Host.
Hierarchy does not select the mechanism. Reuse a suitable exact Session when appropriate.
Neither mechanism guarantees complete context inheritance: check actual native fork or
delegation support and supply the relevant task, evidence and expected result.

Before opening an Agent or file, inspect your actual position and the intended Tab's
whole visible layout; your attached Region may be in the background. Keep exact display
Workspace/Group occurrences separate from execution cwd and file Zone/path.
For simultaneous comparison, consider a same-Tab split: left/right needs readable width
on both sides; up/down keeps more width but reduces reading height. Consider a new Tab
for a full workface, an independent task, long reading, or an already crowded layout.
Choose the exact anchor and direction from content and current geometry, rather than
always splitting right. Preserve existing content, readable text/actions and later human focus.

For web pages, prefer AgentMux's embedded Browser and public CLI. Reuse the exact Browser
already confirmed for this task; discover available targets with browser targets and read
the typed Browser identity with space inspect rather than choosing an unrelated page.
If a new page is needed, inspect your own actual Tab/Region and the whole Tab's visible
layout, then prefer a directional Region in that same Tab so the Agent and page stay
readable together. Choose the direction from actual geometry and content.
A crowded layout, a full workface for reading, an unsuitable capability or a user-specified
Browser/tool can justify a related new Tab or the specified tool; briefly explain the
reason and location. Placement does not authorize replacing existing content, changing
focus, taking human control or bypassing refusal. Keep the original page, user input and
unknown operation receipts; confirm the returned Browser, Tab, Region and navigation receipt.

Related Tabs usually belong in the same appropriate display Group; consider proximity
to your own Tab and inspect the real order. Agent/File new Tabs append to that Group;
they do not offer before/after Tab flags. Do not copy another object's placement options.
If immediately-after placement is needed, a split followed by promoting its confirmed
new Region is an option only when the current display matches a single owner Group.
It temporarily changes layout and activates the new Tab; it is not a routine default,
cannot choose among multiple display occurrences, and must not move a reused old File Region.
Keep original content and execution ownership; proximity does not justify moving directories.

Background preparation usually preserves navigation/input. When the user intends to
read the opened content, choose the appropriate navigation explicitly; selection and
input focus are separate. Briefly name the mechanism and intended location before
opening, then confirm the returned identity, actual Tab/Region/order and navigation.
These are advisory strategies, not fixed directions, size thresholds or additional approval gates.

## Read an amux object link
An amux:// link carries one exact object identity, not a command, permission or sender credential.
Use the public @agentmux/core/sharing parseAmuxObjectLink helper to decode its URI path segment
without trimming or changing the original ID. Supported kinds are agent, region, tab, space and zone.
For amux://agent/<SID>, use agent inspect --session SID or agent send --to-session SID --text TEXT.
For the other kinds, use space inspect with --region, --tab, --space or --zone and the decoded ID.
Discover current Agent display positions with space ls; keep all original location candidates.
To navigate the Agent, choose an exact existing Region and display occurrence, then use
space focus --region REGION --display-workspace WORKSPACE --group GROUP --expect-session SID.
The expected Session is a condition on that Region, not a replacement for its spatial identity.
Other object links use space focus with their exact selector; ambiguous references require
an explicit location. Default input is preserve. Missing positions do not prove a Session ended.
Inspect unknown results before another action; do not start a replacement Agent to open a link.

## Choose a split from the visible layout
Read the exact presentation with amux space inspect --region REGION before choosing
where to open. Decide from the visible view so both the old and new content stay readable
with the least disturbance. Use the registered --region and --split destination options:

amux agent open --executor EXECUTOR --region REGION --split right --prompt TASK --operation-id OPERATION

Before opening a configured executor, use amux settings executors ls to find its exact ID.
For a remote execution target, use amux settings executors discover --host HOST and
choose that Host's Executor ID. For a new remote Agent below the local view, select its saved
Workspace independently:

amux agent open --executor EXECUTOR --execution-workspace WORKSPACE --region REGION --split down --prompt TASK --operation-id OPERATION

Split directions are left, right, up and down.
Opening a split and navigating to an existing Tab are separate operations.

## Open a file beside an exact Region
amux file open --path PATH --zone ZONE --tab TAB --region REGION --split right --display-workspace WORKSPACE --group GROUP --operation-id OPERATION

The Tab, anchor Region, direction (left/right/up/down), Display Workspace and Group
are one exact destination. Omitting the Tab/Region/split tuple selects the new-Tab
destination path, which may reuse an existing matching File presentation.
The reply names the actual File Region; the anchor is not the new Region's identity.
File opening stays in the background unless --focus is explicit.

## Choose a new Tab for a complete workface
amux agent open --executor EXECUTOR --zone ZONE --new-tab --display-workspace WORKSPACE --group GROUP --prompt TASK --operation-id OPERATION
amux file open --path PATH --zone ZONE --display-workspace WORKSPACE --group GROUP --operation-id OPERATION

Choose the actual Zone/resource and exact display Group. Omitting the Tab/Region/split
tuple selects the File new-Tab destination path, which may reuse an existing matching
presentation; File does not take the Agent's --new-tab flag.
Inspect the returned order rather than claiming that the new Tab is beside your own.

## Move a Region into its own Tab
amux space promote --region REGION --operation-id OPERATION
amux space mv --from-region REGION --expect-session SID --zone ZONE --new-tab --operation-id OPERATION

promote and mv move an existing presentation; they do not duplicate it or change the
execution cwd, Host, Session or Run. A move never starts, stops, or restarts a Run.
For mv, use --from-display-workspace and --from-group if the source Region has several
display placements. Name the exact source; do not choose the first location from a SID.

## Read what is in a direction
Read the Region's actual neighbors with amux space inspect --region REGION.
A split in that direction names the visible Region beside you. When nothing is split there,
left and right may name an adjacent Tab. These are not the same place.
Up and down never name a Tab. No neighbor is an explicit answer, not a failed observation.

## Confirm the actual destination
After opening an Agent or File, inspect the returned exact identity and actual locations.
An Agent's to and a File's placement/locations describe the result, not the anchor Region.
Confirm the requested direction or Tab order and whether navigation/input changed;
created, displayed, readable and focused are distinct facts.
After any move inspect the result to confirm where it landed, using the returned exact
Region and display placement. Use --display-workspace and --group when the presentation
needs those selectors; a resource ID alone does not prove a unique display location.
For a lost or unknown Agent creation/move reply, read amux space inspect --operation-id OPERATION first.
For File open, retain its operation and inspect the original file resource and actual File Regions;
operation inspection does not certify its missing original receipt. Today's display does not
prove a past submission. An unknown operation remains unconfirmed; do not blindly retry
the move or create another Agent.`

export const DEVICE_GUIDE = `Device ls/link/revoke require a local Unix user; managed Agents and remote clients cannot administer devices.
Device link returns the current complete public offer URL; open it on a phone on the same local network.
Device hello names only the device bound to its completed encrypted handshake.
No pairing code, local OS approval or certificate installation is part of the connection flow.
After a missing revocation reply, read amux device ls and compare the exact deviceId facts.
Never automatically replay a device revocation.`

export const AGENT_OPEN_WORKFLOW = `Agent-first workflow:
1. Inspect Project resources and the intended Space separately with app snapshot and space inspect.
2. Choose a split or a new Tab from the advisory playbook. For a new Tab in an existing Zone,
   use agent open --zone ZONE --new-tab --executor EXECUTOR --prompt TASK.
3. To create a Zone, supply --project PROJECT --space SPACE --new-zone and either
   --worktree --path PATH --new-branch BRANCH or --directory PATH. If a Project's source
   is ambiguous, inspect its real Workspaces and explicitly pass --source-workspace WORKSPACE.
4. Retain the exact business operation ID, returned SID/Run and spatial address.
5. Use agent inspect, agent output and agent send for follow-up. Delivery is not completed work.
6. After a lost Agent creation/move reply, read space inspect --operation-id ID;
   for File open, retain the original resource and inspect its actual Regions as above.
   An unknown original operation stays unconfirmed; do not blindly repeat.

space mv moves a presentation and leaves the original execution cwd/Host/Session/Run intact.
Default Agent/File opens and presentation changes keep background navigation and eligible input.
app focus selects a Surface; space focus and goal focus navigate exact objects. Selection,
presentation and actual caret eligibility are separate facts. Never stop a healthy Run to repair
an observation or handshake. Reader cancellation only detaches that reader.`

export const GOAL_ACTIVITY_GUIDE = `goal activity reads the original Goal activity owner. Goal IDs and saved content retain their
original durable identity. goal activity append requires --kind, --message and an original
--operation-id; the authenticated caller supplies the author. Keep that operation ID and use
goal activity inspect after an unknown response. Same operation and payload reads the same
activity; changed content or author conflicts. Neither append nor inspect sends Agent input.`
