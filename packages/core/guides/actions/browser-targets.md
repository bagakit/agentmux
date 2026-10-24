# browser targets

<!-- amux:content -->
For an unspecified Browser request, start from your own exact Tab and first consider
this task's same-Tab neighbor Regions,
then verify the exact typed Browser binding. Multiple candidates or an unknown task
relationship remain explicit; do not select by title, recent use or human focus, or create
a new page merely to resolve the reference. Respect the user's exact target/tool choice.
First inspect the exact Tab/Region and read its typed Browser id with
`amux space inspect --tab TAB` or `amux space inspect --region REGION`.
Use `amux browser targets` to discover original available Browser targets and their host-owned
`control` facts: owner, activeOperationId, revision, inputIsolation and the optional `agent` association.
`agent: {hostId, agentSessionId}` identifies the associated original Session; null confirms none,
and omission means unknown. Association is separate from input ownership and a live Run. A retained operation or
Agent working status does not acquire webpage input. Human handoff remains a trusted UI action;
ordinary CLI input cannot grant it. External targets report unsupported isolation;
an AgentMux visual border cannot block human input in an external browser.
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
