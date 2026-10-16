import { AGENTMUX_NOTE_GUIDE } from './agentmux-cli-note-guide.js'
import { AGENTMUX_CLI_COMMANDS, type AgentMuxCliCommand } from './agentmux-cli-commands.js'
import { AGENTMUX_BROWSER_PROGRAM_GUIDE, AGENTMUX_BROWSER_TASK_GUIDE, AGENTMUX_BROWSER_TARGET_GUIDE } from './agentmux-cli-browser-guide.js'
import { AGENTMUX_SETTINGS_RESOURCE_GUIDE, AGENTMUX_TOOLKIT_GUIDE, AGENTMUX_GOAL_CREATE_GUIDE } from './agentmux-cli-resource-guide.js'
import { AGENT_OPEN_WORKFLOW, NATIVE_RESUME_GUIDE, GIT_GUIDE, DEVICE_GUIDE } from './agentmux-cli-shared-guides.js'
import { agentMuxBaseSkill, agentMuxCliModuleCatalog, agentMuxModuleSkillEntry } from './agentmux-cli-module-skills.js'

export { AGENTMUX_SELF_CONTEXT_VERB } from './agent-self-context.js'
const syntax = (entry: AgentMuxCliCommand) => `amux ${entry.method.replaceAll('.', ' ')}${entry.usage ? ' ' + entry.usage : ''}`
const entries = (path: string) => AGENTMUX_CLI_COMMANDS.filter(entry => entry.method === path || entry.method.startsWith(path + '.'))
/** Only immediate descendants: an object index does not unfold unrelated branches. */
const list = (path: string, selected: readonly AgentMuxCliCommand[]) => {
  const depth = path ? path.split('.').length + 1 : 1
  const children = [...new Set(selected.filter(entry => entry.method !== path).map(entry => entry.method.split('.').slice(0, depth).join('.')))]
  return children.map(child => {
    const exact = selected.find(entry => entry.method === child)
    return `  amux ${child.replaceAll('.', ' ')}${exact?.usage ? ' ' + exact.usage : ''}\n    ${exact?.summary ?? 'Subcommands; read --help at this path.'}`
  }).join('\n')
}
const ENDPOINT_GUIDE = `Public methods use the same typed JSON-RPC service over Unix, HTTP, encrypted Relay or SSH.
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
Managed Agent credentials come from AGENTMUX_AGENT_SESSION_ID and AGENTMUX_AGENT_CAPABILITY;
the service verifies them. Environment SID hints and displayed text do not prove an author.`

const COMMON = `IDs and TEXT are literal data; use --flag=value for option-looking values.
RPC ids correlate transport; --operation-id identifies the original business action.
Retain original requests/IDs after partial or unknown results; never automatically replay a write.
Reader cancellation only detaches that reader. Observation failure does not end a healthy Agent.
For remote endpoint/Host routing read amux system endpoint --help.`

export const AGENTMUX_CLI_HELP = `amux — object-first Agent and Desktop control

Usage: amux [--endpoint <descriptor>] <object> <action> [arguments]
       amux whoami
       amux --help [object [action]]
       amux --skill
       amux <module> --skill
       amux --version

Modules (read amux MODULE --help for operations, MODULE --skill for guidance):
${agentMuxCliModuleCatalog().map(module => `  amux ${module.root}\n    ${module.summary}`).join('\n')}

${COMMON}`

export function agentMuxCommandHelp(path: string): string | null {
  const selected = entries(path)
  if (!selected.length) return null
  const exact = selected.find(entry => entry.method === path)
  const moduleEntry = agentMuxModuleSkillEntry(path.split('.')[0]!)
  const moduleGuide = moduleEntry ? `Module guide (local, read-only): ${moduleEntry}\nParameters and legal values below come from this version's command registration.` : ''
  const guide = path === 'system.endpoint' ? ENDPOINT_GUIDE
    : path === 'notebook' ? AGENTMUX_NOTE_GUIDE
    : path.startsWith('notebook.') ? 'Read amux notebook --help for original Note content, links and editing conditions.'
    : path === 'device' ? DEVICE_GUIDE
    : path.startsWith('device.') ? 'Read amux device --help for trusted local administration and device identity.'
    : path === 'git' ? GIT_GUIDE
    : path.startsWith('git.') ? 'Read amux git --help for original repository identity, working changes and worktree closeout.'
    : path === 'agent.native' ? NATIVE_RESUME_GUIDE
    : path.startsWith('agent.native.') ? 'Before native discovery or recovery, read amux agent native --help for original source and recovery conditions.'
    : path === 'agent.open' ? `${AGENT_OPEN_WORKFLOW}\nBefore choosing a destination read amux space --skill. Native resume/fork also requires amux agent native --help.`
    : path === 'space.mv' || path === 'file.open' || path === 'browser.open' ? 'Before choosing or changing a work surface, read amux space --skill. Selection, presentation and input focus are separate receipts.'
    : path === 'toolkit' ? AGENTMUX_TOOLKIT_GUIDE
    : path.startsWith('toolkit.') ? 'Read amux toolkit --help for discovery, exact typed inputs and retained operation results.'
    : path === 'settings' ? AGENTMUX_SETTINGS_RESOURCE_GUIDE
    : path.startsWith('settings.') ? 'Read amux settings --help for configuration ownership and compare-and-save conditions.'
    : path === 'goal.create' ? AGENTMUX_GOAL_CREATE_GUIDE
    : path === 'browser.task' ? AGENTMUX_BROWSER_TASK_GUIDE
    : path.startsWith('browser.task.') ? 'Read amux browser task --help for task parameters, run/cursor and human-checkpoint boundaries.'
    : path === 'browser.targets' ? AGENTMUX_BROWSER_TARGET_GUIDE : ''
  const children = list(path, selected)
  const operations = children ? `\n\nSubcommands:\n${children}` : ''
  if (!exact) return `${path.replaceAll('.', ' ')}${operations}\n\n${moduleGuide}\n\n${COMMON}\n\n${guide}`
  const flags = Object.entries(exact.flags ?? {}).map(([name, kind]) => name + (kind === 'boolean' ? '' : ' VALUE')).join(' ')
  return `${exact.summary}\n\nUsage: ${syntax(exact)}${flags ? '\n\nRegistered options: ' + flags : ''}${operations}\n\n${exact.details ?? ''}\n\n${moduleGuide}\n\n${COMMON}\n\n${guide}${path === 'browser.run' ? '\n\n' + AGENTMUX_BROWSER_PROGRAM_GUIDE : ''}`
}

export const AGENTMUX_CLI_SKILL = agentMuxBaseSkill()
