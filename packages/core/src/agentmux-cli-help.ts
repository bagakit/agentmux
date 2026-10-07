import { AGENTMUX_NOTE_GUIDE } from './agentmux-cli-note-guide.js'
import { AGENTMUX_CLI_COMMANDS, type AgentMuxCliCommand } from './agentmux-cli-commands.js'
import { AGENTMUX_BROWSER_PROGRAM_GUIDE, AGENTMUX_BROWSER_TASK_GUIDE, AGENTMUX_BROWSER_TARGET_GUIDE } from './agentmux-cli-browser-guide.js'
import { AGENTMUX_SETTINGS_RESOURCE_GUIDE, AGENTMUX_TOOLKIT_GUIDE, AGENTMUX_GOAL_CREATE_GUIDE } from './agentmux-cli-resource-guide.js'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE } from './agent-messaging-guidance.js'
import { NATIVE_RESUME_GUIDE, GIT_GUIDE, SPATIAL_GUIDE, DEVICE_GUIDE } from './agentmux-cli-shared-guides.js'
import { agentMuxBaseSkill, agentMuxModuleSkillEntry } from './agentmux-cli-module-skills.js'

export { AGENTMUX_SELF_CONTEXT_VERB } from './agent-self-context.js'
const syntax = (entry: AgentMuxCliCommand) => `amux ${entry.method.replaceAll('.', ' ')}${entry.usage ? ' ' + entry.usage : ''}`
const entries = (path: string) => AGENTMUX_CLI_COMMANDS.filter(entry => entry.method === path || entry.method.startsWith(path + '.'))
const list = (selected: readonly AgentMuxCliCommand[]) => selected.map(entry => `  ${syntax(entry)}\n    ${entry.summary}`).join('\n')
const COMMON = `Public methods use the same typed JSON-RPC service over Unix, HTTP, encrypted Relay or SSH.
Select one transport with amux --endpoint <descriptor> <object> <action>.
Run system endpoint to discover the default without connecting.
Endpoint, Host route and execution identity are separate:
--endpoint selects one AgentMux service, not an execution destination.
--host on commands that support it selects a Host ID known to that service; it is not an SSH address.
local means the receiving Core service's own machine, including when that service is remote.
agent ls and agent inspect return routeHostId for that service and retain session.hostId unchanged.
Provider turn failures appear in status.session.semanticStatus.failure with code, message, recovery and available native evidence.
An error status does not imply that its Run exited; ordinary input follows the current Run and readiness facts.
Use routeHostId with agent context --host; its hostId is the route and sourceHostId is the original source.
Keep the same endpoint for discovery and follow-up. Host IDs are not global machine IDs.

Direct remote service (build-node is a normal SSH alias):
  amux --endpoint 'ssh://user@build-node/' agent ls
  amux --endpoint 'ssh://user@build-node/' agent context --host local --session SID
Via this service's configured remote Host (use the actual returned routeHostId):
  amux agent ls
  amux agent context --host build-host --session SID
Find configured route IDs with amux settings hosts ls. A listed configuration is not a connection check.
system endpoint reports connection=not-attempted and does not verify reachability or Agent health.
system endpoint --inspect reads the owner publication observation through RPC.
An RPC system.endpoint response reports connection=responded; this certifies that response only.
SSH uses the remote amux system endpoint --stdio bridge and requires an existing remote service.
The ssh URI may specify URI-encoded socket and command query parameters; system SSH owns aliases and credentials.

RPC wire IDs only correlate transport messages; --operation-id is the business identity.
Ordinary commands print one canonical JSON receipt; readers print complete ordered JSON frames.
Typed errors retain their code and details. Partial/unknown facts are not successful writes.

IDs and TEXT are literal data, including option-looking values. Use --flag=value where needed.
For help about a positional-data command, use amux --help <object> <action>.
Without a complete success reply, the commit result is unconfirmed.
Read current state before deciding; do not automatically retry the write.
A current read cannot certify an earlier lost receipt. Save requests are not disk ACKs.

Managed Agent credentials are carried from AGENTMUX_AGENT_SESSION_ID and
AGENTMUX_AGENT_CAPABILITY; the service verifies them. Environment SID hints do not
prove an author. Exact targets do not rely on the current UI, focus or CLI cwd.
Core Session/Run, configured Executor and presentation addresses are distinct.
Unknown observations retain the healthy Agent and its durable work surface.

${AGENTMUX_AGENT_MESSAGING_GUIDANCE}`

export const AGENTMUX_CLI_HELP = `amux — object-first Agent and Desktop control

Usage: amux [--endpoint <descriptor>] <object> <action> [arguments]
       amux whoami
       amux --help [object [action]]
       amux --skill
       amux <module> --skill
       amux --version

Commands:
${list(AGENTMUX_CLI_COMMANDS)}

${COMMON}

${DEVICE_GUIDE}`

export function agentMuxCommandHelp(path: string): string | null {
  const selected = entries(path)
  if (!selected.length) return null
  const exact = selected.find(entry => entry.method === path)
  const moduleEntry = agentMuxModuleSkillEntry(path.split('.')[0]!)
  const moduleGuide = moduleEntry ? `Module guide (local, read-only): ${moduleEntry}\nParameters and legal values below come from this version's command registration.` : ''
  const guide = path === 'notebook' || path.startsWith('notebook.') ? AGENTMUX_NOTE_GUIDE
    : path === 'device' || path.startsWith('device.') ? DEVICE_GUIDE
    : path === 'git' || path.startsWith('git.') ? GIT_GUIDE
    : path === 'agent.native' || path.startsWith('agent.native.') ? NATIVE_RESUME_GUIDE
    : path === 'agent.open' ? `${SPATIAL_GUIDE}\n\n${NATIVE_RESUME_GUIDE}`
    : path === 'space' || path.startsWith('space.') || path === 'file.open' ? SPATIAL_GUIDE
    : path === 'toolkit' || path.startsWith('toolkit.') ? AGENTMUX_TOOLKIT_GUIDE
    : path === 'settings' || path.startsWith('settings.') ? AGENTMUX_SETTINGS_RESOURCE_GUIDE
    : path === 'goal.create' ? AGENTMUX_GOAL_CREATE_GUIDE
    : path === 'browser.task' || path.startsWith('browser.task.') ? AGENTMUX_BROWSER_TASK_GUIDE
    : (path === 'browser' || path.startsWith('browser.')) && path !== 'browser.run' ? AGENTMUX_BROWSER_TARGET_GUIDE : ''
  if (!exact) return `${path.replaceAll('.', ' ')}\n\n${list(selected)}\n\n${moduleGuide}\n\n${COMMON}\n\n${guide}`
  return `${exact.summary}\n\nUsage: ${syntax(exact)}\n\n${exact.details ?? ''}\n\n${moduleGuide}\n\n${COMMON}\n\n${guide}${path === 'browser.run' ? '\n\n' + AGENTMUX_BROWSER_PROGRAM_GUIDE : ''}`
}

export const AGENTMUX_CLI_SKILL = agentMuxBaseSkill()
