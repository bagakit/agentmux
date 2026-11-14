---
summary: "Agent Sessions, original inputs, conversation and lifecycle"
roles: "All Agents; execution and coordination"
when: "Inspect, open, communicate with or recover an Agent"
---

# agent

<!-- amux:content -->
`agent stop --session SID --run RUN --operation-id OP` freezes that exact original
Session/Run. It uses the discriminated `agent-run` target; an older owner rejects it
before Stop, and a newer owner refuses a replaced Run without selecting its successor.
Without `--run`, the original current-Run Stop intent remains available. Interrupt and
Resume do not accept the exact-Stop target. After unknown, read `agent stop inspect
--session SID --run RUN --operation-id OP`; inspection never continues Stop by itself.

Core owns Session identity, Provider semantics, input permission and recovery; ctxmux
owns Run/process/bytes. Executor, durable Session, current Run and display Region are distinct.
Begin with agent ls/inspect for the exact Session and routeHostId; preserve original identities
and unknown receipts. A failed observation never authorizes stopping a healthy Run.

Read status.observation.semantic for the whole Agent and its confirmed child work.
status.observation.mainSession describes the original native main session independently;
subagentSessions retains native child IDs, turn/source ordering, states and original
observation times. These native children do not create AgentMux Sessions. A main idle
observation does not complete a task or permit idle-only input while child work remains.
After an owner restart, mainSessionActivity retains the original main observation;
currentActivity remains separately qualified for live input decisions.

For startup waits, agent input inspect exposes control.waiting.initialization on the
original saved input: reason, source, scope, original Provider/Run and observedAt.
A prerequisite reports native configuration or account requirements; request means
an actual native protocol request. Unknown inspection never becomes permission to
answer a setup screen. Authentication, onboarding, directory trust, permission, hook
trust and upgrade are distinct reasons only when their native evidence exists.
Use the original terminal for required confirmation, then inspect or rejoin that same
input. No check automatically approves a request or resends an unknown delivery.

For a new Agent taking over original work at a chosen destination, read agent open
--help and space --skill. Core qualifies the source and supplies its context; keep
the exact operation for inspection. agent takeover ls reads selected-owner relations.

To create from an existing Browser, first read browser --skill and browser agent-workspace
prepare --help. Its ready receipt supplies the original execution Workspace; preparation
does not create an Agent. Choose the display target separately through space --skill and
agent open --help, retaining the Browser's original source and unknown preparation facts.

Use agent provider ls --host HOST [--provider ID] for the original Host’s pure Provider
declarations, including launch choices and addressable posture modes. It never probes
executables, installs hooks or starts Native. An empty catalog is confirmed empty; a failed
source is unavailable, and runtimeId=null means the semantic owner identity is unknown.
Declarations do not prove current permissions or readiness.

Use agent posture inspect --host HOST --session SID --run RUN for the exact original
Provider target/controlDigest. Set one declared intent with agent posture set --input FILE|-
using that target, operationId, controlId, modeId and expectedControlDigest. Only the original
transport-approved person/device can set; managed Agents cannot grant themselves modes.
Applied proves the intent's byte ACK, never the current native mode. For lost/unknown results,
read agent posture inspect --host HOST --session SID --operation-id OP; keep that ID and do
not reinput. Inspection remains a read even when the original Run is gone. A new owner
can read the retained ACK but reports diskDurability=unconfirmed: readable bytes do not prove
the previous producer received its directory-sync acknowledgement.

For a complete participant set, page agent ls to nextCursor=null. Narrow by the actual
Executor/Provider before reading status. Use semantic=active for current work; running alone
does not mean active. status, semantic, readiness and unavailable facts remain distinct.
lastActivity is the original typed event: waiting, completion and idle times do not mean a
recent working time. since is metadata updatedAt; activity-since selects original activity.
No task category is inferred from names, and one registered role is not a multi-Agent group.

