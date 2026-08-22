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
  inspect     Inspect one Agent Session, Run, Tab, or Region without changing focus.
  list        List configured agents or active Agent Sessions from their owners.
  open        Open typed content at one exact spatial destination.
  browser     Drive an already-open Browser by running a program in it.
  send        Send one prompt to an exact Session or uniquely resolved presentation target.
  discuss     Start a Discussion: create a dedicated Agent and deliver the first message.
  handoff     Hand a task and its ownership to another Agent Session in one atomic act.
  focus       Focus one exact Tab or Region.
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
  agentmux open agent --help
  agentmux --skill

Options:
  --skill        Print Agent instructions and exit.
  --version, -V  Print version and exit.
  --help, -h     Show help.`

const HELP = new Map<string, string>([
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
relocates the whole runtime root, and the answer follows it.
`],
  ['inspect', `Inspect one exact owner identity without changing focus

Usage:
  agentmux inspect --session <session-id|self>
  agentmux inspect --run <run-id>
  agentmux inspect --tab <tab-id|self>
  agentmux inspect --region <region-id|self>
  agentmux inspect --provider-native <native-id> --provider <provider-id>
  agentmux inspect --acp-native <native-id> --adapter <adapter-id>

Session/Run/native inspection reads Core truth. Tab/Region inspection requires the
Desktop Control Host. Inspect --tab returns every closed-union Region surface and
normalized bounds. Missing, stale, or ambiguous self fails closed.`],
  ['list', `List configured Agents or active Agent Sessions

Usage:
  agentmux list agents
  agentmux list sessions

Agents are Desktop-configured executors with availability. Sessions are Core-owned live
or historical Agent Session status entries. Never infer a target from order.`],
  ['open', `Open typed content at one exact destination

Usage:
  agentmux open agent [options]
  agentmux open terminal [--command <shell-command>] <destination>
  agentmux open browser --url <url> <destination>

Exactly one destination is required:
  --left-of <region-id|self>      --right-of <region-id|self>
  --above <region-id|self>        --below <region-id|self>
  --new-tab-after <tab-id|self>   --in-region <launcher-region-id>

Agent prompt, Terminal shell command, and Browser URL are delivered once to their
respective owner. Every form requires exactly one destination.`],
  ['open.agent', `Open a new or existing Agent Session

Usage:
  agentmux open agent --agent <executor-id> [--prompt <text>] <destination>
  agentmux open agent --session <session-id> <destination>

Exactly one destination is required:
  --left-of <region-id|self>      --right-of <region-id|self>
  --above <region-id|self>        --below <region-id|self>
  --new-tab-after <tab-id|self>   --in-region <launcher-region-id>

The token after --prompt is data, including literal --help. Agent creation remains
owned by the long-lived Desktop RuntimeController. Lifecycle or layout failure rolls
back this open transaction.`],
  ['open.terminal', `Open a Terminal

Usage: agentmux open terminal [--command <shell-command>] <destination>

Exactly one destination from open --help is required. --command runs once through the
host shell at Terminal creation; it is never typed into an attached terminal.`],
  ['open.browser', `Open a Browser

Usage: agentmux open browser --url <url> <destination>

Exactly one destination from open --help is required. The Main Browser owner validates
and opens the URL; Renderer layout state does not own Browser navigation truth.

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

The receipt carries \`result\` (whatever the program returned), \`logs\` (everything it printed,
including on failure), and \`outcome\`, which is one of four:
  completed      the program finished
  script-failed  the program threw — fix the program
  stopped        we cut it off — the program is fine. Either its scale is (too slow, too much
                 output), or a person took the page back mid-run. Actions before that point
                 did happen; nothing after did. Run it again once the page is free.
  indeterminate  WHAT ACTUALLY HAPPENED IS UNKNOWN, for one of two reasons the message names:
                 the process died partway (an action may already have been applied once), or a
                 ref from an earlier run was matched back by appearance and may have landed on a
                 look-alike. Either way, look at the page before retrying — do not blind-retry.`],
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
  ['handoff', `Hand a task and its ownership to another Agent Session

Usage:
  agentmux handoff --to-session <session-id> --task <task-id>

Handoff is the atomic ownership transfer: the task and the responsibility for it move together to
the receiver, and the origin stops awaiting it (originAwaits=false). That single fact is the only
difference between a Handoff and a Dispatch, and it is decided by Core, not by wording in a message.

Core resolves the author from your invocation capability; AGENTMUX_AGENT_SESSION_ID is context only,
never authentication. Handoff transfers ownership only — it does not deliver a message, open a
Session, or prove the receiver accepted. Use send or discuss to deliver text. This is not a delivery
receipt, an idempotency ledger, or a signed capability.`],
  ['send', `Send one prompt without resuming or broadcasting

Usage:
  agentmux send --to-session <session-id|self> --text <prompt>
  agentmux send --to-region <region-id> --text <prompt>
  agentmux send --to-tab <tab-id> --text <prompt>

Region must display an Agent. Tab succeeds only when it resolves to exactly one distinct
Agent Session; zero or multiple candidates fail with MESSAGE_TARGET_NOT_UNIQUE. Send
never resumes an ended Session.`],
  ['focus', `Focus one exact presentation identity

Usage:
  agentmux focus --tab <tab-id>
  agentmux focus --region <region-id>

Focus never opens content or mutates a Run.`],
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

