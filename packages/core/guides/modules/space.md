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
A Project is a repository or directory resource, not a Space. A Zone may hold a Git worktree,
a plain directory or a Topic/Mote workface. One Session may have several display positions;
use IDs verbatim and never infer identity from a name, cwd or the first display position.

For a shared business Space, keep its original {runtimeId,spaceId} and select an
already authorized RPC endpoint to that authority. Host labels, a current local route,
and an identical Space ID on another Runtime are not replacements.

For an already configured Folder on the selected authority, explicitly register its
original Space/Zone before mounting it. Read that Host's original Workspace metadata
and freeze {hostId,workspacePath,projectRootPath}; a later resource change rejects this
registration rather than substituting another directory. Labels are not resource identity.

<!-- amux:generated command:space.folder.register -->

For an unregistered directory, first observe that exact Source Runtime and absolute path.
The original Files owner verifies a real directory and returns its physical witness,
current original registrations or a typed unavailable/refusal issue. Inspection is read-only;
a path string or a Node-published root is not an execution or sharing grant.

<!-- amux:generated command:space.folder.inspect -->

An explicit register may use the full {runtimeId,directory,workspaceId?} request, retaining
the exact returned directory and witness. Only the transport-approved original user/device
may admit a new root. The Source rechecks the physical directory at admission, reuses
existing configured or graph IDs, and refuses ambiguous candidates until one original
Workspace is explicitly selected. Newly allocated IDs come only from that Source.
The same spatial owner retains Core-only resource facts; Host snapshot, Files and the
ordinary Folder sidebar read those facts without writing Desktop configuration.
Directory admission changes neither Node sharing nor another Core's execution rights.

The configured registration path above remains unchanged. Both forms return the original
reference, Zone, resource and durability. If a reply is unknown, keep the complete original
request. For directory admission inspect the same Source path with the frozen
expectedResource; for a configured resource read space ls and match its exact original
Folder, Zone and binding. A current match is an object observation, not the lost write ACK.
Never automatically repeat registration, mint a replacement identity or substitute current
configuration. Existing conflicting entities, names, layout, drafts and Runs remain intact.

New work in that Space returns to the original authority. Without an explicit Agent
target, that authority uses its own Agent. For a directly configured Agent Core, read
settings executors discover --host HOST on the Space authority and retain its Runtime
identity. agent open --executor EXECUTOR --agent-host HOST --agent-runtime RUNTIME
with the original --space/--zone and --new-tab selects only the Agent location. HOST
belongs to the answering Space Core's namespace, not the observing client's namespace.
The project remains in its original Zone; the remote Agent starts in its own home and
uses the original execution binding for project tools. Both placements are frozen
independently. This explicit target is for new work, not moving an existing Session,
changing a frozen creation or granting access to a different Core. Source/Agent trust
and transport permissions still apply. An unknown result retains the same operation;
inspect it before an explicit continuation and never send its first input again.

<!-- amux:generated command:space.snapshot -->
<!-- amux:generated command:space.watch -->
<!-- amux:generated command:space.apply -->

Snapshot prints one complete decoded business projection and exits. Watch first returns
that same scoped snapshot with any explicit resnapshot gap, then ordered entity deltas.
The SDK equivalents are readSpaceSnapshot and observeSpace over the original public
subscription port. Their begin/part/complete transport reuses the existing framed carrier;
cumulative Space size is not a single RPC-frame or whole-observation value limit.
A revision is this source graph's CAS revision, so unrelated writes may advance it.
A cursor is not a retained event-history promise: reconnect starts an explicit snapshot.

<!-- amux:generated command:space.sessions.watch -->

Session state uses this separate related reader. The SDK observeSpaceSessionStates
returns the original Space opening, then source-qualified member summaries, exact
missing/unavailable observations, membership removal and original process events.
The Space Core selects only its members; each Session Core answers for its exact
Runtime and SID. A source-local Host alias never means the observer's local machine.
This stream does not preload terminal output or history, grant input, or change
private window layout. Metadata missing does not remove a business member. Retain
the last confirmed view when disconnected, then reopen the same Space reference;
this read never retries creation or its first input.