Read only the needed history: agent conversation inspect --limit 3 for a small recent
window, then its original cursor. For folded process reading, add --process-details deferred
and keep that representation on inspect/changes continuations. Deferred records retain exact
original references and revisions; read their full body with the returned versioned anchor
through inspect --input (omit processDetails). Speech and interactions stay complete.
Deferral saves wire and Renderer payload, not initial source IO.
A JSON record lookup through inspect --input locates the current original with its
surrounding history; keep record and cursor across incomplete fragments, then continue a
complete window with its older/newer cursors and no record field. A versioned anchor remains
frozen. Stopping a watch only parks its view: release the exact window with
agent conversation release when finished, or let its Core owner dispose it.

Original turnOutcome records completed, failed or interrupted independently of metrics and current
activity; deferred headers retain it. Failed outcomes preserve the Provider diagnosis and exact
original turn. Optional publicMessage is a safe sharing summary, not permission to publish or retry.

agent history --source captured or native reads full retained sources. Use history --kind
user-message for input records, retaining human, Agent, external, platform and
unknown authorship. For replies, inspect original assistant records and continue a
nonterminal cursor when a bounded page has no matching reply; reasoning, tools and platform
notices are not answers. message ls/read cover original A2A participation. Read leaf help for the exact Host,
source, cursor and authorization contract. Discovery never grants access to another Agent's
private messages or working surface.

For a remote peer, `agent send --to-session SID --host HOST` selects its exact route;
`agent send --reply-source MID` returns along an original verified message. Each direction
needs its own message-source approval from the receiving person. A signed outbox save does not prove remote delivery.
Read `amux message --skill` for that approval, original thread synchronization over a
one-way connection and unknown receipt recovery.

For ordinary continuous progress, `agent progress --help` exposes exact-target list,
create, action and update. A person or device may update only the original loop's interval
and prompt. The next check and an already claimed or unconfirmed input keep their original
identity and content; Goal-bound progress stays with its Goal owner. The exact target is `{hostId,agentSessionId,providerId,workspacePath}`. List takes `{target}`;
create takes `{target,intervalMs,prompt,operationId,taskSource?}`. Intervals are safe integer
milliseconds, at least 60000. Optional `taskSource:{kind:"feature",root,ownerId,readerPath}`
uses the original Feature. Action takes `{target,loopId,action,expectedLoop,operationId}`
where action is pause/resume/stop/check; update takes
`{target,loopId,expectedLoop,intervalMs,prompt,operationId}`. Copy the full current loop from
list into expectedLoop, keeping original fields; do not synthesize it from this guide.
Each leaf's `--help` contains a complete parser-checked illustrative input.
Use the original expectedLoop and operationId. A list is a current observation, not a disk receipt. If a
save response is unknown, retain the exact request and explicitly retry that same operation
to confirm its save; a changed or superseded operation is not automatically replayed.
Resume restores ordinary progress and immediately checks that Agent; check requires an
active loop. Both evaluate eligibility rather than force a prompt. Read the returned
loop outcome and decision; a completed check does not by itself confirm a new Agent turn.

agent conversation checkpoint cuts current native and captured positions by default.
Use --native-position beginning only when the consuming owner explicitly needs the original
native source start. It returns a Provider-owned beginning cursor without reading or skipping
the first item; captured sources still use their current independent cut. An unavailable native
source stays unavailable. Reading a beginning checkpoint grants no earlier-history sharing,
input retry, new source selection or permission; retain the original audience boundary.

A closed role/source range uses agent conversation changes with its original checkpoint
and optional through checkpoint. through is a fixed upper source frontier, not a timestamp.
Keep checkpoint, through and cursor unchanged until a complete frame; then consume the
returned checkpoint and continue while more is true. Both native and captured sources,
including original input-journal membership, stay bounded. Never replace a missing role
boundary with whole-Session content or infer a range from display times.

