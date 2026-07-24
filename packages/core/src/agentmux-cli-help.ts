const COMMANDS = [
  ['doctor', 'Check the AgentMux host, exact CtxMux runtime, and installed Providers.'],
  ['list', 'List Agent Sessions. The first field is the stable AgentMux session id.'],
  ['resolve', 'Resolve a Provider-native, ACP, or exact Run identity to one Agent Session.'],
  ['status', 'Read one Agent Session and its exact current Run status.'],
  ['send', 'Submit a prompt to a ready Agent Session.'],
  ['interrupt', 'Send the portable interrupt action to the exact current Run.'],
  ['attach', 'Replay and optionally follow the exact current Run output.'],
  ['resume', 'Use Provider-native resume to replace a terminal Run while preserving the Agent Session.'],
  ['stop', 'Stop or retire the exact current Run and remove the Agent Session binding.'],
  ['switch', 'Focus one already-open Desktop View; never creates or attaches a View.']
] as const

export const AGENTMUX_CLI_HELP = [
  'agentmux — control local coding-agent sessions through AgentMux and CtxMux',
  '',
  'Usage: agentmux <command> [options]',
  '       agentmux --skill',
  '',
  'Inspect:',
  ...COMMANDS.slice(0, 4).map(([command, summary]) => `  ${command.padEnd(10)} ${summary}`),
  '',
  'Control:',
  ...COMMANDS.slice(4, 9).map(([command, summary]) => `  ${command.padEnd(10)} ${summary}`),
  '',
  'Desktop:',
  ...COMMANDS.slice(9).map(([command, summary]) => `  ${command.padEnd(10)} ${summary}`),
  '',
  'Learn:',
  '  agentmux <command> --help   Show exact syntax, success semantics, and the next useful command.',
  '  agentmux --skill            Print instructions for an Agent running inside AgentMux.',
  '',
  'Managed context:',
  '  AGENTMUX_ENV=1 identifies an AgentMux-managed Run.',
  '  AGENTMUX_AGENT_SESSION_ID is the stable current Agent Session id when the Run hosts an Agent.',
  '  AGENTMUX_CLI is the exact CLI path; agentmux is also placed in PATH.',
  '',
  'Output:',
  '  Use --json for machine-readable results and parse returned ids instead of guessing them.',
  '',
  'Options:',
  '  --skill        Print Agent instructions and exit.',
  '  --version, -V  Print version and exit.',
  '  --help, -h     Show this help.'
].join('\n')

const HELP = new Map<string, string>([
  ['doctor', [
    'Check the local AgentMux and exact CtxMux runtime',
    '',
    'Usage: agentmux doctor [--json]',
    '',
    'Success means the host is reachable, the pinned CtxMux artifact is valid, and required runtime checks passed.',
    'Provider executables may be reported as warnings without changing their identity.',
    '',
    'next: agentmux list --json'
  ].join('\n')],
  ['list', [
    'List AgentMux Agent Sessions',
    '',
    'Usage: agentmux list [--json]',
    '',
    'The stable control key is session.agentSessionId, not a Provider-native id or CtxMux Run id.',
    'Use --json before selecting a target programmatically.',
    '',
    'next: agentmux status <agent-session-id> --json'
  ].join('\n')],
  ['resolve', [
    'Resolve an external identity to one AgentMux Agent Session',
    '',
    'Usage:',
    '  agentmux resolve agent-session <id> [--json]',
    '  agentmux resolve provider-native <provider-id> <native-session-id> [--json]',
    '  agentmux resolve acp-native <adapter-id> <native-session-id> [--json]',
    '  agentmux resolve run <run-id> [--json]',
    '',
    'Resolution fails closed for unknown, ambiguous, retired, or conflicting identities.',
    'Success returns the stable AgentMux Agent Session; it does not focus or mutate a View.',
    '',
    'next: agentmux status <returned-agent-session-id> --json'
  ].join('\n')],
  ['status', [
    'Read one Agent Session and its exact current Run status',
    '',
    'Usage: agentmux status <agent-session-id> [--json]',
    '',
    'Success proves the Agent Session still resolves to the returned exact current Run.',
    '',
    'next: agentmux send <agent-session-id> --text <prompt> --json'
  ].join('\n')],
  ['send', [
    'Submit a prompt to a ready Agent Session',
    '',
    'Usage: agentmux send <agent-session-id> --text <prompt> [--json]',
    '',
    'The token after --text is always prompt data, including literal values such as --help.',
    'Success means AgentMux atomically submitted the prompt through the Provider contract to the exact current Run.',
    'A running process alone does not prove prompt readiness; not-ready Sessions fail closed.',
    '',
    'next: agentmux attach <agent-session-id> --json'
  ].join('\n')],
  ['interrupt', [
    'Interrupt the exact current Agent Run',
    '',
    'Usage: agentmux interrupt <agent-session-id> [--json]',
    '',
    'Success means CtxMux applied its portable interrupt action; it does not stop or retire the Agent Session.',
    '',
    'next: agentmux status <agent-session-id> --json'
  ].join('\n')],
  ['attach', [
    'Replay and optionally follow one Agent Run',
    '',
    'Usage: agentmux attach <agent-session-id> [--after-byte <n>] [--json]',
    '',
    '--after-byte is a cumulative UTF-8 byte cursor, not a character or terminal-row offset.',
    '--json returns the bounded replay receipt and exits. Text mode follows a running Run until it exits or this CLI is interrupted.',
    'Releasing this Attachment never stops the Run.',
    '',
    'next: agentmux status <agent-session-id> --json'
  ].join('\n')],
  ['resume', [
    'Resume Provider-native context into a new exact Run',
    '',
    'Usage: agentmux resume <agent-session-id> --text <prompt> [--json]',
    '',
    'The token after --text is always prompt data, including literal values such as --help.',
    'Success preserves the AgentMux Agent Session id and replaces its terminal Run through the Provider resume contract.',
    'Unsupported Providers and still-running current Runs fail closed.',
    '',
    'next: agentmux status <agent-session-id> --json'
  ].join('\n')],
  ['stop', [
    'Stop or retire one Agent Session current Run',
    '',
    'Usage: agentmux stop <agent-session-id> [--json]',
    '',
    'A running Run is stopped through CtxMux. A CtxMux-proven terminal Run is retired without fabricating a Stop receipt.',
    'Success removes the Agent Session binding.',
    '',
    'next: agentmux list --json'
  ].join('\n')],
  ['switch', [
    'Focus one already-open AgentMux Desktop View',
    '',
    'Usage:',
    '  agentmux switch terminal-view <view-id> [--json]',
    '  agentmux switch agent-session <id> [--json]',
    '  agentmux switch provider-native <provider-id> <native-session-id> [--json]',
    '  agentmux switch acp-native <adapter-id> <native-session-id> [--json]',
    '  agentmux switch run <run-id> [--json]',
    '',
    'Success means the Desktop focused exactly one existing View.',
    'This command never opens, attaches, resumes, spawns, splits, or otherwise changes layout.',
    'Unknown, ambiguous, stale, closed, and not-open targets fail closed.',
    '',
    'next: no Run lifecycle action is implied; use an explicit Agent Session id for further control.'
  ].join('\n')]
])