Member observations may include source-owned `occurrences`, one for each exact Region.
Each retains its original creation operation reference, confirmed project/Agent Runtime
and either the adopted execution chain, confirmed same Runtime or unconfirmed relation.
Match that Region before presenting a path. The route used by the viewing client to
reach this Space is a separate access fact; do not append it to the execution chain.
Several Regions can reference the same Session through different original chains.
Their paths stay separate; ambiguous metadata authority does not remove those members.
Old or unreadable admissions remain unconfirmed, never inferred from current Host
configuration, labels or the available Agent choices. These path facts grant no input.

Read settings hosts ls on the Space authority for its configured Agent choices,
then use that same authority's settings executors discover for the selected Host.
Configuration labels and saved Runtime pins are separate from live executor facts.
An optional choices read must not delay opening the original project or using its
default Agent. An unavailable catalogue never substitutes the observing client's Hosts.

The shared scope contains only Space/Zone/Tab/Region membership, original Session/Run
references and Zone–Space bindings. Host references retain that source Runtime's namespace;
do not use its local string as this client's local machine. Session references do not
prove a Run is currently healthy or grant input permission. Window groups, ratios,
selection, focus, opaque client resources and unsent drafts remain with their original
owners and are neither overwritten nor uploaded by this business projection.

Apply accepts exact business upserts, an optional complete binding list for this one
Space, and explicit removal IDs at --revision. It merges into the original source graph;
a filtered snapshot is not a replacement graph. Unrelated Spaces and existing window
records are retained. Name changes and creation associations keep their existing mutation
owners; opening/creating Agents still uses the original agent.open authority. Keep both
edits on conflict, and after an unknown write read the same source without automatically
repeating it. Unavailable observations retain the last confirmed Space and original
identities; cancelling a reader does not stop a Session, Run or execution helper.

space mv refuses a Region whose Tab has several display occurrences
(SPACE_MOVE_MULTIPLE_OCCURRENCES_UNSUPPORTED) and keeps every reference and the healthy Agent;
remove a display binding separately. space unbind of the last display reference never closes
or deletes the entity; an explicit Close is separate. space swap exchanges two Regions of the
same Tab across all its presentations and keeps Session, Run, cwd, documents, drafts, split
ratios and the logical active Region. Cross-Tab, closing or ambiguous targets are refused
before anything changes, and swapping a Region with itself returns unchanged. space focus
--expect-session keeps that condition in the receipt as navigation.expectedAgentSessionId.
Add --expect-host HOST with --expect-session to check the original Agent Host as well; the
receipt preserves navigation.expectedAgentHostId. These conditions grant no Agent access.
Presentation operations do not take input by default; if the original input loses
eligibility, the receipt is partial with that input issue and keeps the applied result.
Only save.diskDurability: confirmed is a durable save.

For a new Agent, `amux agent open --executor ID --execution-workspace AGENT_WORKSPACE
--tool-workspace RESOURCE_WORKSPACE --zone ZONE --new-tab` keeps the Agent Run location
separate from the project/tool resource and display destination. Both Workspace references must
be explicit; this mode requires a transport-authenticated user/device without a managed Agent
caller. It cannot be combined with native resume, fork or new Zone resources. Spatial receipts
retain the original Session toolExecution binding alongside its Agent Host/cwd; moving its
presentation or inspecting it never changes either execution identity.

Read the client-owned Agent list order with amux space agent-order --display-workspace WORKSPACE.
With --input FILE|- provide {order:[{hostId,agentSessionId}],expectedOrder?:[...]} to change that
exact Workspace preference. Confirmed derivation trees stay adjacent, parent before descendants;
moving any member orders its whole tree. An empty order restores automatic order: startup order
with observed A2A peers nearby. Saved manual groups retain precedence; new groups follow them.
effectiveOrder includes confirmed retained members; the GUI's + Closed checkbox only filters
presentation. Relationship observation gaps remain issues, never permission to stop an Agent.
This changes no placement, focus or Run. Applied order and confirmed storage durability are
separate receipts. After a partial/unknown save, read that exact scope before another write.