For a current activity read on one exact original input, agent input inspect --input accepts
{key,activity:true}. It additionally returns activity and sourceNow without preparing,
admitting, replaying or stopping input. Ordinary inspect adds no Provider activity read.
The public SDK equivalent is readAgentInputActivity(key). Native Hook or Provider facts
qualify this read; a display status, heartbeat or bytes do not establish dialogue expiry.
Unconfirmed activity preserves the original input, Session and available capabilities.
Read the Mote module for the separate original Main role and rollover owner.

Trusted first-party human inputs saved by Core also appear in the original captured
conversation while waiting. The same inputRef and record survive rejoin and dispatch;
recorded means its public content is saved. inputSubmission retains the original
waiting/stopped/terminal-confirmed/admitted/not-applied/unknown receipt and observation.
Terminal confirmation proves ordered input bytes; Native admission is not Agent completion.
Use agent input ls/inspect for the original control and agent conversation inspect/changes
for its read projection. Generated context remains separate from the public user body.
The captured frontier's inputJournal and the record's inputOrigin preserve original
journal membership across recovery; a later capture or status change never moves an
older input past an audience's sharing cut. Missing old cut proof stays unconfirmed.

For bounded input membership/control change discovery, use agent input changes --input
with the exact Host and recipient. Its first read returns only a checkpoint; later reads
resume with after or cursor, including offline cancellation and rejoin. Persist the
position only after consuming its page. Keys coalesce changes: inspect each original
input for current facts, never reconstruct historical waiting or native adoption.
Positions are source-bound, not permission tokens; managed Agents read only themselves.

Load only the journey needed now:
- Review useful work experience: agent learning --help exposes preparation, the designated
  extractor's proposal and original-operation inspection. Only the trusted App can confirm
  exact candidate content and an exact Mote/Topic destination. A saved proposal or ordinary
  text saying the user agreed is not approval. Keep the source and original operation after
  unknown results. A person/device can explicitly continue that same frozen operation via
  agent learning continue --input FILE|-; it grants no new approval or target scope.
  Delivery, saved knowledge and later use remain separate.
- Independent Session communication: amux message --skill for the full shared contract.
- Create an Agent: amux agent open --help for configured Executor discovery and opening workflow.
  For a new Agent with separate project tools, use --execution-workspace AGENT_WORKSPACE
  and --tool-workspace RESOURCE_WORKSPACE. This requires a transport-authenticated user/device
  without a managed Agent caller. It cannot be combined with native resume, fork or new Zone
  creation, and none of those can change this binding.
- Typed Provider requests: agent interaction respond answers one exact original typed request
  with a stable operation identity, and agent interaction inspect reads its durable receipt.
  agent question reply queues asynchronous question answers only where the capability
  asyncQuestionReply=native-input is present; submission is queue admission, not adoption.
  Both answers require a transport-approved user or device; a managed Agent cannot answer on a
  person's behalf, and no parameter or JSON field can claim a person's confirmation. Native
  question handling is in amux agent native --help.
  agent view switches an exact SID's presentation between terminal and activity without focus.
- After freeing storage, a transport-approved user/device can release only the original active creation's current backoff with `amux agent creation continue --host HOST --operation-id ORIGINAL_CID [--session EXACT_SID]`. Managed Agent callers are refused. Use the original CID, not a new operation; an optional known SID is an extra fence. `woken` confirms scheduling only, not recovered storage, Start or delivered input. `not-waiting` stores no future wake credit; `unknown` does not reconstruct a missing/aborted owner or authorize another create. Inspect stays an observation; neither inspect nor repeating agent open wakes this wait. Keep the original creation result and unknown effects unchanged.
- Original creator/child relations: amux agent spawn --help. Keep the original creation operation after an unknown receipt; never create a replacement to recover its result.
- Saved native conversations or resume: amux agent native --help.
- Original output, input mailbox, history or conversation: use that agent action's --help.
- Authorized unmanaged prompt intake: agent input submit preserves the original prompt key;
  Browser context is declared data. It cannot establish Human authorship or Host capture.
  Managed Agents must use agent send; public prompt intake cannot bypass A2A attribution.
  The directed session-conversation intent uses the original Session capability and
  retains controlled waiting; a selected native request never changes to terminal after unknown.
