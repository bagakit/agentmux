import { browserPageCapabilityNames } from './browser-page-capability.js'

/**
 * 页面能力名渲染成散文里的一串。**从能力表取，不在文本里手打。**
 *
 * Skill 与 help 是 Agent 唯一的用法真相，它们此前把这些名字手抄了两处
 * （能力清单散文、`browser run` 那一节）。手抄的清单会漂：新增一个页面能力却忘了改这里，
 * Agent 就永远不知道它存在——而 tsc 守不到，因为这是字符串。
 *
 * 传 `effect` 而不是自己列名字，是为了让「哪些算观察、哪些算操作」这件事也只有一个答案：
 * 那个分类同时决定人工接管后拒绝谁（见 `browser-page-capability.ts`）。
 */
function capabilityList(effect: Parameters<typeof browserPageCapabilityNames>[0], separator = ' / '): string {
  return browserPageCapabilityNames(effect)
    .map((name) => `\`${name}\``)
    .join(separator)
}

/**
 * 三个例子——一个观察、一个动作、一个等待，用来在一句话里说明「有这类东西」。
 *
 * 取每类的**第一个**而不是写死位置下标：位置下标在有人重排能力表时会静默变成另一批名字，
 * 而这里想说的是「每类各举一个」，不是「取第 0、第 4、第 11 个」。
 * 空类别会被跳过而不是渲染出一个空的反引号对——那是「表被改坏了」该显形的地方，
 * 下面 `agentmux-cli-help.test.ts` 有一条钉住这三类都非空。
 */
function capabilityExamples(): string {
  return (['observe', 'act', 'wait'] as const)
    .flatMap((effect) => browserPageCapabilityNames(effect).slice(0, 1))
    .join(', ')
}

/**
 * 启动定向握手的动词名。启动引导（agent-outbound-message 的 runtime guide）指向它、CLI 分发注册它、
 * help/skill 记它的确切用法——名字只有这一处定义，改名时三处一起动，不各写一份等着漂移。
 */
export const AGENTMUX_SELF_CONTEXT_VERB = 'whoami'

export const AGENTMUX_CLI_HELP = `agentmux — typed local Agent and Desktop control

Usage: agentmux <intent> [options]
       agentmux --skill

Intents:
  whoami      Report your own Session, View, Region, Workspace, and available capabilities.
  doctor      Diagnose the local Runtime: capabilities, agents, endpoint storage and reclamation.
  endpoint    Print the Control endpoint path and schema version without connecting.
  inspect     Read an Agent Session, Run, Tab, Region, or the Desktop client without side effects.
  list        List configured agents, projects, or active Agent Sessions from their owners.
  settings    Read or change preferences supported by the running Desktop host.
  diagnostics Inspect the Desktop crash log or explicitly request it in the file manager.
  pmo         Give PMO Teams a bounded global snapshot and precise drill-downs.
  demand      List and update Board Demands and their explicit Session links.
  agent       Open an Agent, rename its desktop alias, or read that alias.
  space       Discover, inspect, move presentations, or rename an exact Tab.
  open        Open a Terminal or Browser at one exact spatial destination.
  browser     Drive an already-open Browser by running a program in it.
  send        Send one prompt to an exact Session or uniquely resolved presentation target.
  deliveries  Explicitly check and acknowledge your durable incoming message batch.
  discuss     Start a Discussion: create a dedicated Agent and deliver the first message.
  dispatch    Open, report and inspect supervision of existing durable Agent messages.
  handoff     Declare a communication handoff to another Agent Session.
  focus       Select a Space, Zone, Tab, Region, Goal, or Surface; preserve input by default.
  promote     Promote one Region into its own new Tab.
  arrange     Apply one explicit layout operation to a Tab.
  output      Read or follow one Agent Session's ordered output.
  interrupt   Interrupt one Agent Session through the Desktop Control Host.
  resume      Resume one Agent Session through the Desktop Control Host.
  stop        Stop one Agent Session through the Desktop Control Host.

Managed caller:
  AGENTMUX_ENV=1 and AGENTMUX_AGENT_SESSION_ID authorize the self selector.
  No command guesses from UI focus, titles, recent order, or terminal bytes.

Output:
  Success and failure are versioned JSON. Output --follow emits JSON Lines.

Learn:
  agentmux <intent> --help
  agentmux agent open --help
  agentmux space --help
  agentmux --skill

Options:
  --skill        Print Agent instructions and exit.
  --version, -V  Print version and exit.
  --help, -h     Show help.`

const EXECUTOR_REFRESH_HELP = `Check one saved Executor on one explicit Host

Usage: agentmux settings executors refresh <executor-id> --host <host-id>

Both IDs are exact literal data, including --help; labels, focus and defaults are never
inferred. No --all or draft input mode is supported. Main captures the committed Provider,
authored command and Host connection when it handles the request. Refresh does not save
configuration, send input, launch, stop or resume an Agent.

The result includes captured input and availability (available, missing or check-failed).
Available means a regular executable file was found. Missing means no usable file was
found, including a confirmed non-file path; it does not claim every path is absent.
Check-failed carries the original cause.code/message. A resolved executable is returned
only when Core obtained it. These facts do not include launch args, env or Agent health.

Exit 0 means the diagnostic completed; inspect availability and cause. No managed Agent
caller or open View is required. An offline Main returns CONTROL_UNAVAILABLE; the CLI
never reads configuration files directly. Refresh again after fixing the reported check.`

function resourceHelp(resource: 'executors' | 'prompts' | 'executors|prompts'): string {
  return `Read or commit host-owned ${resource}

Usage:
  agentmux settings ${resource} list
  agentmux settings ${resource} get <id>
  agentmux settings ${resource} add <id> --input <file|->
  agentmux settings ${resource} update <id> --input <file|->
  agentmux settings ${resource} remove <id> [--input <file|->]

Input is bounded UTF-8 JSON, read locally from a file or stdin (-). Add takes a field object;
the ID occurs only in the positional argument. Update takes {"changes": {...}, "expected": {...}}
with nonempty changes and optional expected fields. Remove optionally takes {"expected": {...}}
using a complete get value snapshot. Arrays and objects in a field replace that entire field.
The running host owns legal fields, defaults, identities, references and persistence.

IDs and input paths are literal data, including --help; no shell or environment expansion is
performed. List returns items and partial scope, including an empty list. Get returns one item;
add/update report the committed item and changed; remove reports the removed ID.
No Agent caller or open View is required. An unavailable host returns CONTROL_UNAVAILABLE;
the CLI never writes configuration files. Without a complete success reply, the commit result
is unconfirmed. Read current state before deciding; do not automatically retry the write.${resource === 'executors' ? `\n\n${EXECUTOR_REFRESH_HELP}` : ''}`
}

const SETTINGS_AUTHORITY = `Settings use the current Unix user's local configuration authority. Explicitly enabling
browser automation expands browser access; it does not establish human approval or bypass
Profile approval, control handoff, or native app-link choices.`

const BROWSER_LINKS_HELP = `Read or forget remembered native app-link choices

Usage:
  agentmux settings browser links list
  agentmux settings browser links forget <literal scheme>
  agentmux settings browser links forget --input <file|->

List returns entries (scheme and choice) with the exact stored strings, including an empty
list. Forget deletes the current answer when the running host processes the command; it
returns the exact scheme and changed. An absent answer is unchanged and the next link asks
again. This is not a comparison with a previous list snapshot. There is no choice setter.

One positional scheme is literal data, including --help, --input, empty strings, spaces and
colons. Only the alternative --input <file|-> shape reads bounded UTF-8 JSON locally, with
exactly {"scheme": string}. Use JSON for stored keys that argv cannot represent, such as NUL.
Do not mix carriers or add fields/options. The host receives the string, never the file path.

No managed Agent caller or open View is required. An unavailable host returns CONTROL_UNAVAILABLE;
the CLI never writes configuration files. A timeout does not establish whether Forget committed;
list before deciding the next action.
${SETTINGS_AUTHORITY}`

