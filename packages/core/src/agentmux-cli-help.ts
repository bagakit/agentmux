export const AGENTMUX_CLI_HELP = `agentmux — typed local Agent Session and Desktop Composition control

Usage: agentmux <command> [options]
       agentmux --skill

Composition:
  context                 Resolve this caller and the current View's Region map.
  launch                  Launch a configured Agent Executor and place its Region.
  region open             Open an existing Agent Session in a Tab Region.
  region focus            Focus one exact open Region.

Agent Sessions:
  session list            List Agent Sessions and exact current Runs.
  session resolve         Resolve a native or Run identity to one Agent Session.
  session status          Read one Agent Session and exact current Run status.
  session send            Submit a prompt through the Provider contract.
  session interrupt       Apply portable interrupt to the exact current Run.
  session output          Read bounded replay or follow output as JSON Lines.
  session resume          Resume Provider context into a replacement Run.
  session stop            Stop the current Run and remove the Session binding.

Managed caller:
  AGENTMUX_ENV=1 and AGENTMUX_AGENT_SESSION_ID establish identity for context,
  launch, and --relative-to self. No command guesses from UI focus or list order.

Output:
  Non-streaming success and failure output is versioned JSON by default.
  session output --follow emits one versioned JSON object per line.

Learn:
  agentmux <command> --help        Show typed flags and success semantics.
  agentmux <group> <command> --help
  agentmux --skill                 Print instructions for an Agent.

Options:
  --skill        Print Agent instructions and exit.
  --version, -V  Print version and exit.
  --help, -h     Show help.`

const HELP = new Map<string, string>([
  ['context', `Resolve this managed Agent's unique Desktop context

Usage: agentmux context

Identity comes only from AGENTMUX_AGENT_SESSION_ID. Success returns agentSessionId,
workspaceId, viewId, regionId, tabGroupId, configured Executors, and every Region's
normalized 0..1 bounds without focusing or opening anything. Missing, closed, stale,
and ambiguous caller Regions fail closed.

next: agentmux launch --agent codex --placement split-right --relative-to self`],
  ['launch', `Launch a configured Agent Executor and place its Desktop Region

Usage: agentmux launch --agent <executor-id> [--prompt <text>]
                       [--placement <placement>] [--relative-to <self|region-id>]

Placement: tab | split-left | split-right | split-up | split-down
Defaults: --placement split-right --relative-to self

The token after --prompt is always prompt data, including a literal --help.
--agent selects an Executor id returned by agentmux context, not a Provider id.
Different Executors may share one Provider while using different launch settings.
The long-lived Desktop RuntimeController creates the Agent; this CLI never owns
Hook ingress or creates a second Session registry. Success commits both Agent
Session and Region. A split stays inside the current View/Tab; only an explicit
tab placement creates another View. Lifecycle or layout failure rolls back.

next: agentmux session status <returned-agent-session-id>`],
  ['session', `Control AgentMux Agent Sessions

Usage: agentmux session <command> [options]

Commands: list, resolve, status, send, interrupt, output, resume, stop

Agent Session ids are stable AgentMux identities. Run ids, Provider-native ids,
View ids and Region ids are different identity spaces.

next: agentmux session list`],
  ['session.list', `List AgentMux Agent Sessions

Usage: agentmux session list

Success returns typed Session status entries. Select by returned agentSessionId;
never infer a target from list position.

next: agentmux session status <agent-session-id>`],
  ['session.resolve', `Resolve an external identity to one Agent Session

Usage:
  agentmux session resolve agent-session <id>
  agentmux session resolve provider-native <provider-id> <native-session-id>
  agentmux session resolve acp-native <adapter-id> <native-session-id>
  agentmux session resolve run <run-id>

Resolution fails closed for unknown, ambiguous, retired, or conflicting identities.
It does not open or focus a Region.

next: agentmux session status <returned-agent-session-id>`],
  ['session.status', `Read one Agent Session and its exact current Run

Usage: agentmux session status <agent-session-id>

Success proves the Session still resolves to the returned current Run.

next: agentmux session send <agent-session-id> --text <prompt>`],
  ['session.send', `Submit a prompt to a ready Agent Session

Usage: agentmux session send <agent-session-id> --text <prompt>

The token after --text is always prompt data, including a literal --help.
Success means the Provider contract atomically accepted the prompt for the exact
current Run. Process liveness alone does not prove prompt readiness.

next: agentmux session output <agent-session-id> --follow`],
  ['session.interrupt', `Interrupt the exact current Agent Run

Usage: agentmux session interrupt <agent-session-id>

Success means CtxMux applied portable interrupt. It does not stop or retire the
Agent Session.

next: agentmux session status <agent-session-id>`],
  ['session.output', `Read bounded replay or follow one Agent Run

Usage: agentmux session output <agent-session-id> [--after-byte <n>] [--follow]

--after-byte is a cumulative UTF-8 byte cursor. Without --follow, success returns
one JSON replay receipt and exits. --follow emits JSON Lines until the Run exits or
this reader is interrupted. Releasing output never stops the Run.

next: agentmux session status <agent-session-id>`],
  ['session.resume', `Resume Provider-native context into a replacement Run

Usage: agentmux session resume <agent-session-id> --text <prompt>

The token after --text is always prompt data, including a literal --help.
Success preserves the Agent Session identity and replaces its exact Run. Unsupported
Providers and still-running current Runs fail closed.

next: agentmux session status <agent-session-id>`],
  ['session.stop', `Stop or retire one Agent Session current Run

Usage: agentmux session stop <agent-session-id>

Success removes the Agent Session binding. This is destructive to the live Run;
use it only when the user intends to end that Agent execution.

next: agentmux session list`],
  ['region', `Control Regions inside real Desktop Views

Usage: agentmux region <command> [options]

Commands: open, focus

A View is one Tab and may contain multiple Regions. A Region is one visible content
area inside that Tab. Neither is an Agent Session or CtxMux Run.

next: agentmux context`],
  ['region.open', `Open an existing Agent Session in a Desktop Region

Usage: agentmux region open --session <agent-session-id>
                            [--placement <placement>] [--relative-to <self|region-id>]

Placement: tab | split-left | split-right | split-up | split-down
Defaults: --placement split-right --relative-to self

This creates presentation only: it does not create, resume, attach, or replace model
context. Split placement keeps the current View id; tab creates a new View. Unknown
Sessions, stale targets, and ambiguous self fail closed.

next: agentmux region focus --region <returned-region-id>`],
  ['region.focus', `Focus one exact already-open Desktop Region

Usage: agentmux region focus --region <region-id>

Success changes only Desktop focus. It never opens, splits, launches, attaches,
resumes, or stops an Agent Run. Unknown and stale Region ids fail closed.

next: no Run lifecycle action is implied.`]
])