--after-byte is a cumulative UTF-8 byte cursor. Follow emits attached, ordered output,
then end. Releasing the reader never stops the Run.`],
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

## Inspect before acting

\`\`\`bash
agentmux inspect --session self
agentmux inspect --tab self
\`\`\`

Session inspection reads only Core Session/Run truth. Tab inspection reads the Desktop
Control Host's current Region map and normalized bounds. Parse receipts; never infer from
titles, UI focus, terminal output, or list order.

## Open an Agent

\`\`\`bash
agentmux open agent --agent codex --prompt "Implement the change" --right-of self
agentmux open agent --agent claude --prompt "Review the writer" --below <region-id>
agentmux open agent --agent codex --prompt "Work on the left" --left-of <region-id>
agentmux open agent --agent claude --prompt "Review above" --above <region-id>
agentmux open agent --session <session-id> --new-tab-after self
agentmux open agent --session <session-id> --in-region <launcher-region-id>
\`\`\`

Use a directional destination for the same task. Use \`--new-tab-after\` only when the
user explicitly requests a new Tab. For a non-trivial Tab, inspect its bounds and choose
the exact Region whose split produces the requested whole-Tab layout.

Before opening a custom Agent, use \`agentmux list agents\` to resolve its configured
Executor id and availability. For spatial placement, prefer a visible empty Region; when
none exists, split the adjacent Region that preserves the clearest readable layout, then
inspect the result. Do not infer space from titles or Tab order.

## Open a Terminal or Browser

\`\`\`bash
agentmux open terminal --command "pnpm test:fast" --below <region-id>
agentmux open browser --url "http://localhost:5173" --new-tab-after self
\`\`\`

Terminal commands execute once at creation through the host shell. Browser URLs go to
the Main Browser owner. Do not deliver either payload by typing it — no keystroke
synthesis into a terminal, no typing a URL into the Browser chrome. Pass it as the flag.

(This is about how the payload is delivered, not about driving the page afterwards.
\`agentmux browser run\` is the supported way to drive an open Browser — see below.)

## Drive an open Browser

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
which one of the same-named), because the numbers themselves are re-issued from \`@e1\` on
every snapshot and would otherwise silently address a different element. That recovery is by
appearance, not identity: on a reordered list or a page of same-named buttons it can land on a
look-alike. So a run that leaned on one comes back \`indeterminate\` with a line naming which
ref and why — check the page rather than assuming the action hit what you meant. Taking a
fresh \`snapshot()\` at the start of a run avoids the question entirely.

One Browser is one page, so there are no tab functions — use \`gotoUrl\` to go elsewhere in it,
and \`agentmux open browser\` when you want a second page. A snapshot's \`missingFrames\` lists
what it could not read; an empty list is the only claim that the map is complete.

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

Tab \`self\` resolves by deduplicating every caller Region's \`tabId\`; Region \`self\` must
resolve to exactly one caller Region. Zero or multiple matches fail closed.

Every receipt has stable \`schemaVersion\`, \`requestId\`, \`operation\`, and exactly one of
\`result\` or \`error\`. A \`MESSAGE_TARGET_NOT_UNIQUE\` error includes typed
\`candidates[].agentSessionId\` and \`candidates[].regionIds\`; never parse its message.

## Hand off ownership

\`\`\`bash
agentmux handoff --to-session <session-id> --task <task-id>
\`\`\`

Use handoff when you are giving a task away, not delegating it: ownership and responsibility move
to the receiver and you stop awaiting it. The receipt reports \`ownerAgentSessionId\`,
\`originAwaits: false\`, and \`taskId\`. Handoff transfers ownership only — it delivers no message and
opens no Session; deliver any text with send or discuss. Do not simulate a handoff by wording a
send: the ownership transfer is a Core fact, not a phrase.

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