const WORKSPACE_ADD_HELP = `Register a project through the running host

Usage: agentmux settings workspaces add --input <file|->

Read bounded UTF-8 JSON locally from a file or stdin (-). The input is a field object with
hostId, path and an optional name. The host validates it, assigns id and kind, then returns
the actual committed item (id and value) and changed. Do not supply generated identity,
output-only fields, launch/focus instructions or extra options. Input file names, including
--help, are literal data; the host receives fields, never the input file path.

Folder paths are sent and stored literally, including trailing spaces: the CLI does not
trim, expand ~ or environment expressions, resolve an absolute path, inspect or create a
directory. Main trims the optional name; an absent, empty or whitespace name uses the last
nonempty folder path segment, or the path itself. Locations are compared using the host's
existing rules. The same host/location returns the original complete item and changed=false.

No managed Agent caller or open View is required. An unavailable host returns CONTROL_UNAVAILABLE;
the CLI never writes configuration files. Registration does not select/focus a project,
launch an Agent, run Git or create a worktree. Existing list projects discovery retains its
client activity semantics; no settings workspaces list/get/update/remove commands are added.
A timeout does not establish whether registration committed; inspect before deciding what to do next.`
const HOSTS_HELP = `Read saved Host configuration or test one exact connection

Usage:
  agentmux settings hosts list
  agentmux settings hosts test <id>
  agentmux settings hosts test --input <file|->

One positional ID selects the committed Host when Main handles the command. It is literal
data, including --help and --input; labels, focus and default Hosts are never inferred.
Alternatively, --input reads one complete, strict Host configuration from bounded UTF-8 JSON.
The two modes are mutually exclusive. Main receives the object, never the input file path.

Test returns the captured input, outcome (ready, unsupported or check-failed) and detail.
Exit 0 means the diagnostic request completed; inspect outcome to learn whether the connection
was ready. This does not save configuration, start an Agent, or implement unsupported SSH.
No managed caller or View is required. An offline Main fails without writing configuration.`

const CRASH_LOG_HELP = `Inspect the Desktop crash log

Usage:
  agentmux diagnostics crash-log
  agentmux diagnostics crash-log reveal

The running Desktop host checks its fixed local path without reading log contents.
Read returns path and outcome: present, absent or check-failed (with original cause).
Exit 0 means the diagnostic completed, not that the Agent is healthy or no crash occurred.
Reveal is explicit: success means requested, not that a file manager is visible.
Absent, inaccessible or nonregular paths and failed requests return a typed error.
No path, input file, managed Agent or View is required. Offline Main returns CONTROL_UNAVAILABLE;
the CLI never reads the log directly. Configuration and running Agents are unchanged.`

const DEMAND_CREATE_GUIDE = `Discover the current Project with agentmux list projects and use its exact projectId.
settings workspaces add returns a Workspace id; it is not the Project id.

Demand creation also records a routing decision:
  --risk low|medium|high|unknown
  --confirm automatic|user|pending
  --wiki-version <version>
Defaults are risk=unknown and confirmation=pending; they do not authorize a write.
Choose the actual risk and carry the authorization already given for this scoped Demand write.
Use --confirm user only when the person has explicitly authorized it; automatic records an
authorized policy decision, and pending records unresolved authorization. Never invent either.
A known Project, known risk and actual authorization are required by the existing write owner.
These flags do not confirm the Goal alignment or accept its results; those remain human actions.
After registration, rediscover the Project before creating or linking a Demand. Parse the
actual receipt and inspect the Demand; do not guess an identity or retry an unconfirmed write.`