Survey is Know's browsing and research entry. It retains whole research Zone references
and exact page references {regionId,browserId} through one client preference owner.
Read the connected client's Survey list with amux space survey-list. Global
space ls --presentation includes the same organization, whole Zone items and exact
pages, even inside collapsed groups. Manual groups organize Zone references only; they are not
spatial Tab Groups. With --input FILE|- provide {organization:{ungrouped:[ZONE],
groups:[{groupId,name,collapsed,zoneIds:[ZONE]}]},expected:originalStoredOrganization}.
Use exact saved Zone and list-group IDs, each item once. Create, rename, collapse,
dissolve and reorder by replacing that organization at its exact expected value.
Organization writes preserve membership; omitted members return to ungrouped.
Manual pins are a separate presentation preference in the same owner. Read
pinnedReferences, then use --input with {pin:{reference:{kind:"zone",zoneId:ZONE},
pinned:true,expectedPinned:false}}, or {kind:"page",regionId:REGION,browserId:BROWSER}
for an exact page. Unpin with pinned:false and its current expectedPinned. Ordinary
system links never imply a pin. Pinning keeps membership, original organization,
resources and inputs; unpinning returns to that original organization. Known saved
items can be unpinned even while their source is unavailable. Partial reads retain
unread neighboring preference records; inspect the original list and repair only
the exact preference after an unknown save, without reopening or moving content.
Read collectedZoneIds from the same list. Explicit collection/restoration uses
{collection:{zoneIds:[ZONE],expectedZoneIds:originalCollectedZoneIds}}. These IDs
are a set; organization still owns order. New members require a confirmed exact
Zone; an unavailable saved member can remain. Both changes can share one atomic
input. Never infer original membership from all Browser/Tab topology. Content,
selection, layout, cwd and Runs stay unchanged. Applied preferences and disk confirmation
are separate. After a partial or unknown save, read this same list before changing it.
A missing client owner is unavailable, never an empty confirmed list.

Survey presentation also reports profileView as {kind:"default"},
{kind:"profile",profileId}, or null when the original view is unconfirmed.
An unconfirmed view does not assert a default login environment. This is the connected client's browsing view and next
page choice, not the Profile bound to every visible Browser or a grant of input
permission. Read each actual page's Main-confirmed Profile. Changing the view does
not rebind, reload or copy live pages; mixed whole research keeps its original scope.

Read pageReferences from that same list. To change only precise page membership use
{collection:{pageReferences:[{regionId,browserId}],expectedPageReferences:originalPageReferences}}.
Each changed scope requires its matching expected set; omitted scopes stay unchanged.
Pages and Zone membership can share one input. New page references must match the original
Region's actual Browser; unavailable saved references may remain. Current Tab/Zone and
placement come from Core, not saved display coordinates. A replacement Browser in the
same Region does not inherit the original reference, and missing placement never expands
its scope to the entire Zone. Closing a Survey reference leaves the page and task intact.
Opening a page with an explicit Profile admits only that confirmed page; default/private/Capsule task
pages, discovery and cold restoration do not auto-admit pages. Survey's explicitly created
default pages still belong through their own creation intent. Read and repair the original
reference after an unknown save; do not reopen the Browser or overwrite unobserved members.

A Host's home workface opens from its exact homeDirectory, read with settings hosts home
--host HOST; amux settings --skill owns that read. Retain the returned Host/path and never
expand a remote ~ with local environment facts. Opening an existing home reuses its durable
Folder/Zone/Tab work and does not change any Session cwd or create an Agent.

[spatial](../shared/spatial.md "amux:include")

## Save a Category or ordinary Topic avatar

