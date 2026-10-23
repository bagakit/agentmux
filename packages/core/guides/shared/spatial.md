# spatial

<!-- amux:content -->
## Delegation and opening playbook (advisory)
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
For an unspecified Browser request, start from your own exact Tab and first consider
this task's same-Tab neighbor Regions.
Inspect that exact Tab's typed Browser bindings before choosing; a title, recent use or
human focus does not identify the intended page or grant control. Do not treat a vague
request as an instruction to create a page. Keep multiple candidates or an unknown task
relationship explicit and clarify only ambiguity material to the requested operation.
Honor an exact target or the user's specified tool.
If a new page is needed, inspect your own actual Zone/Tab/Region and the whole Tab's visible
layout, then prefer a directional Region in that same Tab so the Agent and page stay
readable together. Choose the direction from actual geometry and content.
When the user has not specified a position and both stay readable, prefer the Agent's
right side and adjust the Browser's share to the content; this is not a fixed direction
or size rule for an unsuitable layout.
Focus may show only the selected Tab or Region; a new Tab may be outside the current reading
view and be harder to find. Creation alone does not confirm that the person sees the page.
An explicit new-Tab request, an independent task, a crowded layout, a full workface for
reading, an unsuitable capability or a user-specified Browser/tool can justify a related
new Tab or the specified tool; briefly explain the reason and actual location. A prototype
or screenshot alone does not justify a new Tab. Placement does not authorize replacing existing content, changing
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
without trimming or changing the original ID. Supported kinds are agent, region, tab, space, zone and capsule.
For amux://agent/<SID>, use agent inspect --session SID or agent send --to-session SID --text TEXT.
For spatial kinds, use space inspect with --region, --tab, --space or --zone and the decoded ID.
For amux://capsule/<ID>, read capsule --skill and use capsule inspect with JSON {capsuleId:ID}.
Request display through capsule open with the same ID and an original operationId; its page
owner resolves the service before Browser presentation. A Capsule is not a spatial selector.
Discover current Agent display positions with space ls; keep all original location candidates.
To navigate the Agent, choose an exact existing Region and display occurrence, then use
space focus --region REGION --display-workspace WORKSPACE --group GROUP --expect-session SID.
The expected Session is a condition on that Region, not a replacement for its spatial identity.
Spatial object links use space focus with their exact selector; ambiguous references require
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
the move or create another Agent.