const HELP = new Map<string, string>([
  ['diagnostics', CRASH_LOG_HELP],
  ['diagnostics.crash-log.get', CRASH_LOG_HELP],
  ['diagnostics.crash-log.reveal', CRASH_LOG_HELP],
  ['settings.hosts', HOSTS_HELP],
  ['settings.hosts.list', HOSTS_HELP],
  ['settings.hosts.test', HOSTS_HELP],
  ['settings', `Read or change host-owned settings

Usage:
  agentmux settings get [target]
  agentmux settings hosts list
  agentmux settings hosts test <id>
  agentmux settings hosts test --input <file|->
  agentmux settings set <key> <value>
  agentmux settings executors|prompts list|get|add|update|remove [arguments]
  agentmux settings executors refresh <executor-id> --host <host-id>
  agentmux settings browser links list
  agentmux settings browser links forget <literal scheme>
  agentmux settings browser links forget --input <file|->
  agentmux settings workspaces add --input <file|->

The running Desktop host owns setting keys, legal values and defaults. Get returns the
supported entries with their current value, default, scalar kind and optional enum; partial
means other settings are not exposed by this host. Use those exact keys with set.

Values are positional data. Quote spaces; a literal --help in the value position is data.
No Agent caller or open View is required. The Desktop host must be running: an unavailable
host returns CONTROL_UNAVAILABLE; the CLI never writes its configuration files directly.
Success and failure use versioned JSON receipts. Set reports the committed entry only after
persistence succeeds. Without a complete success reply, the commit result is unconfirmed.
Read current state before deciding; do not automatically retry the write. Run settings executors --help or settings prompts --help for resource input,
settings browser links --help for remembered link choices, or settings workspaces --help
for project registration.
${SETTINGS_AUTHORITY}`],
  ['settings.browser', BROWSER_LINKS_HELP],
  ['settings.browser.links', BROWSER_LINKS_HELP],
  ['settings.browser.links.list', BROWSER_LINKS_HELP],
  ['settings.browser.links.forget', BROWSER_LINKS_HELP],
  ['settings.workspaces', WORKSPACE_ADD_HELP],
  ['settings.workspaces.add', WORKSPACE_ADD_HELP],
  ['settings.executors', resourceHelp('executors')],
  ['settings.executors.refresh', EXECUTOR_REFRESH_HELP],
  ['settings.prompts', resourceHelp('prompts')],
  ['settings.resource.list', resourceHelp('executors|prompts')],
  ['settings.get', `Read host-owned settings

Usage: agentmux settings get [target]

Without a target, read all entries currently supported by the running Desktop host. A target
selects a host-defined group or exact key. The result contains entries (key, value, default,
kind and optional enum) and an explicit partial scope. Keys and values come from the host;
this offline help does not define them. No Agent caller or View is required.
An unavailable host returns CONTROL_UNAVAILABLE; unsupported targets return UNSUPPORTED_SETTING.`],
  ['settings.set', `Commit one host-owned setting

Usage: agentmux settings set <key> <value>

Read settings get first to discover supported keys and legal scalar values. Values are
positional data, so --help in the value position is sent literally; quote spaces.
The running Desktop host validates and persists the value before returning its committed
entry. Unsupported keys return UNSUPPORTED_SETTING; invalid values return INVALID_SETTING_VALUE.
No Agent caller or View is required. An unavailable host returns CONTROL_UNAVAILABLE without
writing any configuration file. Without a complete success reply, the commit result is
unconfirmed. Inspect settings get for current state; do not automatically retry the write.
${SETTINGS_AUTHORITY}`],
  ['whoami', `Report your own coordinates and available capabilities

Usage:
  agentmux whoami

Answers the startup question "who and where am I" from existing Session projection facts:
your Agent Session id, Provider and Executor, host, Workspace path, current Run, and the
capabilities available to you. When a Desktop View is attached it also reports your View,
Region, and the neighbors you can split against. Topic is not reported here: the Scratch
topic.md and .agents/ files on disk are its source of truth — read them to find your Topic
and collaborators. Requires a managed Agent caller. No View attached is a normal answer,
not a failure.`],
  ['endpoint', `Print the Control endpoint so another client can connect

Usage:
  agentmux endpoint

Answers "where do I connect, and which protocol version is this" for a client written in any
language. The Control endpoint is a unix socket carrying newline-delimited JSON: one request
object per line, one receipt object per line.

The socket path is not guessable from outside — it is derived from the pinned runtime artifact
digest, so it changes when that artifact changes. Ask for it here instead of recomputing it;
an upgrade moves it and a recomputed copy would go stale silently.

This command does not connect. It answers the same way whether or not an owner is currently
listening, because a client needs the address before it can dial. "Nobody is listening right
now" is a different question — ask 'agentmux doctor' for that. AGENTMUX_RUNTIME_DIRECTORY
selects the short endpoint root, and the answer follows it. AGENTMUX_STATE_DIRECTORY
independently selects durable state; neither override implies the other.
`],
  ['inspect', `Inspect one exact owner identity without changing focus

Usage:
  agentmux inspect --client
  agentmux inspect --session <session-id|self>
  agentmux inspect --run <run-id>
  agentmux inspect --tab <tab-id|self>
  agentmux inspect --region <region-id|self>
  agentmux inspect --provider-native <native-id> --provider <provider-id>
  agentmux inspect --acp-native <native-id> --adapter <adapter-id>

Inspect --client reads the existing Desktop presentation, overlays, floating View and input
owner without changing them. Its content-free snapshot cannot confirm a past request.
Session/Run/native inspection reads Core truth. Tab/Region inspection requires the
Desktop Control Host. Inspect --tab returns every closed-union Region surface and
normalized bounds. Missing, stale, or ambiguous self fails closed.`],
  ['list', `List configured Agents, Projects, or active Agent Sessions

Usage:
  agentmux list agents
  agentmux list projects
  agentmux list active-agents
  agentmux list sessions

Agents are Desktop-configured executors with availability. Projects group resources by Host
and repository root (or directory root); Project IDs are not Workspace IDs.
Active Agents are live Session projections grouped by Project. Sessions are Core-owned live
or historical Agent Session status entries. Never infer a target from order.`],
  ['pmo', `Read the global PMO Teams observation surface

Usage:
  agentmux pmo snapshot [--project <id>] [--agent <session-id>] [--demand <id>] [--limit <n>]
  agentmux pmo projects|workspaces|topics|agents|sessions|demands|activity [filters]
  agentmux pmo inspect [--project <id>|--agent <session-id>|--demand <id>]

The response is bounded, versioned JSON. Projects, active Agents, Sessions, and Demands
come from their existing owners and retain unknown/error facts instead of guessing. Topic
discovery stays filesystem-scoped; an unavailable scope is returned as a typed observation,
not an empty claim that no Topics exist (\`TOPIC_FILESYSTEM_SCOPE_REQUIRED\`).`],
  ['deliveries', `Explicitly consume your durable incoming messages

Usage:
  agentmux deliveries check --limit <1..100>
  agentmux deliveries ack --generation <generation> --reader-run <Run from check>

Requires your current managed Agent capability. Check is recipient-scoped and repeats
exactly the same batch until you explicitly acknowledge it. It never sends or resumes.
A replacement Run takes over unread IDs with a new generation; an old Run cannot ack it.
Acknowledgement advances only your consumption cursor, not delivery, human reading,
Agent acceptance, Dispatch waiting or task completion.`],
  ['deliveries.check', `Check your exact durable incoming batch

Usage: agentmux deliveries check --limit <1..100>

Returns your authenticated Session, readerRun, generation and messages. Repeating before
ack returns the same exact IDs even when the limit or new arrivals change. Each message
keeps its actual delivery facts; queued or failed does not mean input was accepted.`],
  ['deliveries.ack', `Acknowledge exactly the checked batch

Usage: agentmux deliveries ack --generation <generation> --reader-run <Run from check>

The capability, current Session binding and stored readerRun/generation must match.
Returns exact acknowledged IDs and the next generation. Wrong/empty/stale batches fail;
no message body, delivery fact, other recipient cursor or Agent lifecycle is changed.`],
  ['agent', `Operate an Agent through its exact Executor or Session identity

Usage:
  agentmux agent open --help
  agentmux agent rename --session <exact-session-id> (--name <text>|--clear)
  agentmux agent inspect --session <exact-session-id>

Use agent open to create an Agent in a Zone or add a presentation of an existing Session.
Discover exact Executor IDs with agentmux list agents and destinations with agentmux space ls.
agent inspect reads only the Desktop display override; inspect --session reads Core facts.`],
  ['agent.rename', `Set or clear one exact Agent's Desktop display override

Usage: agentmux agent rename --session <exact-session-id> (--name <text>|--clear)

Exactly one name action is required. Names are raw data, including spaces and --help;
the existing display-name owner trims text and treats empty text as clearing the override.
The target must be an Agent currently observed by this Desktop. Missing facts mean unknown,
not retired. Execution cwd, Session/Run, layout, focus and drafts are preserved.
--request-id <id> is optional. One JSON receipt returns the actual override or null,
changed, outcome and save facts. Save failure retains the applied name and exits nonzero
with outcome partial. diskDurability stays unconfirmed after the platform's void flush.
After a lost receipt, read the current alias with agent inspect; that read does not certify
the earlier request or repeat the write.`],
  ['agent.inspect', `Read one exact Session ID's current Desktop display override

Usage: agentmux agent inspect --session <exact-session-id> [--request-id <id>]

Returns agentSessionId and override (string or null) from the existing Desktop name owner,
including a saved alias when current Session facts are absent. Null means no display
override; it does not prove existence, retirement, health or an earlier request's outcome.
This read does not rename, save, refresh or recover. Core facts use inspect --session.`],
  ['agent.open', `Open a new Agent or an additional presentation of an existing Session

Usage:
  agentmux agent open --executor <exact-executor-id> [--prompt <text>] <destination>
  agentmux agent open --session <exact-session-id> <destination>

Destination selectors:
  --space <space-id>  --zone <zone-id>  --tab <tab-id>  --region <region-id>
  --new-tab          --split <left|right|above|below>

A Region implies its parents; --split adds a neighbor. Without split it must be empty.
A Tab requires exactly one empty Region. Space/Zone without Tab/Region creates a new Tab,
including the first Tab. A Space with multiple Zones returns exact candidates; no default
Zone is guessed. All supplied parents must agree. A target is required; run agentmux space ls.

Create a Zone in an exact Space:
  --space <id> --new-zone --worktree --path <absolute-path> --new-branch <branch>
  --space <id> --new-zone --worktree --path <absolute-path> --branch <existing-branch>
  --space <id> --new-zone --directory <existing-absolute-directory>

Git options create or use a branch from the existing Git owner's HEAD contract. No reset,
force, automatic naming, or cleanup is performed. The directory form does not run Git.
Existing --session accepts neither --prompt nor --new-zone and preserves the original view,
execution Host and cwd. Later tasks use send --to-session; initial prompt is delivered only
by the same Core creation operation. confirmed proves that protocol, not task acceptance.

All opens run in the background by default; --focus explicitly navigates to the result.
--request-id <id> supplies a caller-known identity; otherwise the CLI generates one. Exactly
one final JSON receipt reports the IDs, outcome, retained resources, initialPrompt and save
facts. partial/unknown exits nonzero while retaining the typed report and healthy Agent.
A flush request has no disk ACK: diskDurability remains unconfirmed. After a lost receipt,
use agentmux space inspect --request <request-id>, without blind spawn or resend.`],
  ['space', `Discover and manipulate client-owned spatial presentations

Usage:
  agentmux space ls [--space <space-id>|--zone <zone-id>]
  agentmux space inspect --space <id>|--zone <id>|--tab <id>|--region <id>
  agentmux space inspect --request <request-id>
  agentmux space mv --from-region <id> --expect-session <id> <destination>
  agentmux space rename --tab <exact-tab-id> (--name <text>|--clear)

Space, Zone, Tab and Region IDs are opaque exact strings, including JSON directory keys.
Space is the working surface owner; Project is a separate repository/directory grouping.
Zone is a general execution resource, which may be a worktree, directory or Topic/Mote home.
Discovery does not focus, read terminal bodies or probe every Session's readiness.
Run each subcommand with --help for its exact grammar.`],
  ['space.ls', `Discover exact spatial IDs without changing focus

Usage:
  agentmux space ls
  agentmux space ls --space <space-id>
  agentmux space ls --zone <zone-id>

No filter returns all Space summaries; a Space returns its Zones; a Zone returns its
Tab/Region metadata. IDs can be copied unchanged into agent open, space inspect or space mv.
This read does not enumerate terminal bodies, timelines or readiness probes.`],
  ['space.inspect', `Inspect one exact spatial object or reconcile a Request

Usage:
  agentmux space inspect --space <id>|--zone <id>|--tab <id>|--region <id>
  agentmux space inspect --request <request-id>

Exactly one selector is required. --request cannot be combined with another selector.
Request inspection returns known/report facts from the existing owners; it never repeats
Git creation, Agent spawn, initial prompt delivery, movement or navigation. Unknown Requests
and reports with partial/unknown outcomes retain their single JSON receipt and exit nonzero.`],
  ['space.rename', `Set or clear one exact Tab's display override

Usage: agentmux space rename --tab <exact-tab-id> (--name <text>|--clear)

Exactly one name action is required. Names are raw data; the existing owner trims them
and treats empty text as clearing. The Tab is addressed by its entity ID, including across
display Workspaces; no current Workspace or resource ownership is guessed. This does not
rename Space, Zone or Topic titles, or change execution, layout, focus or drafts.
--request-id <id> is optional. One JSON receipt returns actual override or null, changed,
outcome and save facts. Save failure keeps the applied name and returns partial/nonzero;
diskDurability remains unconfirmed. space inspect --tab <id> reads the current Tab name.`],
  ['space.mv', `Move one exact Agent presentation without changing its execution context

Usage:
  agentmux space mv --from-region <source-id> --expect-session <session-id> <destination>

Destination: --space <id>, --zone <id>, --tab <id>, or --region <id> with optional consistent
parents. Space/Zone creates a new Tab, optionally explicit --new-tab. --region with --split
<left|right|above|below> creates a neighbor; without split it must be empty. No new Zone is
created. Exact source Region and expected Session are required even with multiple views.

The same Region/Session/Run and original execution Host/cwd are retained. Other views are
not merged or removed. Self move is unchanged. No stop, resume, spawn or send is performed.
Background is the default; --focus explicitly navigates. --request-id <id> is optional.
The single final JSON receipt reports from/to, partial/unknown and separate save facts;
partial/unknown exits nonzero. diskDurability remains unconfirmed after a void flush request.
After a lost reply, use space inspect --request; do not repeat the move blindly.`],
  ['dispatch', `Supervise an already recorded Agent message

Usage:
  agentmux dispatch open --source-message <message-id>
  agentmux dispatch report --source-message <message-id> --reply-message <message-id> --kind <question|escalation|worker_done|cleanup>
  agentmux dispatch show --source-message <message-id>

The source message is the Dispatch identity. Core derives owner, worker and thread from
its immutable Agent-authored envelope. Open requires the source sender's current capability;
show permits either participant. The worker reports question, escalation or worker_done;
the owner reports cleanup. Every report references an existing reply to that exact source
in the same thread, with the matching participants. Same reply/kind replays once; a different
kind conflicts. Separate replies remain separate questions.

Only worker_done settles communication waiting. Delivery, consumption ACK and cleanup
never complete an external Task or Demand. These commands send no input and change no
Agent lifecycle. Historical message Runs must still belong to retained Session identity
history; unavailable identity or message bodies are reported explicitly, never reconstructed.`],
  ['dispatch.open', `Open supervision for an existing source message

Usage: agentmux dispatch open --source-message <message-id>

Requires the current capability of the source sender. Replays the original open time and
all recorded events. It creates no Task, message, input or Session.`],
  ['dispatch.report', `Record one actual reply as a supervision event

Usage: agentmux dispatch report --source-message <message-id> --reply-message <message-id> --kind <question|escalation|worker_done|cleanup>

Worker: question, escalation, worker_done. Owner: cleanup. The reply must name this exact
source via replyTo and share its thread and participant direction. Replay of the same reply
and kind retains the first event time. A conflicting kind is refused without writing.`],
  ['dispatch.show', `Inspect retained communication supervision

Usage: agentmux dispatch show --source-message <message-id>

Either currently authorized participant can inspect the durable open time, actual reply
IDs and waiting fact. Missing referenced messages or historical identity produce an explicit
unavailable error; this never affects ordinary Agent input or other recipients' messages.`],
  ['open', `Open a Terminal or Browser at one exact destination

Usage:
  agentmux open terminal [--command <shell-command>] <destination>
  agentmux open browser --url <url> <destination>

Exactly one destination is required:
  --left-of <region-id|self>      --right-of <region-id|self>
  --above <region-id|self>        --below <region-id|self>
  --tab <tab-id|self> --new-tab   --in-region <launcher-region-id>

Terminal shell command and Browser URL are delivered once to their respective owner.
Agent creation uses agentmux agent open and its Space/Zone destination grammar.`],
  ['open.terminal', `Open a Terminal

Usage: agentmux open terminal [--command <shell-command>] <destination>

Exactly one destination from open --help is required. --command runs once through the
host shell at Terminal creation; it is never typed into an attached terminal.`],
  ['open.browser', `Open a Browser

Usage: agentmux open browser --url <url> <destination>

Exactly one destination from open --help is required. The Main Browser owner validates
and opens the URL; Renderer layout state does not own Browser navigation truth.
Control Browser open preserves the current Workbench selection; placement does not
request input focus. Inspect the returned Tab/Region to find the Browser. Use the separate
focus command only when the person explicitly wants to navigate there.

A link the view cannot render — a custom application scheme, \`mailto:\` and anything
else that belongs to a desktop app — is handed to the system instead, after asking the
person once. The answer is remembered per scheme, not per site, and is theirs to give:
\`open browser --url\` only accepts http(s) and file, so this is about links the page
itself leads to.`],
  ['browser', `Drive an already-open Browser

Usage:
  agentmux browser run --browser <browser-id> [--operation <operation-id>] < program.js
  agentmux browser history [--browser <browser-id>]
  agentmux browser operation --operation <operation-id>
  agentmux browser stop --operation <operation-id>
  agentmux browser follow --operation <operation-id> [--after-sequence <n>]
  agentmux browser replay --browser <browser-id> --operation <operation-id> [--preview | --step <n> | --run]

\`open browser\` opens one; \`browser run\` drives one that is already open. Two different
things, two commands — neither replaces the other.

An operation outlives the connection that started it. Pass your own \`--operation <id>\` to
\`browser run\` and that id is addressable before the program starts: another shell, another
process, or this one after a reconnect can ask \`browser operation\` how it is going,
\`browser follow\` to watch it as it happens, and \`browser stop\` to stop it. All three address
the operation by id alone — you do not need to know which Browser it is running in.`],
  ['browser.run', `Run a program in an open Browser

Usage:
  agentmux browser run --browser <browser-id> [--operation <operation-id>] < program.js
  echo 'return await snapshot()' | agentmux browser run --browser <browser-id>
  agentmux browser history [--browser <browser-id>]
  agentmux browser operation --operation <operation-id>
  agentmux browser stop --operation <operation-id>
  agentmux browser replay --browser <browser-id> --operation <operation-id> [--preview | --step <n> | --run]

The program is read from stdin as a whole — there is no --code flag, because a real program
contains quotes, backslashes and newlines that every shell layer would re-escape.

It runs as an async function body in an isolated subprocess, so \`await\` and \`return\` both
work, and a runaway program cannot take AgentMux down with it. Page functions (${capabilityExamples()}, …)
are injected into that subprocess; \`agentmux --skill\` lists them.
Elements are addressed by the refs a snapshot hands you — never coordinates.
\`snapshot(options)\` and \`snapshotText(options)\` accept \`scope: "page"|"viewport"\`,
\`within\` (a unique CSS region in the main document), \`withinRef\` (an issued ref's actual document),
\`interactiveOnly\`, and \`maxNodes\` (default 200, maximum 1000). Use either within or withinRef.
Observation counts distinguish the full captured graph, scoped/matched nodes and returned nodes.
Omitted documents are excluded by scope; missingFrames are failed reads. A small response does
not mean fewer AX trees were captured. Each call replaces the prior snapshot, including snapshotText;
use its newest refs. Superseded refs in the same run are refused rather than retargeted.

A ref outlives the run that issued it: refs from an earlier \`browser run\`, even from before
AgentMux restarted, are matched back onto the page by what they pointed at (role, name, and
which one of the same-named). That match is by appearance, not identity — it can land on a
different element that looks the same — so a run that used one is reported \`indeterminate\`
with the details, not \`completed\`.

Requires Agent browser automation to be enabled in Settings › Browser. It is off by default,
and the refusal says so rather than failing quietly.

Every receipt also includes an \`operation\` object with one stable operation id, the operator identity,
ordered semantic steps, and a replay reference. Keep that id when refining a program: it is the join key
for the Browser activity timeline, the desktop operation journal, and later replay. Raw passwords, cookies,
page text, coordinates, and opaque JavaScript/CDP arguments are never stored in replay facts; sensitive
steps remain explicit review gates.

That id only arrives with the final receipt, which is too late to ask about a program still
running. Pass \`--operation <id>\` to choose it yourself, and it is addressable from the moment
the program starts: \`agentmux browser operation --operation <id>\` says how it is going, and
\`agentmux browser stop --operation <id>\` stops it. Neither needs the same connection, the same
process, or the Browser id — the operation, not the request, is what those two address, so a
disconnect does not take the operation with it. Asking about an id we have no record of is a
successful answer of nothing, not a failure; stopping one that has already finished answers
with its existing outcome.

A person can take the page back at any time: a real click, keypress or scroll on that Browser
hands ownership to them mid-run. Actions (click, fillInput, gotoUrl, js, cdp, …) are refused
from that moment on; observation (snapshot, pageInfo, waitFor…) keeps working so the program
can see where it left things. The page carries a badge while a program is driving it, and the
Tab it sits in is marked too, so the takeover is a deliberate act, not a surprise — they can
see which Browser you are in without switching to it. A subsequent \`browser run\` stays refused
until the person explicitly chooses Return to Agent (or an equivalent handoff control).

Large JSON return values become a durable \`browser-result-artifact\` reference (8 MiB per value,
64 MiB retained store). Small values up to 128 KiB, including undefined/null, return inline.
Keep the original reference; its Workspace, Browser, operation and source must stay intact.
Use \`return await readResult(reference, {offset: 0, maxBytes: 65536})\` in this Browser to read
base64 bytes, totalBytes and nextOffset. Join decoded bytes then parse JSON. A navigation or
restart does not require rerunning the original actions. Each read stays bounded; missing or
evicted results are explicit. A Browser without a verified Workspace still runs small scripts;
durable result capture is unavailable. If capture fails, actions may already have happened:
inspect the page and do not automatically rerun the script.

For binary files, use \`return await download(ref, {path: "report.bin", timeoutMs: 30000})\`.
The native listener is registered before the current ref is clicked. Only a completed transfer
published into this Browser's verified Workspace returns a \`browser-download-file\` reference;
cancelled/failed receipts have no file reference. Retain the original reference and use
\`return await readDownload(reference, {offset: 0, maxBytes: 65536})\` to read base64 bytes,
revision, totalBytes and nextOffset without triggering the download again. Navigation and
ordinary application restart preserve completed references. Read cost also reports the complete
bounded file scan used to verify its revision. Unknown Workspace binding is explicit; a failed
transfer never fabricates a Workspace file or blocks later healthy Browser programs.

Use \`return await uploadFiles(ref, ["attachments/report.bin"])\` on an actual file input from
this run's latest \`snapshot()\`. Upload refs are never recovered from an earlier run's ledger;
expired refs and a changed document require a fresh snapshot. The verified Workspace supplies
1–4 bounded files (16 MiB each); their exact bytes are pinned before assignment and the actual
FileList is verified. The receipt contains relative paths, names, byte counts and revisions.
Selected-file snapshots remain available after script completion until that Browser navigates
or closes. If assignment or acknowledgement is uncertain, inspect the original input and do
not automatically repeat it. File chooser dialogs are unsupported; select the actual input.

The receipt carries \`result\` (whatever the program returned), \`logs\` (everything it printed,
including on failure), and \`outcome\`, which is one of four:
  completed      the program finished
  script-failed  the program threw — fix the program
  stopped        we cut it off — the program is fine. Either its scale is (too slow, too much
                 output), or a person took the page back mid-run. Actions before that point
                 did happen; nothing after did. Run it again once the page is free.
  indeterminate  WHAT ACTUALLY HAPPENED IS UNKNOWN, for a reason the message names:
                 the process died partway (an action may already have been applied once), or a
                 ref from an earlier run was matched back by appearance and may have landed on a
                 look-alike, or the actions ran but their result could not be retained.
                 Look at the page before retrying — do not blind-retry.`],
  // 剩下四个 browser 子命令各有自己一条。`operationPath` 把 `browser <verb>` 拼成 `browser.<verb>`，
  // 所以少一条不是"退回上一级"，而是一句 "Unknown command"——一个真实存在的命令被 --help 说成不存在。
  // （`history` 与 `replay` 在此之前正是这个状态。）
  ['browser.history', `Read what has already happened in a Browser

Usage:
  agentmux browser history [--browser <browser-id>]

Lists past operations with their ids, operators, ordered steps and outcomes. Omit --browser to
list every Browser on this machine — after a restart you may not remember which id you opened,
and listing first is exactly what this serves.

This is the only way to obtain an operation id after the fact, so it is the entry point for
\`browser replay\`. It does not require Agent browser automation to be enabled: wanting to review
what happened should not be blocked by the switch that lets a program drive the page — when
something went wrong, turning automation off is the first thing a person does.`],
  ['browser.operation', `Ask how one operation is going, by id

Usage:
  agentmux browser operation --operation <operation-id>

Addresses the operation by id alone — no Browser id, no particular connection. A client that
reconnects, or a different process entirely, can ask about an operation it did not start.

The answer is one of four states, and they never collapse into each other: still running,
completed, stopped, or indeterminate. The last one means the application restarted while the
operation was live, so what actually happened is unknown — an action may already have been
applied once. Do not blind-retry on it.

An id we have no record of is answered with nothing, successfully: it may come from another
machine, or have aged out of the journal. That is not a failure of the Browser.

Use \`browser history\` when you do not have an id yet; this command when you do.`],
  ['browser.stop', `Stop one operation, by id

Usage:
  agentmux browser stop --operation <operation-id>

Stops the operation, not your request. Any connection can stop any operation it has the id for:
the one that started it, another shell, or this one after a reconnect. Closing a connection
never stops the operation it started.

Stopping one that already finished answers with its existing outcome instead of failing — under
real timing a stop almost always races a program that just finished, and reporting that race as
an error would leave you unable to tell "I was too late" from "something broke". An id we have
no record of is likewise answered with nothing, and takes nothing away from the Browser.

A stopped operation's outcome is \`stopped\`, never \`script-failed\`: the program was fine, we cut
it off. Actions before that point did happen; nothing after did.`],
  ['browser.follow', `Watch one operation's progress as it happens

Usage:
  agentmux browser follow --operation <operation-id> [--after-sequence <n>]

Prints a stream, not one receipt: an \`attached\` frame first, then one \`progress\` frame per event,
then \`end\`. The envelope matches \`agentmux output --follow\`, so one parser reads both. Ctrl-C
ends it; so does the operation finishing.

The \`attached\` frame carries \`gap\`. Only a bounded number of events is retained, so "the stretch
you asked for is already gone" is a state that will happen, not an anomaly — and it is said in
the first frame rather than left for you to infer from a jump in sequence numbers. \`gap: null\`
means nothing is missing. A \`droppedThrough\` value means everything up to and including that
sequence is unavailable; the timeline you are holding is incomplete, and \`browser operation\`
gives you a complete snapshot to realign against.

Every event carries a \`sequence\`. Pass the last one you saw as --after-sequence to resume after
a disconnect. Sequences are per-process: after a restart the numbers start over, because the
owner has no basis for claiming to know what the previous process had already dropped.

Watching does not require Agent browser automation to be enabled, and does not keep the
operation alive — closing the stream stops the watching, never the work.`],
  ['browser.replay', `Replay the steps recorded from an earlier operation

Usage:
  agentmux browser replay --browser <browser-id> --operation <operation-id> [--preview | --step <n> | --run]

Replays a plan we recorded, not code you wrote — that is why it is not \`browser run\`. The plan
generator re-checks page identity and each target as it goes, and keeps sensitive steps as
explicit review gates. Those checks come from the owner; a program asked to replay itself would
be vouching for its own targets.

Three modes, three different jobs:
  --preview    fetch the plan without touching the page — look before doing
  --step <n>   perform only step n — pick up after a failure
  --run        perform the whole plan (the default)

A recorded ref is matched back onto the page by what it pointed at, not by identity, so a replay
that relied on one is reported \`indeterminate\` rather than \`completed\` — it may have landed on a
look-alike. Get operation ids from \`browser history\`.`],
  ['discuss', `Start a Discussion with a dedicated Agent

Usage:
  agentmux discuss --agent <executor-id> --text <first message> [--provider <provider-id>]

Core creates a dedicated Agent Session and delivers the first message as its launch Prompt.
The author is resolved by Core from your invocation capability — the caller cannot claim to be
another Agent. AGENTMUX_AGENT_SESSION_ID is context only, never authentication.

The launch Prompt is transport for the first ledger message; the Message ledger stays the only
message truth. A launch delivery proves at most \`delivered\` — never that the target accepted
or replied. Re-running with the same request id returns the same Thread and never re-injects
the Prompt.

Cross-workspace delivery is refused. Remote targets are not supported yet.`],
  ['demand', `Manage a Board Demand

Usage:
  agentmux demand list [--status <status>] [--project <project-id>] [--executor <executor-id>] [--session <session-id>] [--limit <n>]
  agentmux demand show --demand <demand-id>
  agentmux demand create --title <title> [--description <text>] [--project <project-id>] [--status <status>] [--priority <priority>]
    [--session <session-id>] [--risk low|medium|high|unknown] [--confirm automatic|user|pending] [--wiki-version <version>]
  agentmux demand update --demand <demand-id> [--title <title>] [--status <status>] [--priority <priority>]
  agentmux demand update --demand <demand-id> --alignment <proposal-json>
  agentmux demand update --demand <demand-id> --grounding <proposal-json>
  agentmux demand assign --demand <demand-id> [--project <project-id>] [--executor <executor-id>] [--start]
  agentmux demand start --demand <demand-id> [--session <session-id>]
  agentmux demand handoff --demand <demand-id> [--executor <executor-id>] [--session <session-id>]
  agentmux demand delete --demand <demand-id> --confirm delete
  agentmux demand link-session --demand <demand-id> --session <session-id>
  agentmux demand link-project --demand <demand-id> --project <project-id>
  agentmux demand decision-log --demand <demand-id>

${DEMAND_CREATE_GUIDE}

Demand is the Board identity. Session links are explicit execution facts; a Demand can have zero,
one, or multiple linked Sessions.`],
  ['handoff', `Declare a communication handoff to another Agent Session

Usage:
  agentmux handoff --to-session <session-id> --task <caller-reference>

Core authenticates the caller and returns the declared recipient, caller reference and
originAwaits=false. This declaration does not update external Task ownership, prove receiver
acceptance, deliver a message or open a Session. Use send or discuss to deliver text;
verify external responsibility in its actual owner.`],
  ['send', `Send one prompt without resuming or broadcasting

Usage:
  agentmux send --to-session <session-id|self> --text <prompt>
  agentmux send --to-region <region-id> --text <prompt>
  agentmux send --to-tab <tab-id> --text <prompt>

Optional A2A facts: --message-id <id> --thread <id> --correlation <id> --reply-to <id>.
The Core-owned queue records explicit sender/recipient facts and returns a durable receipt.
The recipient reads a short source label followed by exactly the authored body. CLI receipts
remain on stdout and in durable storage; do not forward them as the message. Authored JSON
is ordinary body text. A local process without a managed capability is an unverified source.
Session IDs accept unique prefixes; an ambiguous or unknown prefix fails before sending.
The source label in the prompt is not authentication.

Region must display an Agent. Tab succeeds only when it resolves to exactly one distinct
Agent Session; zero or multiple candidates fail with MESSAGE_TARGET_NOT_UNIQUE. Send
never resumes an ended Session.`],
  ['focus', `Navigate the Desktop main surface while preserving existing input

Usage:
  agentmux focus --space <space-id> [--zone <zone-id>]
  agentmux focus --zone <zone-id>
  agentmux focus --tab <tab-id>
  agentmux focus --region <region-id>
  agentmux focus --goal <demand-id>
  agentmux focus --surface <space|focus|goals|survey>
  agentmux focus --region <region-id> --input target
  agentmux focus --tab <tab-id> --input target

Space/Zone/Tab/Region form one hierarchy; exact children infer parents and supplied parents
must agree. Multi-Zone or ambiguous Tab targets return exact candidates. Goal and Surface
selectors are exclusive with that hierarchy. Goal navigation never launches a discussion.
Default --input preserve never steals conversation input. --input target requires the exact
existing Tab/Region input owner. Selection, actual presentation, overlays, floating View,
and before/after input are separate facts; inspect --client observes their current snapshot.
Focus never opens content, dismisses overlays, closes a floating View or mutates a Run.`],
  ['promote', `Promote one Region into its own new Tab

Usage:
  agentmux promote --region <region-id|self>

Detaches the Region from its current Tab's split tree and makes it the sole Region of a
brand-new Tab placed immediately after the source. The Region keeps its identity — same
Session, Run, and content — so this never starts, stops, or restarts the underlying Run.
Promoting a Region that is already the only Region of its Tab does nothing and fails with
REGION_ALREADY_SOLE rather than reporting a move that did not happen.`],
  ['arrange', `Apply one explicit Tab layout operation

Usage:
  agentmux arrange --tab <tab-id|self> --preset <columns-3|grid-4|grid-6|grid-9>
  agentmux arrange --tab <tab-id|self> --balance
  agentmux arrange --tab <tab-id|self> --active-first

Presets preserve existing Region reading order and fill empty slots with Launchers.
They fail without changing layout when the Tab has too many Regions. Balance equalizes
leaf area. Active-first moves only the active Region to reading-order first. Nothing
rearranges in the background.`],
  ['output', `Read bounded replay or follow one Agent Session

Usage: agentmux output --session <session-id|self> [--after-byte <n>] [--follow]

--after-byte is a cumulative Run byte cursor. Replay and follow output carry original
bytes as dataBase64. Follow emits attached, ordered output, then end. Releasing the
reader never stops the Run.`],
  ['interrupt', `Interrupt one Agent Session

Usage: agentmux interrupt --session <session-id|self>

The Desktop Control Host applies portable interrupt to the exact current Run.`],
  ['resume', `Resume Provider-native context into a replacement Run

Usage: agentmux resume --session <session-id|self> --text <prompt>

Resume is the only recovery intent; send never resumes.`],
  ['stop', `Stop one Agent Session current Run

Usage: agentmux stop --session <session-id|self>

This is destructive to the live Run and removes the Session binding.`]
])

