import { AGENTMUX_CLI_COMMANDS, type AgentMuxCliCommand } from './agentmux-cli-commands.js'
import { AGENTMUX_BROWSER_PROGRAM_GUIDE, AGENTMUX_BROWSER_TASK_GUIDE } from './agentmux-cli-browser-guide.js'
import { browserPageCapabilityNames } from './browser-page-capability.js'
import { AGENTMUX_SETTINGS_RESOURCE_GUIDE, AGENTMUX_TOOLKIT_GUIDE, AGENTMUX_GOAL_CREATE_GUIDE } from './agentmux-cli-resource-guide.js'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE } from './agent-messaging-guidance.js'

export { AGENTMUX_SELF_CONTEXT_VERB } from './agent-self-context.js'
const syntax = (entry: AgentMuxCliCommand) => `agentmux ${entry.method.replaceAll('.', ' ')}${entry.usage ? ' ' + entry.usage : ''}`
const entries = (path: string) => AGENTMUX_CLI_COMMANDS.filter(entry => entry.method === path || entry.method.startsWith(path + '.'))
const list = (selected: readonly AgentMuxCliCommand[]) => selected.map(entry => `  ${syntax(entry)}\n    ${entry.summary}`).join('\n')

const COMMON = `Public methods use the same typed JSON-RPC service over Unix, HTTP or SSH.
Select one transport with agentmux --endpoint <descriptor> <object> <action>.
Run system endpoint to discover the default without connecting.
RPC wire IDs only correlate transport messages; --operation-id is the business identity.
Ordinary commands print one canonical JSON receipt; readers print complete ordered JSON frames.
Typed errors retain their code and details. Partial/unknown facts are not successful writes.

IDs and TEXT are literal data, including option-looking values. Use --flag=value where needed.
For help about a positional-data command, use agentmux --help <object> <action>.
Without a complete success reply, the commit result is unconfirmed.
Read current state before deciding; do not automatically retry the write.
A current read cannot certify an earlier lost receipt. Save requests are not disk ACKs.

Managed Agent credentials are carried from AGENTMUX_AGENT_SESSION_ID and
AGENTMUX_AGENT_CAPABILITY; the service verifies them. Environment SID hints do not
prove an author. Exact targets do not rely on the current UI, focus or CLI cwd.
Core Session/Run, configured Executor and presentation addresses are distinct.
Unknown observations retain the healthy Agent and its durable work surface.

${AGENTMUX_AGENT_MESSAGING_GUIDANCE}`

export const AGENTMUX_CLI_HELP = `agentmux — object-first Agent and Desktop control

Usage: agentmux [--endpoint <descriptor>] <object> <action> [arguments]
       agentmux whoami
       agentmux --help [object [action]]
       agentmux --skill
       agentmux --version

Commands:
${list(AGENTMUX_CLI_COMMANDS)}

${COMMON}`

export function agentMuxCommandHelp(path: string): string | null {
  const selected = entries(path)
  if (!selected.length) return null
  const exact = selected.find(entry => entry.method === path)
  const guide = path === 'toolkit' || path.startsWith('toolkit.') ? AGENTMUX_TOOLKIT_GUIDE
    : path === 'settings' || path.startsWith('settings.') ? AGENTMUX_SETTINGS_RESOURCE_GUIDE
    : path === 'goal.create' ? AGENTMUX_GOAL_CREATE_GUIDE
    : path === 'browser.task' || path.startsWith('browser.task.') ? AGENTMUX_BROWSER_TASK_GUIDE : ''
  if (!exact) return `${path.replaceAll('.', ' ')}\n\n${list(selected)}\n\n${COMMON}\n\n${guide}`
  return `${exact.summary}\n\nUsage: ${syntax(exact)}\n\n${exact.details ?? ''}\n\n${COMMON}\n\n${guide}${path === 'browser.run' ? '\n\n' + AGENTMUX_BROWSER_PROGRAM_GUIDE : ''}`
}

const capabilities = (effect: Parameters<typeof browserPageCapabilityNames>[0]) =>
  browserPageCapabilityNames(effect).map(name => `\`${name}\``).join(', ')

export const AGENTMUX_CLI_SKILL = `---
name: agentmux
description: Use the public object-first CLI to observe and operate AgentMux through its typed service.
---

Start with \`agentmux whoami\` to learn your verified identity, presentation and capabilities.
Discover before acting: \`app snapshot\` gives global resource facts; \`agent ls\` lists
real Sessions, \`settings executors ls\` lists saved execution choices, and \`space ls\`
lists display/resource bindings. Do not substitute the current Workspace for global discovery.

The actual executable command tree is:

${list(AGENTMUX_CLI_COMMANDS)}

${COMMON}

Agent-first workflow:
1. Inspect Project resources and the intended Space separately with app snapshot and space inspect.
2. Use agent open --zone ZONE --new-tab --executor EXECUTOR --prompt TASK for an existing Zone.
3. To create a Zone, supply --project PROJECT --space SPACE --new-zone and either
   --worktree --path PATH --new-branch BRANCH or --directory PATH. If a Project's source
   is ambiguous, inspect its real Workspaces and explicitly pass --source-workspace WORKSPACE.
4. Retain the exact business operation ID, returned SID/Run and spatial address.
5. Use agent inspect, agent output and agent send for follow-up. Delivery is not completed work.
6. After a lost spatial reply, read space inspect --operation-id ID; do not blindly repeat.

space mv moves a presentation and leaves the original execution cwd/Host/Session/Run intact.
Default Agent/File opens and presentation changes keep background navigation and eligible input.
app focus selects a Surface; space focus and goal focus navigate exact objects. Selection,
presentation and actual caret eligibility are separate facts. Never stop a healthy Run to repair
an observation or handshake. Reader cancellation only detaches that reader.

goal activity reads the original Goal activity owner. Goal IDs and saved content retain their
original durable identity. Topic, Mote, SOUL and Wiki come from real filesystem owners; an
unavailable source stays explicit unknown and cannot be replaced by guessed material.
mote playbook pmo is a read-only working manual. It launches nothing, sends nothing,
registers no role and changes no SOUL/Wiki/user profile.

${AGENTMUX_SETTINGS_RESOURCE_GUIDE}

${AGENTMUX_TOOLKIT_GUIDE}

${AGENTMUX_GOAL_CREATE_GUIDE}

Browser page capabilities come from the actual capability owner:
Observe: ${capabilities('observe')}
Act: ${capabilities('act')}
Wait: ${capabilities('wait')}
Navigate: ${capabilities('navigate')}

${AGENTMUX_BROWSER_PROGRAM_GUIDE}

${AGENTMUX_BROWSER_TASK_GUIDE}
`
