export const AGENTMUX_CLI_HELP = `agentmux — typed local Agent and Desktop control

Usage: agentmux <intent> [options]
       agentmux --skill

Intents:
  inspect     Inspect one Agent Session, Run, Tab, or Region without changing focus.
  list        List configured agents or active Agent Sessions from their owners.
  open        Open typed content at one exact spatial destination.
  send        Send one prompt to an exact Session or uniquely resolved presentation target.
  focus       Focus one exact Tab or Region.
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
and opens the URL; Renderer layout state does not own Browser navigation truth.`],
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

## Open a Terminal or Browser

\`\`\`bash
agentmux open terminal --command "pnpm test:fast" --below <region-id>
agentmux open browser --url "http://localhost:5173" --new-tab-after self
\`\`\`

Terminal commands execute once at creation through the host shell. Browser URLs go to
the Main Browser owner. Do not simulate either payload with keyboard or UI automation.

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