- Recovery or lifecycle: use the exact action's --help; interrupt, stop, restart, resume and
  reopen differ.
  Repeating an unknown original Start operation only observes it; it never sends that Start or input again.
  A new explicit `agent resume --session SID --operation-id NEW_ID` without text may resolve a fully
  frozen unknown Start on its exact original Runtime, retaining the same Session/native conversation.
  Inspect the safe `resolution` relation: pending names the same manual operation to retry; retained
  names the actual original Run; retired records the old key fence and `continuedBy` successor.
  Retirement does not mean the old Start had no effects. After handoff, the manual ID identifies the
  successor Start: an unknown successor needs another explicit manual intent, not replay of that ID.
  This path sends no old input or automatic reminder. A prepared resume freezes its complete
  request privately; its execution environment never appears in the public Session, inspect
  output or CLI receipts. Missing legacy dispatch provenance stays unknown;
  obtain its original source or an exact retained Run. Inspect/startup never authorizes retirement.
Before opening or rearranging a workface, read amux space --skill for placement and focus.
Readers keep their original source/cursor and release only their reader, not the Agent;
reading, input admission, native adoption and task completion remain separate facts.

Inspect an original tool operation with `amux agent execution inspect --help`. This metadata-only query requires a transport-authenticated user or device and the exact Host, binding, stream generation and JSON-encoded native request ID from the original machine protocol. Numeric `0` and string `"0"` are different identities. It returns no request or response bytes and never searches other Hosts. An unknown outcome is not permission to replay or replace the original request.

For cross-Host execution, `amux agent execution create --input FILE|-` consumes one exact authorized Agent/resource binding and the original Agent creation identity. Read its help before forming JSON. The two Host roles may be reversed in a new binding; an existing Session keeps its original pair and each direction needs its own resource authorization. `amux agent execution binding --input FILE|-` reads `{bindingId}` at the original coordinator endpoint. `amux agent execution rejoin --input FILE|-` reconnects only retained helper readers: it does not restart a helper, restore an Agent CLI, or replay a native operation. Keep an unknown creation’s original full input and IDs; inspection does not grant retry permission. These commands require a transport-authenticated user or device.

Use `amux agent execution admit --input FILE|-` when another owner needs the complete frozen intent acknowledged before publishing its placement. It accepts the same complete packet as create, but only authorizes and durably freezes it in the original journal; no endpoint preparation, helper Start, Agent creation or input occurs. Its reply contains only the original binding/Session/create reference. Existing create combines intake and advancement in the same lane. Keep the original packet after a lost ACK; binding's association view can expose safe original launch coordinates and the optional Source request digest, never its private prompt or Source contribution. Missing original facts remain unknown and cannot be rebuilt from current settings.

Use `amux agent execution watch --input FILE|-` with `{bindingId}` for the original Core's initial and latest live snapshots. Slow readers coalesce updates; cancelling the stream closes only that reader. It never starts, continues or rejoins work and requires the same user/device authority as binding inspection.

### Selected Session resource inspection

Use `amux agent history record inspect --host ID --session ID [--operation-id ID]` before an explicit **Delete AgentMux record** action. Only the original transport-approved person/device may use `agent history record delete`; use its exact retirement timestamp/revision and keep the same operation ID. After an unknown reply, inspect first; absence is not a deletion receipt. A user may explicitly retry the same original operation and witness, never mint a replacement. A confirmed `pending` phase may be completed only with explicit `--continue` on that same operation. Core terminal identity and known creation correlations remain, while Session-bound records become unreadable and cannot continue. Shared input journal originals, Provider originals, ctxmux Runtime and independent client drafts/queues have their own owners and are not physically deleted. Indexed Session-row cleanup is logical work, not physical disk reclamation. These calls require a serving Core that supports the capability; unsupported calls do not stop a healthy old Core or grant a fallback deletion path.