export function agentMuxCommandHelp(path: string): string | null {
  return HELP.get(path) ?? null
}

export const AGENTMUX_CLI_SKILL = `---
name: agentmux
description: Control AgentMux Agent Sessions and compose Desktop Tab Regions with typed JSON receipts.
---

# AgentMux

AgentMux separates four identities: Agent Session is model/provider context, CtxMux
Run owns PTY and byte replay, Desktop View is one Tab, and Region is one content area
inside that Tab.

## Verify managed caller identity

\`\`\`bash
test "\${AGENTMUX_ENV:-}" = 1
test -n "\${AGENTMUX_AGENT_SESSION_ID:-}"
command -v agentmux
\`\`\`

If these checks fail, do not use \`self\`, guess a Session, or infer UI focus. Ask for
an explicit id or report that the caller is outside a managed Agent Run.

## Learn the installed surface

\`\`\`bash
agentmux --help
agentmux session --help
agentmux region --help
\`\`\`

The installed executable is authoritative. Non-streaming output is JSON by default;
parse returned ids and error codes instead of terminal text, titles, process ids, or
list order.

## Inspect the current View before placing

\`\`\`bash
agentmux context
agentmux launch --agent codex --prompt "Inspect the failing tests" \\
  --placement split-right --relative-to self
\`\`\`

Use \`region open\` when the Agent Session already exists and only a new presentation is
needed. It does not create or resume model context:

\`\`\`bash
agentmux region open --session <agent-session-id> --placement split-right --relative-to self
agentmux region focus --region <region-id>
\`\`\`

The context receipt includes configured Executors and every Region in the current View
with normalized \`x\`, \`y\`, \`width\`, and \`height\` bounds. Match the requested Agent
to an available Executor by label and Provider, then pass its executorId to \`--agent\`.
Use the Region map for directional requests in a multi-Region View. Select the Region
occupying the requested side, then split it on the axis that keeps the View balanced. For
example, when the right side already has top and bottom Regions and the left side is one
tall Region, "open on the left" means:

\`\`\`bash
agentmux launch --agent traex --placement split-down \\
  --relative-to region:<left-region-id>
\`\`\`

Use \`self\` directly only for a one-Region View, when the user explicitly asks for a Region
next to you, or when splitting your Region is actually the balanced target. If \`self\` is
ambiguous because the current Session has multiple Regions, use an exact \`regionId\` from a
receipt. Never pick the most recent Region or fall back to computer-use for Composition.

## Choose Split or Tab

- For the same task, or whenever the user names a direction, use a split placement.
- A direction describes the whole current View. It does not always mean split \`self\`.
- Use \`--placement tab\` only when the user explicitly asks for a Tab.
- If the work is clearly a different task, ask whether it should open in a new Tab;
  do not create the Tab until the user confirms.
- A split adds a Region to the current View. It never creates or moves a Tab.

## Control Agent Sessions

\`\`\`bash
agentmux session status "\$AGENTMUX_AGENT_SESSION_ID"
agentmux session send "\$AGENTMUX_AGENT_SESSION_ID" --text "Continue with the task."
agentmux session output "\$AGENTMUX_AGENT_SESSION_ID" --follow
agentmux session interrupt "\$AGENTMUX_AGENT_SESSION_ID"
\`\`\`

Use \`session resume\` only for intentional Provider-native recovery. Use \`session stop\`
only when the user intends to end the current Run and remove its Session binding.

## Resolve another Agent

Start with \`agentmux session list\`. Resolve native identities explicitly:

\`\`\`bash
agentmux session resolve provider-native <provider-id> <native-session-id>
agentmux session resolve acp-native <adapter-id> <native-session-id>
agentmux session resolve run <run-id>
\`\`\`

Resolution fails closed. Do not select a nearby or recently active Session.

## Safety

- Parse every JSON receipt and use returned ids.
- Treat Run, Agent Session, Attachment, View/Tab, Region, and Tab Group as different objects.
- Inspect stable error codes before retrying.
- Terminal output does not prove a semantic reply, permission decision, or context continuity.
- Composition failure does not authorize UI automation or direct ctxmux socket access.
`
