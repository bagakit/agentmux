# browser targets

<!-- amux:content -->
[Browser target choice](../shared/browser-target-choice.md "amux:include")
First inspect the exact Tab/Region and read its typed Browser id with
`amux space inspect --tab TAB` or `amux space inspect --region REGION`.
Use `amux browser targets` to discover original available Browser targets and their host-owned
`control` facts: owner, activeOperationId, revision, inputIsolation and the optional `agent` association.
Target `ready` means the resource is operable, not that its requested page loaded.
The optional `navigation` observation, also returned by `pageInfo()`, contains the original
`requestedUrl`, native `documentUrl`, `navigationId`, `committedNavigationId` or null,
`loading` and original `error` or null. The native document may still be an older page or an
error document. A commit is a native event, not a last-successful-page record; null error
does not certify page success. An omitted observation is unknown. Script `completed`
describes that program only; preserve the page and available capabilities after a navigation failure.
`agent: {hostId, agentSessionId}` identifies the associated original Session; null confirms none,
and omission means unknown. Association is separate from input ownership and a live Run. A retained operation or
Agent working status does not acquire webpage input. Human handoff remains a trusted UI action;
ordinary CLI input cannot grant it. External and standalone targets report unsupported isolation;
an AgentMux visual border cannot block human input in an external browser.
A standalone host can own Browser objects without any Desktop window or Region.
Use `amux browser create --url URL --operation-id ID` against that exact host endpoint;
its configured local executable and private storage belong to the host, never request parameters.
The returned `source: standalone` target has `workspaceId: null` when no Workspace is authorized;
file capabilities are not granted by choosing a directory, and no spatial binding is fabricated.
Use the exact returned Browser id with targets/run/history/inspect/follow/stop.
Create and `amux browser close --browser ID --navigation NAV --operation-id ID` retain typed
lifecycle intents and receipts in the original operation journal. Inspect the original operation
when a result is unknown; neither a dropped ACK nor current discovery authorizes another launch.
Close acts only on this host's exact owned target and original document. A beforeunload request
keeps the original page and unsaved input; it cannot be approved by a managed Agent.
Operation stop leaves the native page and its input available; release is a separate resource action.
Host process restart reconnects its saved Browser id to the same engine endpoint and target id,
without replaying a program. Missing original targets stay unavailable; they are not selected by URL or title.
An optional `certificateRequest` describes the original pending main-document TLS request,
including its navigation, address, error and SHA256 fingerprint. It is observation, not trust.
Its `profile-connections` scope means other pages sharing that network context may reuse an accepted connection;
it does not promise single-page isolation or a permanent exception. Only the person may answer in the trusted App surface.
CLI and Browser programs have no certificate approval method. Keep the original request and let the person decide.
Native child pages appear as ordinary Browser targets with their own ids and the same page capabilities.
Their optional `openedFrom` records the original Browser/navigation and, when confirmed, the triggering Tab/Region occurrence.
It is provenance, not input authority. Opening a child does not switch an existing program to it; discover and run against its exact id.
Use the original Region identity with `space inspect`/`space focus` to locate its current position; a saved location may have moved.
Discovery reports coverage=complete or coverage=partial. A partial result cannot confirm that an unreturned page was removed.
Use `amux browser input inspect --host-id HOST --operation-id INPUT` to read one original captured input scene and message digest.
HOST is its capture owner and INPUT is its original input ID, independently of Browser operation IDs.
This historical read supplies no message body, author, current Browser grant or delivery conclusion; an Agent may read only its own recipient capture on the exact execution Host.
A cold embedded description is unavailable without navigationId or native capabilities.
An admitted `amux browser run --browser ID` restores that same original page on first use;
discovery alone does not create a page.
Use `amux browser restore --browser ID [--operation-id ID]` to acquire that exact native page without selecting or focusing it.
Its one current ready target confirms neither page-load completion nor a historical restore operation. Keep the original business ID and unknown reply; do not automatically repeat.
This action has no restore-history inspect; `browser inspect` still reads the original program journal.
Use `amux browser release --browser ID --navigation NAV [--operation-id ID]` for one exact currently observed embedded page.
The same owner policy retains visible, active or uncertain pages. Read its released/retained/unknown result and reasons; Browser, Regions and website data remain.
An unknown result keeps the original request identity without automatic resubmission. Current discovery cannot confirm historical release completion.
Use `amux browser open --url URL --private` with an exact placement to create
one separate temporary website session. Check its returned mode and target identity.
Closing ends that session; app restart preserves its Region as an empty private page.
Private mode does not hide network identity or erase explicit saves, downloads or
Agent operation records. Existing Browser modes and normal Profiles stay unchanged.
If the target is absent, its recovery is unconfirmed or driving is refused, report that exact result.
Do not guess another Browser or use GUI input to get around that result.
Opening a Browser preserves the current Workbench selection and eligible input;
explicit focus is a separate navigation action. Browser progress does not select another Tab.

The optional `dialogTypes` is the original host's supported native dialog kinds.
Missing means unknown; `[]` means no program dialog answers. Desktop supports alert,
confirm and keeping a beforeunload page, not JavaScript prompt. The standalone CDP
host can answer native prompts. External extension tabs leave this fact unknown;
an omitted type or high-level method is not proof that their native transport cannot answer.
These facts do not grant input or let a program approve leaving an unsaved page.