export function agentMuxCommandHelp(path: string): string | null { return HELP.get(path) ?? null }

export const AGENTMUX_CLI_SKILL = `---
name: agentmux
description: Inspect and control AgentMux Agents, Tabs, and Regions with typed JSON receipts.
---

# AgentMux

Agent Session owns model/provider context, CtxMux Run owns PTY bytes, Tab is one complete
work surface, and Region is one spatial leaf inside a Tab. Never treat these identities as
aliases.

## Verify managed self

\`\`\`bash
test "\${AGENTMUX_ENV:-}" = 1
test -n "\${AGENTMUX_AGENT_SESSION_ID:-}"
command -v agentmux
\`\`\`

If these checks fail, do not use \`self\`. Use an explicit typed id.

## Orient at startup

\`\`\`bash
agentmux whoami
\`\`\`

Run this first. It reports who and where you are — Agent Session, Provider, Executor, host,
Workspace, current Run, and the capabilities available to you — from the same Session
projection every other intent reads. When a Desktop View displays you, it also reports your
View, Region, and split neighbors. Topic is deliberately absent: the Scratch \`topic.md\` and
\`.agents/\` files on disk are the only source of truth for your Topic and collaborators, so
read them rather than expecting a field here. A missing View is a normal answer.

## Give the Agent and Workspace readable names

Names shown to a person are display facts, not replacements for runtime identity. First run
\`agentmux whoami\` and keep the reported Session id, Workspace id, and filesystem path unchanged.

- To name yourself, ask the person for the label they want for this Agent, then use the Desktop
  Agent details menu and choose **Rename agent**. The label is stored against this Agent Session and
  is reused in its Tab, Region, conversation, and status surfaces.
- To name the whole Workspace, ask for a project/workspace label and use **Settings → Workspaces →
  Name** (the same field shown when creating or editing a Workspace). This changes the readable
  project label everywhere the Workspace is shown; it does not rename the directory, branch, or
  Workspace id.
- If the Desktop naming control is unavailable, state the proposed Agent and Workspace names and
  ask the person to apply them. Do not invent an \`agentmux rename\` command, edit ids in the Session
  store, or rename the filesystem to make a display name. After the person applies a name, run
  \`agentmux whoami\` or \`agentmux inspect --session self\` again and report the resulting labels.

## Inspect before acting

\`\`\`bash
agentmux inspect --session self
agentmux inspect --tab self
agentmux inspect --client
\`\`\`

Session inspection reads only Core Session/Run truth. Tab inspection reads the Desktop
Control Host's current Region map and normalized bounds. Parse receipts; never infer from
titles, UI focus, terminal output, or list order.
agent rename --session <id> (--name <text>|--clear) changes only its Desktop display alias;
agent inspect --session <id> reads that current override, even when Session facts are absent.
Null means no override, not a retired Session; a read does not confirm an earlier write.
space rename --tab <id> (--name <text>|--clear) changes the Tab entity's display name.
Client inspection is read-only: it observes the current Desktop selection, presentation,
overlays, floating View and input owner without exposing drafts or terminal input.
It does not confirm a previous request or authorize repeating an unconfirmed operation.

## Open an Agent in a Space

\`Space\` owns working surfaces, \`Zone\` binds their execution resource, \`Tab\` is a work
surface and \`Region\` is one leaf. Project groups code resources and is not a Space alias.

\`\`\`bash
agentmux list agents
agentmux space ls
agentmux space ls --space <space-id>
agentmux agent open --executor <exact-executor-id> --zone <zone-id> --new-tab --prompt "Implement the change"
agentmux agent open --executor <exact-executor-id> --region <region-id> --split right --prompt "Review the writer"
agentmux agent open --session <exact-session-id> --zone <zone-id> --new-tab
agentmux agent open --executor <exact-executor-id> --space <space-id> --new-zone --worktree --new-branch feat/task --path /absolute/worktree --prompt "Work on this branch"
\`\`\`

Discover exact IDs before acting. Space/Zone can open their first Tab without an existing
Tab anchor. A Space with several Zones returns candidates and requires a choice. Extra
parents must agree. A Region target must be empty unless --split creates a neighbor.
Open preserves current focus by default; --focus explicitly navigates. Existing --session
adds a view without changing the original Run/cwd and cannot take a prompt or new Zone.
A non-Git Zone uses --new-zone --directory <existing-absolute-directory> in an exact Space.
Use result.agent.agentSessionId for the Session and result.to, when confirmed, for its
spatial address. The SID can be passed to send --to-session; the Region to moves or focus.

## Create and bind an authorized Demand

Run agentmux demand --help for the complete commands before writing. ${DEMAND_CREATE_GUIDE}
Assign the actual Executor with demand assign, and bind the actual returned Agent Session
with demand link-session. A recorded assignment does not itself deliver a task or start a Run.

## Move one Agent presentation

\`\`\`bash
agentmux space mv --from-region <source-region-id> --expect-session <session-id> --zone <zone-id> --new-tab
agentmux space mv --from-region <source-region-id> --expect-session <session-id> --region <empty-region-id>
agentmux space inspect --request <request-id>
\`\`\`

Move one exact source projection, preserving its Region/Session/Run, original Host/cwd and
other views. It never resumes, stops, spawns or sends. Both open and mv accept --request-id;
without it the final single JSON receipt supplies a generated ID. partial/unknown exits
nonzero and retains real owner facts. A missing reply does not mean no operation happened:
agentmux space inspect --request <request-id> before choosing any recovery. Initial prompt
confirmed proves the same Core creation protocol, not Agent task acceptance. Chromium flush is only a request;
diskDurability remains unconfirmed until actual restart/readback evidence exists.

## Navigate the Desktop and keep the conversation

\`\`\`bash
agentmux focus --region <region-id>
agentmux focus --goal <demand-id>
agentmux focus --region <region-id> --input target
\`\`\`

Default --input preserve does not focus, blur, or restore input. It preserves the existing
Mote input owner, caret, draft and IME while that owner remains connected and visible;
a hidden or unmounted owner is unavailable/unconfirmed. Goal navigation only selects and
shows the exact Demand; it does not start a PMO discussion or send a task.
Use --input target only to deliberately transfer input to an exact existing Tab/Region
input owner. Space/Zone, Goal or Surface alone never chooses an input target.

Read result.navigation.state and selection, result.presentation.state, result.input.outcome,
result.partial and result.issues as separate facts. A selected address alone does not prove
main-visible presentation or input transfer. Floating, covered, pending and unknown facts
remain explicit; navigation never closes a Mote or dismisses an overlay automatically.
Use agentmux inspect --client to observe the current state after navigation. See focus --help
for the complete Space/Zone/Tab/Region, Goal and Surface selectors.

## Open a Terminal or Browser

\`\`\`bash
agentmux open terminal --command "pnpm test:fast" --below <region-id>
agentmux open terminal --in-region <launcher-region-id>
agentmux open browser --url "http://localhost:5173" --tab self --new-tab
\`\`\`

Terminal commands execute once at creation through the host shell. Browser URLs go to
the Main Browser owner. Pass them as flags; never synthesize terminal keystrokes or type
into Browser chrome. Inspect the resulting Tab/Region to confirm where it landed.
Control Browser open preserves the person's current Workbench selection. Placement and
page driving do not request input focus; explicit focus is a separate navigation action.
(This is about how the payload is delivered, not about driving the page afterwards.
Use agentmux browser run to drive an already-open Browser.)

## Drive an open Browser

Prefer this CLI path to interacting with Browser chrome or the desktop. First inspect the
exact Tab/Region and read its typed Browser id, then run against that id. Do not guess from
a title, stale address or neighboring Agent Tab. A missing or unknown Browser owner is an
unconfirmed capability: keep the original work, report it, and do not reopen, focus, restart
or use GUI input to get around that result.

\`\`\`bash
agentmux browser run --browser <browser-id> < program.js
\`\`\`

The program is read whole from stdin and runs in an isolated subprocess with page functions
injected: ${capabilityList('observe')} to observe,
${capabilityList('act', ' / ')} to act and as escape hatches,
${capabilityList('wait')} to wait, and ${capabilityList('navigate')} to
navigate. Write one program that does the whole loop —
that is the point of the verb:

\`\`\`js
const page = await snapshot()
await click(page.nodes.find((node) => node.name === 'Submit').ref)
await waitForLoad()
return await snapshot()
\`\`\`

Act on the refs a snapshot gives you (\`@e1\`, \`@e2\`, …). Never coordinates: they go stale the
moment anything reflows, and a stale coordinate clicks whatever moved into that spot.

Refs survive the run that issued them — including across an AgentMux restart. A ref from an
earlier run is matched back onto the page by what it pointed at (role, accessible name, and
which one of the same-named), because numeric refs identify nodes within a captured graph rather
than durable DOM identities. Every new snapshot supersedes the earlier refs in that run. Recovery is by
appearance, not identity: on a reordered list or a page of same-named buttons it can land on a
look-alike. So a run that leaned on one comes back \`indeterminate\` with a line naming which
ref and why — check the page rather than assuming the action hit what you meant. Taking a
fresh \`snapshot()\` at the start of a run avoids the question entirely.

One Browser is one page, so there are no tab functions — use \`gotoUrl\` to go elsewhere in it,
and \`agentmux open browser\` when you want a second page. A snapshot's \`missingFrames\` lists
what it could not read. Its observation metadata separately reports scope exclusions and truncation;
an empty missingFrames list alone does not mean the returned observation covers the whole page.

This needs Agent browser automation enabled in Settings › Browser — off by default. Read the
receipt's \`outcome\`: \`indeterminate\` means you do NOT know what already happened, either
because the run died partway — that also covers the page's DevTools being opened mid-run,
which severs the debugging session — or because a ref from an earlier run was recovered by
appearance. Look at the page before running anything again; do not blind-retry.

You are sharing the page with a person, and they outrank you on it. While your program runs,
that Browser wears a badge saying so and its Tab is marked — they can see you are in there
without switching to it. The moment they click, type or scroll in it, the page is
theirs. Your actions are refused from then on and the run comes back \`stopped\` — not
\`script-failed\`, because nothing is wrong with your program. Observation still works, so take
a \`snapshot()\` to see where you actually left things, say so, and run the program again when
the page is free. Do not try to take the page back by driving harder.

Some links leave the browser entirely: custom application schemes, \`mailto:\` and anything
else belonging to a desktop app. Clicking one does not navigate — AgentMux asks the person
whether to hand it to their system, and remembers the answer per scheme rather than per site.
So a \`click\` on one of those returns normally while \`pageInfo().url\` stays exactly where it
was. That is not a failed click and not a page that is still loading: waiting for a navigation
that will never come just burns your timeout. Read the url; if it did not move, the link went
out to an app (or is waiting on a person who has not answered yet), and whatever you were going
to do after the navigation has to be reconsidered. You cannot answer that question on their
behalf, and there is no page function that opens an app link directly.

## Apply a deliberate layout

\`\`\`bash
agentmux arrange --tab self --preset columns-3
agentmux arrange --tab self --preset grid-4
agentmux arrange --tab self --preset grid-6
agentmux arrange --tab self --preset grid-9
agentmux arrange --tab self --balance
agentmux arrange --tab self --active-first
\`\`\`

Three columns are useful for a user/Writer/Reviewer working set. Four cells suit two
paired workstreams; six or nine cells suit larger parallel batches. Presets retain
existing Regions and create Launcher slots for later \`open --in-region\` calls. Layout
changes are explicit: never continuously reorder based on output, titles, or recency.

## Move a Region into its own Tab

\`\`\`bash
agentmux promote --region self
agentmux promote --region <region-id>
\`\`\`

Promote moves one Region out of its shared Tab into a brand-new Tab of its own; it does
not open a second copy, and it never starts, stops, or restarts the Run. Use it to move,
not to duplicate. A Region that is already alone in its Tab has nowhere to move and fails
with REGION_ALREADY_SOLE rather than reporting a move that did not happen.

## Read what is in a direction

Asking what is beside you answers with one of two different places, and they are not the
same thing. When your View is split, a direction resolves to the visible Region next to you
— that is what your eye sees adjacent. Only when nothing is split in that direction does it
fall back to the adjacent Tab on the tab strip: navigating to another whole View, not a
Region inside this one. Up and down never name a Tab — the tab strip is one horizontal row.
A direction reaching neither is a real answer, not a failure. Reading a direction never
opens or moves anything; creating a direction (\`open ... --left-of\` and its siblings) always
splits a new Region. Decide by the visible view, keep both old and new content readable with
the least disturbance, and after any move inspect the result to confirm where it landed.

## Send without guessing

\`\`\`bash
agentmux send --to-session self --text "Continue"
agentmux send --to-region <region-id> --text "Continue"
agentmux send --to-tab <tab-id> --text "Continue"
\`\`\`

Tab send succeeds only for one distinct Agent Session. If candidates are returned, inspect
the Tab and select an exact Session. Send never broadcasts and never resumes.

Session send/inspect/runtime commands accept a full canonical ID or a currently unique prefix.
Existing agent open --session and space mv --expect-session require exact Session IDs.
Full IDs win exact matches. Ambiguous prefixes require more characters; unknown prefixes
never select an Agent. New canonical IDs use 16 base64url characters, an alphanumeric first
character, and over 95 bits of effective entropy.
Generic Demand links and mixed PMO Session filters keep full Session IDs, including Terminals;
Agent prefixes apply to demand start, pmo agents/sessions --session, and PMO --agent.
Keep CLI JSON receipts separate from message text: recipients read a source label and the
unchanged authored body, including JSON only when it was explicitly authored as that body.

Tab \`self\` resolves by deduplicating every caller Region's \`tabId\`; Region \`self\` must
resolve to exactly one caller Region. Zero or multiple matches fail closed.

Every receipt has stable \`schemaVersion\`, \`requestId\`, \`operation\`, and exactly one of
\`result\` or \`error\`. A \`MESSAGE_TARGET_NOT_UNIQUE\` error includes typed
\`candidates[].agentSessionId\` and \`candidates[].regionIds\`; never parse its message.

## Supervise a message

\`\`\`bash
agentmux dispatch open --source-message <message-id>
agentmux dispatch report --source-message <message-id> --reply-message <reply-id> --kind question
agentmux dispatch show --source-message <message-id>
\`\`\`

The original sender remains waiting until the authorized worker records worker_done.
The worker can ask or escalate using separate real reply messages; the owner can record
cleanup. Every action uses the current invocation capability and the same durable journal.
It sends no input and does not complete an external Task. Referenced messages and historical
Session/Run identities must still be retained.

## Declare a handoff

\`\`\`bash
agentmux handoff --to-session <session-id> --task <caller-reference>
\`\`\`

The receipt declares the recipient and originAwaits=false. External responsibility remains
with its own system; Core does not change Task ownership or prove acceptance. Use send or
discuss for text delivery.

## Settings

\`\`\`bash
agentmux settings get
agentmux settings get <target>
agentmux settings set <key> <value>
agentmux settings executors list
agentmux settings executors refresh <executor-id> --host <host-id>
agentmux settings prompts list
agentmux settings executors|prompts get <id>
agentmux settings executors|prompts add <id> --input <file|->
agentmux settings executors|prompts update <id> --input <file|->
agentmux settings executors|prompts remove <id> [--input <file|->]
agentmux settings browser links list
agentmux settings browser links forget <literal scheme>
agentmux settings browser links forget --input <file|->
agentmux settings workspaces add --input <file|->
agentmux settings hosts list
agentmux settings hosts test <id>
\`\`\`

Read the running host's supported entries before setting a value. Each entry reports its
key, current value, default, scalar kind and optional enum; partial means other settings
are not yet exposed. Use the returned exact keys and legal values. Success reports the
committed entry after persistence. No managed Agent caller or open View is required.
An offline host returns CONTROL_UNAVAILABLE; never substitute direct configuration-file
writes. Without a complete success reply, the commit result is unconfirmed. Read current state
before deciding; do not automatically retry the write.
${SETTINGS_AUTHORITY}

Browser links list returns exact scheme/choice entries. Forget atomically deletes the answer
current when the owner processes it; an absent answer is unchanged and the next link asks again.
There is no allow/deny setter or list-snapshot comparison. A single scheme argument is literal
data, even --help or --input. Alternatively supply exactly {"scheme": string} through bounded
UTF-8 JSON file/stdin, including stored NUL keys that argv cannot represent. Never mix carriers.

Workspace add takes a field object with hostId, literal path and optional name through the
same bounded UTF-8 JSON carrier. Main owns validation, generated id/kind and name defaults.
The CLI does not trim/expand/probe/create a folder; Main trims an optional name and derives
an absent/empty/whitespace name from the folder path. The same host/location returns the
original committed item with changed=false. Registration does not select/focus or launch;
there are no settings workspaces list/get/update/remove commands. An unavailable owner has
no direct-file fallback. Input file names such as --help remain data.

For resources, add input is a field object with its ID only in the positional argument. Update
input is {"changes": {...}, "expected": {...}} with nonempty changes and optional expected;
remove optionally takes {"expected": {...}} using the complete get value snapshot. Input is
bounded UTF-8 JSON from the local file or stdin (-); the host receives fields, not a file path.
The host owns legal fields and reference safety. IDs, paths and field values are literal data,
including --help, spaces and environment expressions. Arrays and objects replace entire fields.
Read after a timeout; never infer that a missing reply means a mutation did not commit.

## Desktop diagnostics

\`\`\`sh
agentmux diagnostics crash-log
agentmux diagnostics crash-log reveal
\`\`\`

Read the typed outcome, not just exit 0. The Desktop checks its fixed local path without
reading contents. Only an explicit reveal requests the file manager; requested does not
prove it is visible. No View or managed caller is required. Offline Main is unavailable;
there is no direct-file fallback. Run diagnostics --help for diagnostic outcomes.

## Runtime intents

\`\`\`bash
agentmux output --session self --follow
agentmux interrupt --session self
agentmux resume --session self --text "Continue after recovery"
agentmux stop --session self
\`\`\`

All mutations go through the installed Control Host. Parse stable error codes. No failure
authorizes UI automation, direct ctxmux socket access, retry, fallback, or target guessing.
`