`space object avatar read --input FILE|-` reads an exact original target and its current
appearance revision. Category targets are `{kind:"category",categoryId,objectKey}`;
ordinary Topic targets are `{kind:"topic",workspaceId,topicId,objectKey}`. Use the IDs and
content key from the original Topic/Category owner. `topic category ls` returns
`categoryId` and `spaceId`: use `spaceId` as the Category `objectKey`. For an ordinary
Topic, run `topic inspect --topic ID`; require its actual `contentKind:"topic"`,
`workspaceId` and `contentIdentity`, then construct:
`{kind:"topic",workspaceId:topic.workspaceId,topicId:topic.topicId,objectKey:topic.contentIdentity}`.
The optional identity fields can be unavailable; keep the target unknown in that case.
Do not decode `zoneId` or derive a key from `directoryPath`, a title or the caller's cwd.
For example, feed `{target:{kind:"topic",workspaceId:"RETURNED_WORKSPACE_ID",topicId:"RETURNED_TOPIC_ID",objectKey:"RETURNED_CONTENT_IDENTITY"}}`
to `space object avatar read --input -`, replacing all values from that same inspection.
Reading never uploads, publishes or repairs a missing directory.

For a semantic icon or reset, use `space object avatar save --input FILE|-` with
`{target,beforeRevision,choice:"book"}` or `choice:null`. These are ordinary configuration
CAS edits, including for an authenticated Agent. They have no asset operation or historical
ACK. Inspect the same current value after an unknown save; do not infer that the old write
was acknowledged. Confirmed remote object identities can use icon/reset even where this
Desktop cannot write their image files.

A PNG crop is one complete publication: `{target,operationId,beforeRevision,
choice:{kind:"png",dataUrl:"data:image/png;base64,..."}}`. It uses the existing local object
image directory and the original configuration owner. Supply the exact bounded static
256×256 PNG; the service validates its bytes, and does not render an image on your behalf.
The trusted transport fixes the original actor; actor/principal fields are not input.
Keep the complete original request. Read `{target,operationId}` to inspect that publication.
`readerIdentity` identifies this trusted query; `operation.actor` identifies the original
publisher. A saved asset ACK must bind that reader to the original actor and the hash of
the complete original request, including its target, baseline, operation and PNG. Another actor’s matching payload or operation is historical evidence, not this
caller’s submission confirmation. A direct internal Mote history read without trusted
context has no reader identity; old actorless history never acquires the present reader.
`publication-unknown` and unconfirmed durability remain unknown even when current values
look equal. Do not repeat it with a new operation ID. A later separately chosen appearance
needs an explicit fresh intent and the currently inspected baseline; retain the old request.
Old Mote publication records without an actor remain readable with unavailable attribution;
reading cannot attribute or resume them as the present caller. These avatar operations do
not create, replace, stop or change the execution directory of any Agent.

## Interact with one mounted member

Use `connectSpaceMember(rpc, target)` from `@agentmux/core/space-member-client` for an original Hosted full Session and its existing terminal/input machinery. The target contains the original Space reference, Region, execution Runtime, Session and expected Run. Its membership and frozen route remain at the source Core; the execution Core separately authorizes the current viewer. The client never imports that Session into another Core’s local namespace.

`space member call --input FILE|-` and `space member watch --input FILE|-` expose the same finite protocol. The JSON envelope is `{target, call:{method,params}}`; inner parameters retain the existing Hosted owner fence, consumer, exact Session/Run and original input operation. Calls allow exact metadata, terminal attachment/replay/resize, raw Agent input, prompt submission and original input/interaction inspection. Watch allows only the selected Session events or terminal/replay stream. No inventory, new Agent, stop/recovery, history, A2A or native human approval is included. Use the original execution device’s human entry for a pending native permission or question; an intermediate transport account cannot answer as that person.

A failed observer keeps the original Space, Agent and pending input. A changed member or Run refuses only that exact action. Composer submissions retain their original submission ID and exact input key for receipt inspection. Raw write/paste has a Native acknowledgement but no caller-owned business operation ID; an unknown raw acknowledgement is not automatically resent or presented as an inspectable operation. The client does not change either input’s target. Closing a mounted reader releases its observation, never its Run.
