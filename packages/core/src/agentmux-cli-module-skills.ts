import { AGENTMUX_CLI_COMMANDS } from './agentmux-cli-commands.js'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE } from './agent-messaging-guidance.js'
import { DIAGNOSTIC_GUIDE, GOAL_ACTIVITY_GUIDE, SPATIAL_GUIDE } from './agentmux-cli-shared-guides.js'
import { goalRoleGuidanceContract } from './goal-role-guidance.js'
import { GLOBAL_GOAL_PATROL_GUIDANCE } from './goal-patrol.js'
import { AGENTMUX_PROTOCOL_CATALOG } from './agent-message-render.js'
import { AGENTMUX_NOTE_EDITING_PATH } from './agentmux-cli-note-guide.js'

interface ModuleDefinition {
  summary: string
  roles: string
  when: string
  guide: string
}

/** Documents are owned here; module names and availability follow the executable registry. */
const definitions: Readonly<Record<string, ModuleDefinition>> = {
  runtime: {
    summary: 'Exact semantic Runtime observations',
    roles: 'Users and transport-approved devices',
    when: 'Read one original Runtime owner process without starting Native or recovering Sessions',
    guide: `Keep the same endpoint and original runtimeId/ownerInstanceId from its owner observation.
runtime network inspect requires both identities; a changed owner refuses only that read.
It returns the semantic owner process network namespace, one entry per interface address,
with producer observedAt. These addresses are not connected peers, a hop trace or public egress.
The read neither connects Native nor enumerates, starts or recovers Agent Sessions.
An unavailable observation does not prove that an Agent or Run ended.`
  },
  agent: {
    summary: 'Agent Sessions, original inputs, conversation and lifecycle',
    roles: 'All Agents; execution and coordination',
    when: 'Inspect, open, communicate with or recover an Agent',
    guide: `Core owns Session identity, Provider semantics, input permission and recovery; ctxmux
owns Run/process/bytes. Executor, durable Session, current Run and display Region are distinct.
Begin with agent ls/inspect for the exact Session and routeHostId; preserve original identities
and unknown receipts. A failed observation never authorizes stopping a healthy Run.

For a complete participant set, page agent ls to nextCursor=null. Narrow by the actual
Executor/Provider before reading status. Use semantic=active for current work; running alone
does not mean active. status, semantic, readiness and unavailable facts remain distinct.
lastActivity is the original typed event: waiting, completion and idle times do not mean a
recent working time. since is metadata updatedAt; activity-since selects original activity.
No task category is inferred from names, and one registered role is not a multi-Agent group.

Read only the needed history: agent conversation inspect --limit 3 for a small recent
window, then its original cursor; agent history --source captured or native reads full
retained sources. Use history --kind user-message for input records, retaining human,
Agent, external, platform and unknown authorship. For replies, inspect original assistant
records and continue a nonterminal cursor when a bounded page has no matching reply;
reasoning, tools and platform notices are not answers. message ls/read cover original A2A
participation. Read leaf help for the exact Host, source, cursor and authorization contract.
Discovery never grants access to another Agent's private messages or working surface.

Load only the journey needed now:
- Independent Session communication: amux message --skill for the full shared contract.
- Create an Agent: amux agent open --help for configured Executor discovery and opening workflow.
- Original creator/child relations: amux agent spawn --help. Keep the original creation operation after an unknown receipt; never create a replacement to recover its result.
- Saved native conversations or resume: amux agent native --help.
- Original output, input mailbox, history or conversation: use that agent action's --help.
- Authorized unmanaged prompt intake: agent input submit preserves the original prompt key;
  Browser context is declared data. It cannot establish Human authorship or Host capture.
  Managed Agents must use agent send; public prompt intake cannot bypass A2A attribution.
- Recovery or lifecycle: use the exact action's --help; interrupt, stop, resume and reopen differ.
Before opening or rearranging a workface, read amux space --skill for placement and focus.
Readers keep their original source/cursor and release only their reader, not the Agent;
reading, input admission, native adoption and task completion remain separate facts.`
  },
  app: {
    summary: 'Global resource discovery, search and application navigation',
    roles: 'All Agents',
    when: 'Locate resources or navigate an existing application surface',
    guide: `The client owns presentation and resource discovery; Core owns stable spatial and
execution identities. Begin with app snapshot for actual Projects, Workspaces, Spaces and
their Host/path facts, then app inspect for the current presentation. A resource Workspace,
display Workspace and process cwd are not interchangeable. Discover globally rather than
assuming the current Tab contains every resource or Agent.

app window ls observes the original client windows and their opaque document generations.
app window open moves one exact discovered Tab/Region occurrence; it does not clone content,
change the Core graph, start a Run or change execution cwd. app window focus/return require
the exact window and document generation. Returning closes only its shell after the original
workface has returned. Retain the original operation ID: query it with app window ls after
an unknown result, without automatically opening another window. A recorded acknowledgement
and current native presentation are separate facts; absent client support is unavailable,
not an empty window catalog or loss of healthy Agents.

Use app search with the appropriate metadata/content mode, retaining each result's source
identity and availability. Inspect an exact returned object through its module before an
operation. app focus selects a surface; it does not accept a task or certify input eligibility.
Use app focus --surface space --view map to open the same collaboration map, or --view
workbench to return to the original workface. Omitting --view preserves the existing Space
view; other surfaces cannot use --view. Compose exact area selection with space focus.
app inspect reports selection.spaceView separately from actual presentation and input.
Retained Tab/Region selection does not certify that content is visible behind the map.
Selection, focus and native input receipts are separate. Preserve current drafts and caret
unless navigation/input change was explicitly requested. Partial or unavailable discovery
does not mean objects are absent; retain the original view and inspect its exact owner.
For Agent/File/Browser opening or layout changes, read their module and the space module first.`
  },
  browser: {
    summary: 'Embedded Browser targets, page programs, tasks and original receipts',
    roles: 'Agents reading or operating web pages',
    when: 'Open, inspect, automate or recover a Browser operation',
    guide: `The Browser owner holds exact page identities, capabilities and operation receipts.
Reuse the Browser already confirmed for this task. Read its actual target/capabilities before
acting; labels do not establish website state, permission or completion. Keep the original
page, user input and unknown operation identity; do not bypass refusal or human control.

Read only the matching local help:
- amux browser targets --help: discover available exact targets and their readiness.
- amux browser run --help: page-program API, capability names and original result/receipt reads.
- amux browser task --help: saved task versions and their run/stop/inspect journey.
- amux browser open --help: open a new page only when needed.
Before opening a page or changing layout, read amux space --skill for same-Tab readable
placement, its exceptions and separate navigation/input focus. An app link may await a
person's system handoff while the original page stays unchanged.`
  },
  connection: {
    summary: 'External connection configuration, bindings, ingress and delivery',
    roles: 'Authorized connection operators and coordinating Agents',
    when: 'Inspect or operate an exact external communication connection',
    guide: `The connection owner holds configured adapters, bindings, grants, ingress and delivery
receipts. Managed Agents authenticate with their original Session capability, never as a user.
Start with connection enrollment ls to discover adapterId/domain and your own original operations.
Use connection enrollment begin --input FILE|- with exact operationId, connectionId, adapterId,
domain, label and preset {name,avatar:{pngDataUrl}}. Only a person can scan/authorize the platform
challenge; keep active QR data on its original confirmation surface and out of ordinary logs.
Copy an offered action into connection enrollment advance --input FILE|- as
{operationId,ownRevision,decision:{actionId,kind}}. Confirm the exact account before choosing create.
Continue or inspect the same operation after an unknown response; never replace its IDs to retry.
An Agent can inspect/continue only its own private enrollment and management operations.
Once configured, its Connection appears in connection ls and can be used for setup/profile/room
operations. setup begin accepts the exact source enrollment to reuse its login; the separate
management account confirmation and finite offered actions still apply. For card interaction,
read-callback-settings first, select --application-configuration use-persistent-callback and
confirm its exact offered action to switch application-wide callback delivery. Read callback
settings again before a separate --application-configuration add-card-actions confirmation.
These two finite effects have separate receipts; event delivery does not configure callbacks. A binding/room creation
must name that same Agent Session, never another Agent. Global service/configuration, external
actor grants and existing human/device bot operations require their original trusted operator.
For saved Mote identity use space mote connection create/sync/advance/inspect/ls through the same
owner; exact Mote sources stay on the authenticated Agent Host and Workspace. Create --input
accepts optional name to freeze an explicit bot name; omit name to use the exact saved Mote name.
Retain that complete input: changing name on the same operationId conflicts. Neither choice edits
the saved Mote source. Sync still uses the saved Mote name and does not accept name. Saved identity,
application creation, profile write and Mote default save retain separate original receipts.

For original request evidence use connection enrollment/setup inspect --operation-id ID --request-trace.
This separate local selection returns bounded ordered journal steps and next; copy that cursor with
--trace-cursor on the same original operation. It does not load QR/account/secret material or retry.
network:null means HTTP details were not recorded. Enrollment claimed/settled describe its journal,
not live dispatch or request success. Do not combine trace selection with private inspection/configuration views.

Begin with connection ls/inspect; configuration, a successful test, an enabled
binding, ingress and actual outgoing delivery are distinct facts. Keep the exact connection,
binding and source identities rather than matching human labels or assuming transport trust.
connection service get reads the complete Connector policy on the current endpoint. Service
configure disables or enables new automatic traffic without rewriting application enabled values.
Retain the exact operationId, expectedRevision and service input after an unknown configure reply;
service inspect reads that receipt, while get reports current policy and cannot acknowledge it.
Management, original receipts and healthy local Agent input remain available while service is off.
For an exact saved bot, connection setup begin requests one original management QR challenge unless
source is {kind: enrollment, operationId, expectedRevision}. That explicit local handoff reuses only
the original actor's confirmed saved creation login, with zero HTTP. Its request.kind is
enrollment-handoff: confirmed acknowledges local storage, never QR-init or management authority.
The sourced account still requires its own explicit confirm-account and explicit application reads.
After secure handoff, later source availability does not govern this Setup; retain the same input
for local ACK recovery. Discovery advertises enrollment-continuation only for its implemented domain.
Setup inspect is a local read of that actor-owned active challenge; setup ls returns safe summaries
and local implementation support bound to the current bot revision. Support is not login,
application authority, grants, publication or connection readiness; a paused bot retains management discovery.
Keep the original input after an unknown init; repeat begin only for original lookup or secure
handoff recovery, never a second native request. Scan material belongs on its exact confirmation
surface, not ordinary logs. Setup advance uses the exact actionId and expectedRevision from
continuation.actions or applicationInspection.actions with decision.value continue, confirm or
renew. One action performs at most
one HTTP request or its original local secure handoff; repeating the same input never replays it.
Renew explicitly abandons authentication within this intent, retaining old requests and snapshots;
it never creates an application. Scan, phone confirmation and exact account/enterprise confirmation
are separate stages. A confirmed management session does not establish app permission, tenant
membership, configuration, publication or chat readiness. App eligibility, configuration and
publication continuations remain separate. With --application-inspection, setup inspect can
locally page original safe application observations and select an exact old --inspection-step;
it never sends HTTP or repairs an ACK. Copy an offered inspect-application,
read-application-details, read-event-settings, read-callback-settings, read-bot-settings,
read-permission-catalog, read-application-permissions, read-event-catalog or
recover-application-inspection action and use decision continue. Current data subjects
retain independent receipts, not a complete configuration snapshot or readiness. Publication observations
include read-publication-pending, read-publication-versions, read-publication-visibility,
read-publication-sharing and read-publication-features. With --application-inspection --version-id ID,
copy the offered read-publication-version action and its exact versionId into advance input.
The request route and original binding select that version; list position and labels do not.
Version review status is separate from the online version pointer and actual message intake. New observation requires current
confirmed stored auth; original actor local recovery needs only the frozen original child/input,
even after renewal, revision or restart. Old private results stay withheld and an unrecoverable
old result never blocks a separate eligible new observation. Reported basic-info read permission
is not actual app data, owning tenant or write authority. Inspect locally reads the explicitly selected finite effect and its exact original source. Configuration selection always names its effect: use
--application-configuration enable-messaging or --application-configuration use-persistent-connection.
The latter reads only the exact event-settings source and offers one explicit application-wide
switch to persistent connection. Warn that existing event consumers are affected. Already persistent
needs no write; unknown native modes stay unknown. Its accepted write is not readback or publication.
Unknown results are isolated by app/effect/source subject and cannot block independent bot-enable. Copy an offered enable-messaging or use-persistent-connection action with explicit confirm;
An existing bot profile uses the finite goal {kind: profile-update, desired: {name?, description?,
 avatar?: {pngDataUrl}}, publication: {notes}} on the same connection.setup.begin API. Original
PNG bytes stay private; public history contains only avatarSha256. Empty description explicitly
clears the primary locale while preserving other localized descriptions. The original Console
session, upload, full profile write, fresh readback and publication keep separate receipts. Observe
profileUpdate stages and copy only its offered actions. Ordinary continue-profile-update fills
missing current publication sources; refresh-publication-checks reads the five publication subjects
and returns without writing, even if checks become ready. A separate offered action alone can
publish. Plain inspect exposes the original candidate/review at publication-create; explicit
configuration selectors keep their selected result. Local ACK recovery remains independent. A
profile operation never creates another application. The existing published include/exclude
ranges are retained. Other pending changes require explicit review through the returned
publicationDraft and the original create-application-version action. Inspect remains local;
unknown native writes are not replayed, and original historical Profile receipts stay queryable.
For necessary permissions select --application-configuration add-application-permissions with
--permission-purpose agent-conversation (messages and create/bind groups)
Consume offered read-permission-catalog and
read-application-permissions separately. Each original read owns its receipt and recovery; an incomplete
review cannot authorize additions. Confirm only the exact offered add-application-permissions action;
the Host binds its purpose and native missing IDs without a second caller scope list. Zero missing
means no request. Acceptance, existing applied configuration, effective grant and publication are
separate. Unknown permission additions remain original across purpose changes and do not block
independent messaging or delivery settings. Permission addition never writes data ranges, subscriptions or publication.
For group message reception use --application-configuration add-message-reception. The original
read-event-settings and read-event-catalog children qualify only the required App message event.
Confirm its offered add-message-reception action: this adds the event while carrying the last checked
application-wide persistent delivery mode; it does not secretly call the mode switch. Both event
writers invalidate older settings; a newer catalog alone cannot refresh them. After an unknown mode
switch, only fresh persistent settings and the compatible original immutable desired allow a distinct
explicit addition. The original switch remains unknown, unretried and unACKed. Already subscribed
means zero write; unknown additions cannot replay through aliases or renewal. Current subscription,
request acceptance, effective permissions, publication and actual intake remain separate facts.
recover-configuration-effect uses continue and only repairs its original encrypted ACK. An unknown
effect cannot be replayed through renewal, a new setup or a known application alias; unresolved
identifies the original actor-owned request when available. A new current read never signs that
old ACK. Local recovery does not change menus, modes, events, scopes, ranges or publication.
For publication select --application-configuration create-application-version or submit-application-version.
Inspect accepts --publication-draft FILE|- for the exact typed draft; inspection alone sends no request.
Creation uses {kind: create-version, version, notes, visibility: current|creator-only, optional
 desktopEntry/mobileEntry/reason}. Confirm the offered action with the same publicationDraft in advance.
Review all application changes, complete included/excluded audiences, entries and external sharing;
this affects the whole application and does not lock concurrent platform changes. Creation returns
its exact versionId without publishing. Submission uses {kind: submit-version, versionId, fullRelease}:
read and explicitly select that exact version, never a list position or version label. It has a
separate offered action and original result. Unknown creation cannot replay and does not block an
independently selected existing version. Unknown submission remains original for that exact version,
including a received response whose business outcome is unconfirmed. Preserve original local ACK
recovery before current platform eligibility. Request acceptance, version review, online identity
and actual message intake remain separate; this does not qualify live rights or the combined journey.

Configure or bind only within the user's authorized target. Inspect current values before
changing them; use the current help's exact input and operation identities. A grant is an
explicit authority decision, not an effect of reading this guide or an adapter message.
Read connection ingress and delivery records for their original source and acknowledgement.
Pause/relink affects the exact binding; it does not complete external work or stop Agents.
After an unknown delivery, inspect the original delivery identity. Retry only as the explicit
supported delivery operation with its frozen facts; never generate a second logical message
because a response was lost. Unavailable adapters retain configured bindings and known receipts.
Enrollment begin creates an original application intent; advance may perform a platform request.
Enrollment ls/inspect are local reads for restart recovery. Unknown one-time credential delivery
is inspect-only, never a reason to begin or poll again. Credentials never belong on public wire.`
  },
  device: {
    summary: 'Local device pairing, encrypted identity and revocation',
    roles: 'Authorized local user; connected devices for their own hello',
    when: 'Inspect or explicitly administer a paired device',
    guide: `The local device owner holds pairing and revocation; encrypted handshake facts identify
one device, not a general user approval. Read device ls before administering an exact device.
Pairing changes connectivity and does not create an Agent or accept a Goal. Retain the complete
returned offer and exact deviceId. Current discovery cannot certify an earlier lost revocation.

Read amux device --help for the pairing, identity and revocation contract; use the exact
action's help before changing it.`
  },
  file: {
    summary: 'Exact file resources, editor presentation, saves, uploads and builds',
    roles: 'Agents reading, editing or presenting files',
    when: 'Read/write a file or open its editor workface',
    guide: `The file owner holds resource reads/writes, save/upload/build receipts and editor state.
Identify the original Host, Zone/workspace and literal path independently from the intended
display Tab/Region. file read/ls access resources; file open/view access presentation. Opening
does not save or overwrite a file. Inspect the original view and preserve unsaved user drafts.

Pin file write/create to the original resource and observed revision; retain the original result. A save
request is not a confirmed disk write. Partial results certify only their explicitly confirmed
stages; unknown stages remain unconfirmed. Upload
and build operations have their own retained identities and inspect/cancel paths. Inspect the
same upload/build after a lost reply instead of issuing a new logical operation. Formatting
and build output do not certify a user's acceptance. Wrong targets reject only that request;
unavailable resource reads never authorize removing a view, replacing content or stopping a Run.

For concurrent .note.md edits and save/conflict receipts, read amux file write --help.
For first reuse as a shared Markdown entity, read amux file share --help. Stage the source
and surviving include occurrence without creating a file on copy/paste. Explicit save uses
file.share for exclusive shared creation, original source replacement and destination save.
Keep each original operation and bytes after unknown; file share inspect reads the original
per-file history and current observations separately. A current matching file cannot certify
an earlier lost receipt. Never manufacture a second body/relationship store.
For removing saved shared include occurrences while preserving ordinary draft edits, use
amux file share undo --help; inspect {mode:"undo",request:ORIGINAL_UNDO_PARAMS} after unknown.
The original owner separately reports source restoration, retained shared files and deletion;
keep known partial stages and never retry an unconfirmed deletion. Known terminal partial
undo preserves the saved draft and permits further ordinary editing; unknown phases retain the
same original request. Combine new promotions and removed uses with undoReferenceIds in file.share.
For saved-version recovery or actor-batch undo, read amux file restore --help or amux file undo --help.
Only for Note links, attribution or history, read amux notebook --skill. Unknown edits never authorize automatic replay.

Before opening or moving an editor workface, read amux space --skill for placement and focus.
Use the exact file action's --help for its arguments, original revision and receipt contract.`
  },
  git: {
    summary: 'Git history/diff, native worktree observations, exact Desktop presentation and worktree closeout',
    roles: 'Agents inspecting repositories or closing completed worktrees',
    when: 'Read commits, display original repository history or close a worktree',
    guide: `The Git owner reads an exact resource repository. Commits, parent-selected trees and
diff snapshots retain their original identities; a displayed history is not a checkout or
workspace mutation. Begin with global resource discovery, then preserve complete OIDs and
the returned pagination/snapshot facts through each read and presentation request.
Use git worktrees with the original Workspace/Host/path to observe main, linked and bare
worktree paths, current branches and detached HEAD without creating Zones or changing cwd.
Non-Git and unavailable are distinct; preserve the old workface and treat older observations
as historical while retrying the same exact resource. Registration names are not current branches.

Use git worktree close for product closeout after integrating the work. It gathers the
original Tabs into the same project's default workspace while retaining Session/Run and
execution cwd. workface moved confirms the saved display move; pending keeps its unfinished
responsibility visible. Read cleanup separately: pending retains unfinished cleanup responsibility;
inspect its reason for the actual directory state. removed confirms directory deletion. kept ends cleanup after Git registration has ended
and execution/file references are gone, preserving remaining user evidence with an explicit reason.
Keep the original operation ID and exact Host/path
when recovering an unknown result. Discarding Git changes never authorizes stopping a healthy
Agent or deleting its cwd.

Read amux git --help for repository/history contracts and amux git worktree close --help
for the exact closeout journey.`
  },
  goal: {
    summary: 'Goal scope, execution responsibility, reports and PMO patrol',
    roles: 'Executors, managers and people confirming or accepting work',
    when: 'Discuss, execute, supervise, inspect or report on a Goal',
    guide: `The original Goal owner is the business source of truth. Begin with goal inspect and
goal delegations for the exact original Goal/alignment/execution and current next responsibility.
Use goal activity for durable progress evidence, and the current help for typed progress,
delegation, report, collection and patrol operations. Inspect the same original identities after
an unknown write; do not create another Goal or duplicate input. Navigation, assignment, finite
Start, source-bound delegation and actual execution are different facts.

${goalRoleGuidanceContract()}

${GOAL_ACTIVITY_GUIDE}

## Global inspection

goal patrol all --operation-id ID opens one new discussion in the original primary PMO
Mote. Keep its exact original agent.open operation and inspect it with space inspect
--operation-id ID after an unknown reply; never create another discussion to recover it.
Creation, input, actual work and inspection completion remain separate facts.

${GLOBAL_GOAL_PATROL_GUIDANCE}

Read amux goal create --help only when creating or promoting a Goal; that leaf owns the
exact scope, confirmation and source contract.`
  },
  message: {
    summary: 'Original Inbox messages, reference notifications, input and dispatch reports',
    roles: 'Agents communicating across independent Sessions',
    when: 'Browse original A2A messages, inspect delivery, manage pending input or report through an original dispatch',
    guide: `Core owns authenticated messages, ordered delivery, inbox generations and original
dispatch threads. Use message ls --direction incoming|outgoing for bounded original metadata
and body previews; message read --message-id ID retrieves one original body, without
creating a delivery batch or advancing ack. Keep nextBeforeSequence with the same Host,
participant and direction. message read --operation-id retains original intake lookup.
message events reads the same original message/delivery/notification/dispatch changes from either side,
without opening bodies or consuming. Narrow by an original MID or broadcast operation when needed.
Use --latest for a bounded recent window. Preserve its exact scope, journal incarnation and
throughSequence when paging older with --before-sequence nextBeforeSequence; forward reads use
--after-sequence and nextAfterSequence. For new changes start after the prior throughSequence.
Returned events always keep original ascending order; another journal cannot inherit the old cursor.
These observations are not
model adoption, task acceptance or business completion.
Use message inbox check only for explicit batch consumption, and read the exact original message or
dispatch before replying. Keep operationId, messageId, source message, thread and reply
identities. Pending drafts, queued input, delivery and business reports are different states.

Discover exact Session IDs before agent broadcast; one frozen explicit recipient set is sent
once per target through the same Inbox owner. Duplicates do not repeat sends; each target has its
own stable MID/operation and independent saved, not-applied or unconfirmed outcome. After unknown,
use agent broadcast inspect with the original operation instead of rerunning discovery or changing
IDs. Broadcast does not grant steer, cross-owner authority or task ownership.

Use agent send for a new authorized cross-Session Inbox message; message read/delivery inspect and
dispatch inspect/read reconcile the original exchange. Pending edit/send/stop/archive/restore
operate one retained pending item, not a new message. Inbox acknowledgement records reading
of its exact generation and reader Run; it does not report work or complete a Goal. Dispatch
report uses the actual source/reply and kind; worker_done is a report pending collection.
Unknown/partial input remains original and cannot be blindly resent with fresh identities.

${AGENTMUX_AGENT_MESSAGING_GUIDANCE}`
  },
  mote: {
    summary: 'Everyday Mote collaboration, original-file memory and the PMO working manual',
    roles: 'Motes and coordinating Agents',
    when: 'Collaborate, maintain useful knowledge or coordinate delivery',
    guide: `## Begin with the real question

Help with the user's actual question before asking for a persona, preference survey or knowledge
setup. Give a useful small answer or next step. Ask only for missing information that changes it;
carry forward instructions and authorization already given. Be candid, practical and concise,
explain the result before its machinery, and reconsider when new evidence changes the answer.
Apply the professional judgment the task needs without inventing a private role or user profile.

## Read the relevant originals

Discover this exact Mote through the app/space and topic owners. SOUL.md holds persistent identity,
BEHAVIOR.md and MOTE.md hold saved cooperation/quick-mode choices when present, topic.md holds
context and links, and MEMORY.md is a short index into original knowledge. Relevant refs/, outcome/
and .agents/ hold sources, results and collaborator handoffs. Keep existing organization, user edits
and original links; no new taxonomy is required. Do not derive a resource path from a display
HomeZone, infer another Mote's knowledge or claim unseen conversation or running tools.

Read relevant saved decisions before asking the user to repeat them. An empty index does not prove
the whole directory has no knowledge. Missing or unreadable sources remain unknown; explain that
gap and continue useful independent work. Current user directions and authoritative permission,
Project, Goal, Session and Run facts take precedence over saved history and personality.

Keep MEMORY.md a short current index and topic.md a concise shared context with links. Keep sources
in relevant refs/ and reusable results in outcome/; collaborator plaques in .agents/ stay brief
handoffs. Preserve existing organization. When a Project or Task already owns code, bulk data or
execution logs, link its relevant evidence rather than copying it into memory or handoff notes.

## Remember at useful moments

At a confirmed preference, decision, important correction, result or open commitment, assess what
will help future collaboration. Keep a short scoped note with source, date and evidence links;
distinguish facts and confirmed choices from inferences, proposals, intentions and completed work.
Do not make a local choice global, turn a passing remark into a permanent instruction or copy whole
conversations. Explicit feedback can inform later suggestions within its scope. Original Goal/Task
records own current progress; knowledge notes and collaborator plaques are not live Runtime state.

Before reporting a meaningful step complete, make any needed knowledge update and refresh its short
index links. Update the relevant existing note when a conclusion changes rather than accumulating
conflicting dated reports. Keep original evidence and mark a superseded conclusion clearly. When
nothing useful changed, no extra note is needed; this is not a requirement to archive every turn.

Read amux file --skill for the existing Files workflow. Before editing, read the latest exact
resource and revision, preserve unrelated content, save with that revision/CAS and read back the
result. Only a confirmed save/readback permits saying it is remembered. Unknown writes require
inspection of the same file before any explicit retry, never blind overwrite. A maintenance note
may name Session, source/date and what changed or why nothing was needed; it is historical self-report,
not a save receipt or proof that every turn was assessed. Do not start another Agent, schedule or
extra model round merely to maintain memory; say when maintenance was not performed or confirmed.

## Improve a method from real feedback

Fix the current task first. After an important correction, repeated waste or useful result,
assess whether there is a reusable method. In the relevant original note, record its source,
date, applicable conditions, concrete steps and failure or non-applicable conditions. Keep
single-case evidence visibly limited; a proposed method is not a confirmed user preference.
No useful method means no extra record. Already-authorized knowledge maintenance does not
need another approval for each scoped note.

Use the same Files revision/CAS and readback workflow. Add only a short scoped link to MEMORY
when future recall needs it; do not inject a whole method library. At later relevant work,
read the current linked original before applying it. Use actual results and counterexamples
to narrow, correct or withdraw that same method, preserving unrelated evidence. A saved method,
its delivery, an actual read and improved results are separate facts; report only what is known.

Method maintenance does not authorize changing SOUL identity, BEHAVIOR choices, MOTE settings,
user instructions, global installed skills or permissions. Do not add per-turn reflection,
another model round, a background learning loop or a timer just to claim self-improvement.

## Correct or withdraw knowledge

Correct only the relevant original knowledge. When asked to forget, remove its recall text and
optionally keep a minimal source-only withdrawal marker; do not relearn it from old material without
a new explicit instruction. Preserve unrelated user content and source organization. New discussions
read the current saved files; existing discussions keep their earlier context. A file edit does not
erase Provider history, hot-update or restart an existing Session, or prove that a model used a note.

## Keep private material out of ordinary knowledge

Do not put credentials or unnecessary sensitive details in SOUL, AGENTS, MEMORY, other ordinary
notes, logs or plaintext backups. Use only an authorized secure storage path and keep a non-secret
purpose/reference in knowledge when needed. If no such path is available, do not persist the secret
in an ordinary file as a substitute; explain the missing safe path and continue work that does not
depend on it. Do not invent a secret-storage command or assume local files mean model data stays
local. Saved files, actual delivery to an Executor and a model's use of them are different facts.

## Follow through with restraint

Offer a few worthwhile ideas grounded in current direction, confirmed originals, linked Goals and
the exact available discussion. Explain relevance, source, scope and a concrete next step; keep
follow-ups brief and timely. Discussion or read-only research does not authorize external messages,
purchases, schedules or writes. Persistent identity does not imply an always-running process:
promise later autonomous work only when the capability and its actual arrangement are confirmed.

## Keep an idea close to its sources

For an idea, discover this exact Mote and read the relevant originals with amux file --skill.
Give a few concrete proposals with their reason, source, scope and next step; label a proposal
as a proposal. Within authorized knowledge maintenance, update its relevant existing note or
create an ordinary Markdown note through Files: first confirm the exact target is absent,
use its returned resource for create-only, then read back. Preserve user content. Add a short
MEMORY link only when useful for later recall. Existing registered Notes keep their Notebook
catalog owner; read amux notebook --skill when those relationships need editing. No new Idea
object or fixed folder scheme is required. Saving an idea does not confirm a Goal or authorize
its execution. Source drafts and unsaved editor feedback remain drafts until saved and read back.

## Arrange a bounded reminder to yourself

Read amux schedule --skill, then amux schedule create --help. For authorized work that needs a
later check, discover your exact Session target and save one finite reminder with a clear purpose
and deadline. Say what was arranged and retain its schedule ID, revision and original operationId
for inspect, pause or cancel. Calendar timing and a relative once-only countdown share that owner.
An authorized own-task reminder does not enable recurring greetings, external messages or a
background reflection loop. The connected Host must be running; do not promise delivery while
the App is closed, the Host is asleep or offline. A reminder delivered is not work completed.

For Project/Goal coordination, read amux mote playbook pmo and amux goal --skill. The default PMO
role delegates detailed design and implementation to execution Agents in the target Project;
implement personally only when the user explicitly asks. Follow authorized work through delivery,
without supplying human goal confirmation or result acceptance. These local guides launch nothing,
send nothing, register no role and edit no user files. Missing resources or a busy manager retain
original drafts, request identities, healthy Agents and recovery actions.`
  },
  name: {
    summary: 'Early task self-naming, original naming history and persistence confirmation',
    roles: 'Agents naming their own task or inspecting an original name operation',
    when: 'Understand your task and role, refine a materially changed task, or inspect naming provenance and persistence',
    guide: `The original object owner holds displayName, source and nameRevision; names never
authenticate identity, ownership or execution. Read name history for the exact Agent/Tab
before a confirmation. Keep object identity, name source, operation and revision separate.

## Name your task early

Once you understand the task and your role, give your own Session a concise name describing
the current task and phase. A clear first request is enough; otherwise clarify the task first.
Do not wait for completion, use a fixed turn count, or claim planned work is already done.
Name once after understanding the task; refine only after a substantial task change and only
when the current name needs to change. Do not rename a Tab or another Agent for this purpose.

Use the full Session ID from whoami, then agent inspect to read displayName availability,
source and nameRevision. Read agent rename --help and use agent rename --derived with that
observed revision. If availability is unavailable or the revision is unknown, do not guess
revision zero or an identity. Preserve manual names, manual clears, launch names and retained
names with unknown provenance; the original naming owner enforces their priority.
If the name is protected, naming is unavailable, or the edit fails, continue the main task.
Do not loop on renaming, send naming reminders, or make naming a prerequisite for useful work.

Use agent rename or space rename for the original object's edit. Autonomous suggestions use
the supported derived mode, preserving manual names and manual clears. name confirm asks the
original owner to confirm one original name operation on disk without replaying its edit;
it is not a human naming approval. A derived label is not human approval either.
After an unknown edit/confirmation, read the same operation and current revision before any
further change. Current names cannot certify a lost response. Naming failures retain the
original Session, Run and user working surface; do not replace an object to obtain a name.`
  },
  notebook: {
    summary: 'Notebook catalog, exact note links and graph operations',
    roles: 'Agents reading or editing notes',
    when: 'Resolve, inspect or modify an original Notebook/Note',
    guide: `The Notebook owner holds note/catalog identities and revisions; note bodies stay in
their real filesystem source. Markdown is the only saved body; graph indexes are derived.
Use the original Files writer for content and notebook apply for organization or your own
follow relationship. Authorship comes from the trusted caller, never body declarations.

${AGENTMUX_NOTE_EDITING_PATH}`
  },
  schedule: {
    summary: 'Civil-time arrangements, one-shot countdowns and original lifecycle',
    roles: 'Authorized scheduling operators',
    when: 'Inspect, create, pause, resume or cancel a scheduled task',
    guide: `The scheduler owns schedule identity, timing, lifecycle and original run references.
Reading this module creates no schedule or periodic Loop. Begin with schedule list/inspect
and retain the exact schedule ID, current revision and requested trigger.
Use schedule list --data <FILE|-> with {"scope":{"hostId":"EXACT_HOST","workspacePath":"EXACT_WORKSPACE"}}
to read saved calendar arrangements and one-shot countdowns across discussions at that exact Host and
execution directory. scope and the complete target selector are mutually exclusive. A scope is a read
filter; it does not change any arrangement target or grant control authority. Keep each original Session.
The SDK schedule-calendar projection can show rule estimates in a finite visible window; those estimates
are not saved inputs, delivery receipts or authority to send. Create within the
user's authorization and original target. A finite own-task check may support already-authorized
work; it does not authorize recurring greetings, external actions or a background reflection loop.

Use schedule create --data <FILE|-> with the exact target {hostId,agentSessionId,providerId,
workspacePath}, original prompt and operationId. Choose exactly one timing form:
- calendar: an explicit civil-time once/daily/weekly/monthly/yearly rule with its timezone and policies.
- afterMs: a positive safe integer in milliseconds, for example 90000 for 90 seconds or 300000 for
  five minutes. This is a one-shot countdown, not a recurring interval. It cannot enable checkIn.

Read amux schedule create --help for the complete current schema. The first creation of the original
operation fixes nextCheckAt as its absolute deadline. Repeating the same operationId, restarting the owner
or pausing and resuming keeps that deadline. Pause suspends delivery, not time; resuming an overdue
countdown processes the original occurrence. One confirmed input delivery ends a countdown.
The connected Host must be running; App exit, sleep or offline delivery is not promised. Busy
Agents, user input and permission waits keep the original occurrence pending.

Inspect the current help for supported triggers and complete input. Pause/resume/cancel
change the exact schedule; they do not stop unrelated healthy Agents or accept its results.
Creation/activation, a timer firing, input delivery and completed business work are separate.
Inspect original schedule facts after an unknown result rather than making a duplicate.
Unavailable scheduler observations retain original schedules, Sessions and requests; report
the failed read and the same-owner recovery action. Goal supervision does not itself authorize
installing a recurring patrol, new task ledger or automatic resend.`
  },
  settings: {
    summary: 'Host/Executor configuration, resource preferences and maintenance',
    roles: 'Authorized configuration operators',
    when: 'Discover or explicitly modify current user configuration',
    guide: `The original configuration owner holds settings, Host routes, saved Executors and
resource revisions. Inspect the exact current owner and supported fields before changing
them. A saved route/template is not a connected Host, running Agent or human approval.

Read amux settings --help to select the exact configuration domain, then the matching leaf
help for its fields, authority, revision and save receipt. Discovering settings saves nothing.

## Local readable protocol reference

Settings → Message Tool → amux Protocols shows this app version's formats and original wire
examples using the shared message cards. The following list comes from this local CLI's
same Core definitions; it does not describe the connected Runtime or an older installation.
Reading a declaration does not authenticate its author, execute hints or grant permissions.

${AGENTMUX_PROTOCOL_CATALOG.map(entry => `- ${entry.title} (${entry.id}, ${entry.form})\n  ${entry.description}`).join('\n')}`
  },
  space: {
    summary: 'Durable spatial identities, display layout and exact navigation',
    roles: 'Agents opening, arranging or navigating workfaces',
    when: 'Inspect a visible layout or move an exact presentation',
    guide: `Core owns durable Space/Zone/Tab/Region identities, topology and bindings; the client
owns presentation, navigation and input focus. Inspect exact locations and display
Workspace/Group occurrences before changing a layout. A presentation move leaves execution
Host, cwd, Session and Run intact. Keep original operation receipts and all location candidates.

Read the client-owned Agent list order with amux space agent-order --display-workspace WORKSPACE.
With --input FILE|- provide {order:[{hostId,agentSessionId}],expectedOrder?:[...]} to change that
exact Workspace preference. An empty order restores creation order; new Sessions append.
This changes no placement, focus or Run. Applied order and confirmed storage durability are
separate receipts. After a partial/unknown save, read that exact scope before another write.

${SPATIAL_GUIDE}`
  },
  system: {
    summary: 'Endpoint, diagnostics, storage, crash evidence and metrics',
    roles: 'Agents diagnosing original owners',
    when: 'Inspect reachability, resource facts or retained failure evidence',
    guide: `System readers expose original owner observations, not a replacement Runtime ledger.
system endpoint discovers the selected service without connecting; its inspect form reads
the published owner. A responded endpoint certifies that response, not all Hosts or Agents.
system doctor/storage/crash-log/metrics keep source identity, observation time and partial
coverage. Use current help to discover exact reader contracts and authorization.

Metrics watch owns a reader; cancellation detaches that reader and never stops an Agent.
For a bounded explicit Web Animation instance read in one exact Renderer document, use
system metrics animations inspect --help. It does not attach a debugger or alter animations;
labels and play state are observations, not CPU ownership or Agent control facts.
For explicit Renderer heap/backing counters, use system metrics memory inspect --help;
that original command defines exact target, unknown coverage and debugger ownership boundaries.
Crash-log reveal is a separate presentation action, not a recovery. Missing diagnostics
remain unavailable/unknown, not proof that a healthy Run died or that a save succeeded.
Retain the original failure, operation and recovery path; do not restart or replace original
work merely because a diagnostic owner failed.

${DIAGNOSTIC_GUIDE}`
  },
  terminal: {
    summary: 'Terminal creation at an exact inspected destination',
    roles: 'Agents preparing an authorized terminal workface',
    when: 'Open a terminal after inspecting its intended workface',
    guide: `The client owns terminal presentation; ctxmux owns the actual process/PTY lifecycle
and bytes. terminal open targets an exact destination; it is a write that can start
work, not a read-only capability check. Discover the intended Tab/Region or new-Tab location
with space inspect and preserve existing content, drafts and healthy Runs. A displayed terminal
is not an Agent Session or evidence that a command completed.

Read terminal open --help for its current exact target and operation contract. Keep the
original operation and returned terminal/Run facts. After an unknown opening response,
inspect the same destination and original owner instead of opening another terminal or injecting
probe commands. Navigation and input eligibility remain separate from creation. For a new
split/Tab, read amux space --skill first and choose from the actual visible geometry.`
  },
  toolkit: {
    summary: 'Saved local tools, explicit execution, display evaluation and metrics',
    roles: 'Authorized local tool operators',
    when: 'Inspect, install, edit or explicitly run a saved tool',
    guide: `The Toolkit owner holds saved definitions, exact admissions and results. Reading this
module, configuration and passive readers do not execute scripts. Distinguish configuration,
action execution, display evaluation and each retained invocation identity before acting.

Read amux toolkit --help for the configuration/execution journey and the exact action's help
before running or changing a tool. Preserve the original operation after unknown results.`
  },
  topic: {
    summary: 'Topic categories, real knowledge sources and scoped migration',
    roles: 'Agents organizing or reading Topic materials',
    when: 'Discover or edit an original Topic/knowledge resource',
    guide: `The Topic owner holds categories, Topic identity and resource associations; knowledge
stays in real filesystem sources. Begin with topic category ls, topic ls/inspect and exact
knowledge ls/search/read. Preserve returned Host, resource path, Topic and document identity.
A Mote display location is not its knowledge directory. Missing/unavailable sources stay
explicit; do not replace a user's SOUL/Wiki or invent a parallel registry.

## Use the existing structure

- topic.md: short current purpose, confirmed context, key decisions, open questions and links to
  useful knowledge. Keep this entry current instead of growing it into a full work log.
- refs/: original source material and evidence, with enough provenance to find the originals.
- outcome/: reusable findings and deliverables, linked from the short Topic context when useful.
- .agents/: concise collaborator identity and handoff context, not report archives or live status.
- Wiki: selected startup instructions and context. Saving ordinary knowledge does not turn it into
  a Wiki rule or automatically inject it into every discussion.

Keep existing files and organization; these roles do not require a new taxonomy or moving old
material. When a Project or Task already owns code, bulk data or execution logs, link its relevant
evidence instead of copying it into Topic summaries or collaborator plaques. Existing structured
knowledge entries remain on topic knowledge ls/search/read/write; documents stay with Files.
For a Mote's identity and short MEMORY.md index, use amux mote --skill and its exact original home.

## Maintain useful knowledge

Read relevant saved context and results before repeating work or asking for decisions already made.
At a confirmed decision, important correction, reusable result or open commitment, assess what a
future collaborator needs. Before reporting a meaningful step complete, update the relevant original
knowledge and the short topic.md context or links when needed. No extra note is needed when nothing
useful changed; do not copy every turn or make maintenance a setup questionnaire.

Keep source, date, scope and evidence links, and distinguish facts, confirmed choices, inferences,
proposals, open commitments and completed work. Correct the relevant existing note or entry rather
than accumulating conflicting dated reports; mark superseded conclusions clearly and refresh links
so the old conclusion is not still presented as current. Preserve original evidence and unrelated
user material. Knowledge is context, not current authorization or live Project/Goal/Session/Run state.

Use amux file --skill for original documents and the current topic knowledge command help for
structured entries. Read the latest exact resource, save with its revision/CAS and read back before
claiming the knowledge is maintained. Report a needed update that was not saved or confirmed;
inspect the same original after an unknown result instead of blindly writing again. Keep credentials
out of ordinary knowledge. Do not start another Agent, schedule or extra model round for maintenance.
Saved files, delivery to a new Session and actual model use remain separate facts; existing Sessions
retain their earlier context and are not hot-updated or restarted by a file edit.

Create/move/write only within the authorized exact resource. Inspect current revision and
the current help before a change; retain operation and source references through the result.
Migration preview is a read; migration apply is a separate scoped write using its original
preview and expected facts. A preview or navigation never certifies a completed migration.
After an unknown write, read the same original Topic/knowledge/migration owner before an
explicit retry. Preserve original files and working surfaces until actual saved results
are confirmed, and report gaps rather than guessing that absent observations mean deletion.`
  },
  whoami: {
    summary: 'Authenticated caller, exact Session/Run and current capabilities',
    roles: 'Every Agent at entry',
    when: 'Establish current identity and available capabilities',
    guide: `whoami is an authenticated read of this caller's original Core identity, current Run,
capabilities and available presentation context. Run it once on entry, then preserve its
exact Session, Run and Host references. Environment hints, text headers and display names
do not authenticate an author. Capabilities and permissions come from the current owner,
not this guide or an inferred role.

A missing attached Region means relative self addressing is unavailable; it does not mean
the Session or Run ended. Use exact Session identity and global agent/app/space discovery
instead of choosing another Agent's Region. Partial/unknown facts remain explicit; retain
healthy input and original durable surfaces. To operate a capability, read its module and
current help first. This module read itself performs no whoami RPC, connection or lifecycle
action, and reading guidance does not prove a live model adopted it.`
  }
}

