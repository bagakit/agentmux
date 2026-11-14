# agent-open

<!-- amux:content -->
Agent-first workflow:
1. Inspect Project resources and the intended Space separately with app snapshot and space inspect.
2. Choose a split or a new Tab with the placement playbook in amux space --skill. For a new Tab
   in an existing Zone, use agent open --zone ZONE --new-tab --executor EXECUTOR --prompt TASK.
3. To create a Zone, supply --project PROJECT --space SPACE --new-zone and either
   --worktree --path PATH (--branch BRANCH|--new-branch BRANCH) or --directory PATH.
   --branch checks out an existing branch; --new-branch creates it. If a Project's source
   is ambiguous, inspect its real Workspaces and explicitly pass --source-workspace WORKSPACE.
4. Retain the exact business operation ID, returned SID/Run and spatial address. In the
   creation receipt, result.agent.agentSessionId is the new Session and result.to its confirmed
   location. After a failure read resource, agent, to, issues and save separately: a nonzero
   exit does not mean nothing was created, and a failure never deletes a created worktree or
   stops a created healthy Session. An initial task marked confirmed proves only the delivery
   protocol, not acceptance or completion.
5. Use agent inspect, agent output and agent send for follow-up. Delivery is not completed work.
6. After a lost Agent creation/move reply, read space inspect --operation-id ID.
   For File open, retain the original resource and inspect its actual File Regions as
   amux space --skill describes. An unknown original operation stays unconfirmed; do not blindly repeat.

For Takeover, use `agent open --executor EXECUTOR --takeover-source FILE|-` with an
explicit `--operation-id` and an existing background destination. The source JSON is
`{hostId,agentSessionId,organization:{runtimeId,spaceId}|null,expectedRun?,expectedRuntimeId?}`. A saved
native-only source instead retains `{hostId,nativeSource,executorId,organization:null}`
from native discovery; never invent a managed SID. Preserve `expectedRuntimeId` whenever
the source route or original execution Region supplies that exact Runtime; unknown
does not authorize guessing local. Core verifies the original source,
generates its context prompt and creates a separate Agent. The original Session, Run,
positions and drafts remain. Choose the execution Host/Runtime independently with the
original `--agent-host`/`--agent-runtime` pair when needed; a Host alias from the old
Core is not automatically a route in the new Core. An unavailable history read keeps
its exact diagnosis and available material rather than asserting empty history.

`agent open describe` reports `contracts.takeover:1` only at a Source implementing
this typed variant. Missing qualification leaves this action unconfirmed, preserving
existing work and original requests. Core derives promotion, handson, transfer or
ordinary takeover from original organization identities. Unknown organization remains
unknown, and a category display selector does not hide its Zone's Mote membership.
Promotion still follows the original Host policy. None of these relations grants a
Main role, Goal authority or another Agent's credentials.

Read `agent takeover ls --input FILE|-` with
`{expectedRuntimeId,direction:"incoming"|"outgoing",subject:{runtimeId,agentSessionId},limit?}`.
Select the exact original admission Core and follow each `nextCursor` with that same
query. Incoming names the created Agent; outgoing names the original managed Agent.
The page's selected-owner coverage covers retained Takeover admissions there, never
all Hosts. Native-only sources have no fabricated SID for an outgoing query. A remote
execution Core may hold no provenance in Session creation; read incoming at the
known original admission owner. Original facts survive retirement and observation
failures. Reading never creates, restores or replays input. Retain an unknown operation
for exact `space inspect` and a separately authorized same-operation continuation.

For an original Mote Main start, agent open --mote-main FILE|- carries its typed Main intent.
Keep the exact target, original MOTE baseline/role and operation IDs. A frozen deferredInput
is the person's first Query; handover:true adds context from that original previous Main.
Creation remains no-input. Only after the original setup confirms binding does explicit
space mote dialogue setup advance submit those retained intents through Core Main input.
Inspect is read-only; a route alone does not prove sending. Keep the canonical original
input key and unknown outcome across navigation or restart; never start another Agent or
mint another Query to repair an observation. Use amux mote --skill for the complete contract.

space mv moves a presentation and leaves the original execution cwd/Host/Session/Run intact.
Default Agent/File opens and presentation changes keep background navigation and eligible input.
space focus and goal focus navigate exact objects; app focus selects a Surface or reveals one
exact Agent in the Focus list, as amux app --skill describes. Selection, presentation and actual
caret eligibility are separate facts. Never stop a healthy Run to repair an observation or
handshake. Reader cancellation only detaches that reader.

[Remote execution from a project](remote-execution.md "amux:include")