Use `amux agent history usage --host ID --session ID [--limit N] [--cursor CURSOR]` for a bounded read of existing captured JSON body bytes. Select the original Host/Session from `agent ls` (including retired entries), then keep its exact cursor/epoch/sequence range. Each page reports logical bytes and records only for that page, with explicit measured coverage. Other Core records, Provider originals, ctxmux Runtime and shared database physical pages remain unmeasured. This is not total Session occupancy, reclaimable space or deletion authority. The reader never imports native history, operates a Run or sends input. Use command help for the current machine fields.

## Exact local display-name ownership

<!-- amux:generated command:agent.name.inspect -->
<!-- amux:generated command:agent.name.change -->

These finite APIs address the actual local label owner with exact runtimeId,
agentSessionId and createOperationId. They do not aggregate other Hosts or need
a current Run, Native connection, readiness probe or full history. The local
Core verifies its original durable Session creation and current actor. Read
never initializes a document. A confirmed local Session with an absent name
file may explicitly create its label in the same original spatial store; parse
or I/O uncertainty is not absence and never overwrites original bytes.

Change uses the same rename/confirm union as Source member naming. For example:

```json
{"runtimeId":"A","agentSessionId":"SID","createOperationId":"C","change":{"kind":"rename","operationId":"Agent-name-OP","name":"Original Agent","expectedNameRevision":0,"source":"manual"}}
```

Use `amux agent name change --input request.json`. Inspect accepts the same exact
identity and optional operationId, and returns current override/source/revision
and the original record with diskAcknowledgement:not-observed. Only the actual
rename or explicit confirm returns a producer durability ACK. Keep partial or
unknown operations; do not mint or automatically replay a replacement. A Source
association L is not this local creation C or a grant to the Agent.

The older `agent rename` retains its receiving-client display-override semantics
and original records. It is not silently redirected to another Core. Local label
saves do not claim Provider-native title synchronization or Agent health.

## Promote an original Agent into a Mote Club

After the user explicitly chooses lasting Club membership, the original
person/device may call `agent promote apply --input FILE|-`. Retain the exact
Host/Session, source display occurrence, title, operationId and destination.
Prefer `destination: {"kind":"existing-club","target":CLUB_TARGET}` using an
original discovery choice. Explicit `destination: {"kind":"new-club"}` establishes
a separate Club home and then associates that same Agent as its Thread. Neither
choice appoints or replaces a Main. The original Main settings, Agent history,
Run, execution cwd and project workface remain. No repository is copied, no
Agent is started, and no input or standing maintenance is enabled. An Agent
already organized in a Topic/Club keeps its organization; promotion cannot be
used as a transfer.

Use `agent promote inspect --input FILE|-` with `{"target":{"hostId":"HOST",
"agentSessionId":"SID"}}` to discover `pending`, original `clubs` and current
`memberships`. Club titles may match; retain their exact target and directory.
An unavailable Main is `main: null`, never a guessed role. `issue` reports gaps;
it does not invalidate other confirmed Club choices. Follow `nextCursor` with
the same target and `cursor` until null to finish discovering unfinished
operations. Do not treat a partial page as a complete set.

Include the original `operationId` to read only that operation; the result has
`discovery: null`. Unknown operation IDs remain absent rather than adopting
another action's receipt. A managed Agent can inspect its own target, but cannot
assign itself membership or a Main role. Partial or unknown results retain their
complete original request. Inspect before explicitly applying that same request
and operationId; never mint a new operation to replace an unknown result.
Historical completion remains inspectable after later membership or file edits.
Already admitted original operations keep their original promises and durable
records, including an original Main assignment; new requests always require an
explicit destination and never inherit that promise.

`settings inspect promotion.enabled` reads the global switch for new promotions;
its default is true. The person/device may change it through Settings → Promotion
or the public Settings owner. Disabling it retains existing Clubs and original
operation inspection/continuation. A saved personality does not prove that an
existing Session has read it; continue the original context and discover Mote
guidance through the original main/member binding when actually working there.