export interface AgentMuxCliModule {
  root: string
  summary: string
  roles: string
  when: string
  readCommand: string
}

function registeredRoots(): string[] {
  return [...new Set(AGENTMUX_CLI_COMMANDS.map(command => command.method.split('.')[0]!))]
}

export function agentMuxModuleSkillEntry(root: string): string | null {
  return registeredRoots().includes(root) && Object.hasOwn(definitions, root) ? `amux ${root} --skill` : null
}

/** Includes unsupported document slots honestly, so a missing owner is never silently hidden. */
export function agentMuxCliModuleCatalog(): readonly AgentMuxCliModule[] {
  return registeredRoots().map(root => {
    const definition = Object.hasOwn(definitions, root) ? definitions[root] : undefined
    return { root, summary: definition?.summary ?? 'Module guidance unavailable in this version',
      roles: definition?.roles ?? 'Use current command help', when: definition?.when ?? 'Inspect supported commands before acting',
      readCommand: `amux ${root} --skill` }
  })
}

/** Local versioned document rendering only: no service, filesystem or Runtime access. */
export function agentMuxModuleSkill(root: string): string | null {
  if (!agentMuxModuleSkillEntry(root)) return null
  const definition = definitions[root]!
  return `---\nname: amux-${root}\ndescription: ${definition.summary}.\n---\n\n# ${root} module\n\nRoles: ${definition.roles}.\nRead when: ${definition.when}.\n\n${definition.guide}\n\n## Current command contract\n\nRun amux ${root} --help to discover this version's executable operations; use leaf --help\nfor parameters, legal values and receipt fields. Help/parser are the argument source of\ntruth. Module skill and help reads neither connect to a service nor start, send or register\nanything. Available operations still depend on the selected owner, Host and Provider.\n`
}

export function agentMuxBaseSkill(): string {
  const directory = agentMuxCliModuleCatalog().map(module =>
    `| ${module.root} | ${module.when} | \`${module.readCommand}\` |`).join('\n')
  return `---\nname: amux\ndescription: Discover AgentMux identity, common boundaries and local module guides.\n---\n
Run \`amux whoami\` once on entry for your original identity and current unavailable facts.
Load only the module relevant to the task; if you know the domain, skip this directory.
Keep original operation identities after unknown replies; never automatically repeat effects.

## Module directory

| Module | Read when | Local guide |
| --- | --- | --- |
${directory}

Module and help reads are local: they do not connect, launch, send or register anything.
Use the needed action's \`--help\` for exact arguments and receipts. For literal positional
data, use \`amux --help MODULE ACTION\`. Guidance grants no permissions or proof of adoption.
`
}