export function agentMuxCommandHelp(command: string): string | null {
  return HELP.get(command) ?? null
}

export const AGENTMUX_CLI_SKILL = `---
name: agentmux
description: Control the current local AgentMux Agent Session and focus existing AgentMux Desktop Views.
---

# AgentMux

AgentMux gives every supported coding Agent a stable Agent Session identity while CtxMux owns the exact terminal Run, PTY, replay, input, interrupt, and stop facts.

## Verify caller context

Before controlling the current Agent, verify the managed environment:

\`\`\`bash
test "\${AGENTMUX_ENV:-}" = 1
test -n "\${AGENTMUX_AGENT_SESSION_ID:-}"
command -v agentmux
\`\`\`

If either context check fails, do not guess the current Agent Session or a Desktop-focused target. Use an explicit id supplied by the user or report that the caller is outside a managed Agent Run.

## Learn the installed CLI

The installed executable is authoritative:

\`\`\`bash
agentmux --help
agentmux <command> --help
\`\`\`

Prefer \`--json\`, parse returned ids, and never infer identity from terminal titles, output text, process ids, or list order.

## Control the current Agent Session

\`AGENTMUX_AGENT_SESSION_ID\` is the stable AgentMux identity. It is not the Provider-native session id or CtxMux Run id.

\`\`\`bash
agentmux status "$AGENTMUX_AGENT_SESSION_ID" --json
agentmux send "$AGENTMUX_AGENT_SESSION_ID" --text "Continue with the requested task." --json
agentmux interrupt "$AGENTMUX_AGENT_SESSION_ID" --json
agentmux attach "$AGENTMUX_AGENT_SESSION_ID" --json
\`\`\`

Use \`resume\` only when the user intends Provider-native context recovery into a new terminal Run. Use \`stop\` only when the user intends to end the current Run and remove its Agent Session binding.

## Resolve another Agent

Start with \`agentmux list --json\`. When the user gives a native identity, resolve it explicitly:

\`\`\`bash
agentmux resolve provider-native <provider-id> <native-session-id> --json
agentmux resolve acp-native <adapter-id> <native-session-id> --json
agentmux resolve run <run-id> --json
\`\`\`

Resolution fails closed. Do not select a nearby or recently active Session when no unique match exists.

## Focus an existing Desktop View

\`switch\` changes only Desktop focus:

\`\`\`bash
agentmux switch agent-session "$AGENTMUX_AGENT_SESSION_ID" --json
agentmux switch terminal-view <view-id> --json
\`\`\`

The current CLI does not create, split, move, open, attach, resume, or spawn Desktop Views, panes, or tabs. Do not reinterpret \`switch\` as a layout command and do not fall back to computer-use when asked for an unavailable layout mutation. Report that Desktop composition is not exposed by the installed AgentMux CLI.

## Safety

- Prefer the current Agent Session environment or explicit returned ids over UI focus.
- Parse JSON receipts; never predict ids.
- Treat Run, Agent Session, Attachment, and View as different objects.
- Terminal output does not prove a semantic reply, permission decision, or model-context continuity.
- Inspect an error before retrying; stale, ambiguous, unsupported, and not-ready failures are deliberate fail-closed outcomes.
`
