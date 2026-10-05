import { AGENTMUX_CLI_COMMANDS, type AgentMuxCliCommand } from './agentmux-cli-commands.js'
import { AGENTMUX_BROWSER_PROGRAM_GUIDE, AGENTMUX_BROWSER_TASK_GUIDE, AGENTMUX_BROWSER_TARGET_GUIDE } from './agentmux-cli-browser-guide.js'
import { browserPageCapabilityNames } from './browser-page-capability.js'
import { AGENTMUX_SETTINGS_RESOURCE_GUIDE, AGENTMUX_TOOLKIT_GUIDE, AGENTMUX_GOAL_CREATE_GUIDE } from './agentmux-cli-resource-guide.js'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE } from './agent-messaging-guidance.js'

export { AGENTMUX_SELF_CONTEXT_VERB } from './agent-self-context.js'
const syntax = (entry: AgentMuxCliCommand) => `amux ${entry.method.replaceAll('.', ' ')}${entry.usage ? ' ' + entry.usage : ''}`
const entries = (path: string) => AGENTMUX_CLI_COMMANDS.filter(entry => entry.method === path || entry.method.startsWith(path + '.'))
const list = (selected: readonly AgentMuxCliCommand[]) => selected.map(entry => `  ${syntax(entry)}\n    ${entry.summary}`).join('\n')
const GIT_GUIDE = `Discover the original workspace ID, hostId and path with amux app snapshot.
Pass all three to git history, commit, diff and open; an endpoint or current cwd is not that target.
History pages bind fixed roots. Reuse nextCursor unchanged; omit cursor to refresh.
Commit reads return the full message, all direct parents, a chosen-parent snapshot and entries.
Use a complete OID, and preserve snapshot plus both file paths for git diff --input FILE|-.
Reading never checks out, stages or writes Git. git open changes Desktop presentation only;
read and presentation are separate facts. Missing presentation replies remain unconfirmed.
Inspect app snapshot and space inspect for the exact existing Git Region before another open.
Wrong or unavailable targets reject only this request; existing workspaces and Agents remain available.`

const SPATIAL_GUIDE = `## Delegation and opening playbook (advisory)
"subagent" can mean Provider-native delegation or an independent AgentMux Session.
Choose from the user's purpose, available context and capabilities, how results return,
whether they need to see or continue the collaborator, and any specified Executor,
Host or execution Workspace. Briefly explain a clear choice; clarify material ambiguity.
Native delegation often suits a check within the current collaboration; an independent
Session often suits a directly accessible, continuing collaborator or another Executor/Host.
Hierarchy does not select the mechanism. Reuse a suitable exact Session when appropriate.
Neither mechanism guarantees complete context inheritance: check actual native fork or
delegation support and supply the relevant task, evidence and expected result.

Before opening an Agent or file, inspect your actual position and the intended Tab's
whole visible layout; your attached Region may be in the background. Keep exact display
Workspace/Group occurrences separate from execution cwd and file Zone/path.
For simultaneous comparison, consider a same-Tab split: left/right needs readable width
on both sides; up/down keeps more width but reduces reading height. Consider a new Tab
for a full workface, an independent task, long reading, or an already crowded layout.
Choose the exact anchor and direction from content and current geometry, rather than
always splitting right. Preserve existing content, readable text/actions and later human focus.

Related Tabs usually belong in the same appropriate display Group; consider proximity
to your own Tab and inspect the real order. Agent/File new Tabs append to that Group;
they do not offer before/after Tab flags. Do not copy another object's placement options.
If immediately-after placement is needed, a split followed by promoting its confirmed
new Region is an option only when the current display matches a single owner Group.
It temporarily changes layout and activates the new Tab; it is not a routine default,
cannot choose among multiple display occurrences, and must not move a reused old File Region.
Keep original content and execution ownership; proximity does not justify moving directories.

Background preparation usually preserves navigation/input. When the user intends to
read the opened content, choose the appropriate navigation explicitly; selection and
input focus are separate. Briefly name the mechanism and intended location before
opening, then confirm the returned identity, actual Tab/Region/order and navigation.
These are advisory strategies, not fixed directions, size thresholds or additional approval gates.

## Read an amux object link
An amux:// link carries one exact object identity, not a command, permission or sender credential.
Use the public @agentmux/core/sharing parseAmuxObjectLink helper to decode its URI path segment
without trimming or changing the original ID. Supported kinds are agent, region, tab, space and zone.
For amux://agent/<SID>, use agent inspect --session SID or agent send --to-session SID --text TEXT.
For the other kinds, use space inspect with --region, --tab, --space or --zone and the decoded ID.
Discover current Agent display positions with space ls; keep all original location candidates.
To navigate the Agent, choose an exact existing Region and display occurrence, then use
space focus --region REGION --display-workspace WORKSPACE --group GROUP --expect-session SID.
The expected Session is a condition on that Region, not a replacement for its spatial identity.
Other object links use space focus with their exact selector; ambiguous references require
an explicit location. Default input is preserve. Missing positions do not prove a Session ended.
Inspect unknown results before another action; do not start a replacement Agent to open a link.

## Choose a split from the visible layout
Read the exact presentation with amux space inspect --region REGION before choosing
where to open. Decide from the visible view so both the old and new content stay readable
with the least disturbance. Use the registered --region and --split destination options:

amux agent open --executor EXECUTOR --region REGION --split right --prompt TASK --operation-id OPERATION

Before opening a configured executor, use amux settings executors ls to find its exact ID.
For a remote execution target, use amux settings executors discover --host HOST and
choose that Host's Executor ID. For a new remote Agent below the local view, select its saved
Workspace independently:

amux agent open --executor EXECUTOR --execution-workspace WORKSPACE --region REGION --split down --prompt TASK --operation-id OPERATION

Split directions are left, right, up and down.
Opening a split and navigating to an existing Tab are separate operations.

## Open a file beside an exact Region
amux file open --path PATH --zone ZONE --tab TAB --region REGION --split right --display-workspace WORKSPACE --group GROUP --operation-id OPERATION

The Tab, anchor Region, direction (left/right/up/down), Display Workspace and Group
are one exact destination. Omitting the Tab/Region/split tuple selects the new-Tab
destination path, which may reuse an existing matching File presentation.
The reply names the actual File Region; the anchor is not the new Region's identity.
File opening stays in the background unless --focus is explicit.

## Choose a new Tab for a complete workface
amux agent open --executor EXECUTOR --zone ZONE --new-tab --display-workspace WORKSPACE --group GROUP --prompt TASK --operation-id OPERATION
amux file open --path PATH --zone ZONE --display-workspace WORKSPACE --group GROUP --operation-id OPERATION

Choose the actual Zone/resource and exact display Group. Omitting the Tab/Region/split
tuple selects the File new-Tab destination path, which may reuse an existing matching
presentation; File does not take the Agent's --new-tab flag.
Inspect the returned order rather than claiming that the new Tab is beside your own.

## Move a Region into its own Tab
amux space promote --region REGION --operation-id OPERATION
amux space mv --from-region REGION --expect-session SID --zone ZONE --new-tab --operation-id OPERATION

promote and mv move an existing presentation; they do not duplicate it or change the
execution cwd, Host, Session or Run. A move never starts, stops, or restarts a Run.
For mv, use --from-display-workspace and --from-group if the source Region has several
display placements. Name the exact source; do not choose the first location from a SID.

## Read what is in a direction
Read the Region's actual neighbors with amux space inspect --region REGION.
A split in that direction names the visible Region beside you. When nothing is split there,
left and right may name an adjacent Tab. These are not the same place.
Up and down never name a Tab. No neighbor is an explicit answer, not a failed observation.

## Confirm the actual destination
After opening an Agent or File, inspect the returned exact identity and actual locations.
An Agent's to and a File's placement/locations describe the result, not the anchor Region.
Confirm the requested direction or Tab order and whether navigation/input changed;
created, displayed, readable and focused are distinct facts.
After any move inspect the result to confirm where it landed, using the returned exact
Region and display placement. Use --display-workspace and --group when the presentation
needs those selectors; a resource ID alone does not prove a unique display location.
For a lost or unknown Agent creation/move reply, read amux space inspect --operation-id OPERATION first.
For File open, retain its operation and inspect the original file resource and actual File Regions;
operation inspection does not certify its missing original receipt. Today's display does not
prove a past submission. An unknown operation remains unconfirmed; do not blindly retry
the move or create another Agent.`

const DEVICE_GUIDE = `Device ls/link/revoke require a local Unix user; managed Agents and remote clients cannot administer devices.
Device link returns the current complete public offer URL; open it on a phone on the same local network.
Device hello names only the device bound to its completed encrypted handshake.
No pairing code, local OS approval or certificate installation is part of the connection flow.
After a missing revocation reply, read amux device ls and compare the exact deviceId facts.
Never automatically replay a device revocation.`

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
       amux --version

Commands:
${list(AGENTMUX_CLI_COMMANDS)}

${COMMON}

${DEVICE_GUIDE}`

export function agentMuxCommandHelp(path: string): string | null {
  const selected = entries(path)
  if (!selected.length) return null
  const exact = selected.find(entry => entry.method === path)
  const guide = path === 'device' || path.startsWith('device.') ? DEVICE_GUIDE
    : path === 'git' || path.startsWith('git.') ? GIT_GUIDE
    : path === 'space' || path.startsWith('space.') || path === 'agent.open' || path === 'file.open' ? SPATIAL_GUIDE
    : path === 'toolkit' || path.startsWith('toolkit.') ? AGENTMUX_TOOLKIT_GUIDE
    : path === 'settings' || path.startsWith('settings.') ? AGENTMUX_SETTINGS_RESOURCE_GUIDE
    : path === 'goal.create' ? AGENTMUX_GOAL_CREATE_GUIDE
    : path === 'browser.task' || path.startsWith('browser.task.') ? AGENTMUX_BROWSER_TASK_GUIDE
    : (path === 'browser' || path.startsWith('browser.')) && path !== 'browser.run' ? AGENTMUX_BROWSER_TARGET_GUIDE : ''
  if (!exact) return `${path.replaceAll('.', ' ')}\n\n${list(selected)}\n\n${COMMON}\n\n${guide}`
  return `${exact.summary}\n\nUsage: ${syntax(exact)}\n\n${exact.details ?? ''}\n\n${COMMON}\n\n${guide}${path === 'browser.run' ? '\n\n' + AGENTMUX_BROWSER_PROGRAM_GUIDE : ''}`
}

const capabilities = (effect: Parameters<typeof browserPageCapabilityNames>[0]) =>
  browserPageCapabilityNames(effect).map(name => `\`${name}\``).join(', ')

export const AGENTMUX_CLI_SKILL = `---
name: amux
description: Use the public object-first CLI to observe and operate AgentMux through its typed service.
---

Start with \`amux whoami\` to learn your verified identity, presentation and capabilities.
Discover before acting: \`app snapshot\` gives global resource facts; \`agent ls\` lists
real Sessions, \`settings executors ls\` lists saved execution choices, and \`space ls\`
lists display/resource bindings. Do not substitute the current Workspace for global discovery.

The actual executable command tree is:

${list(AGENTMUX_CLI_COMMANDS)}

${COMMON}

${SPATIAL_GUIDE}

${GIT_GUIDE}

Agent-first workflow:
1. Inspect Project resources and the intended Space separately with app snapshot and space inspect.
2. Choose a split or a new Tab from the advisory playbook. For a new Tab in an existing Zone,
   use agent open --zone ZONE --new-tab --executor EXECUTOR --prompt TASK.
3. To create a Zone, supply --project PROJECT --space SPACE --new-zone and either
   --worktree --path PATH --new-branch BRANCH or --directory PATH. If a Project's source
   is ambiguous, inspect its real Workspaces and explicitly pass --source-workspace WORKSPACE.
4. Retain the exact business operation ID, returned SID/Run and spatial address.
5. Use agent inspect, agent output and agent send for follow-up. Delivery is not completed work.
6. After a lost Agent creation/move reply, read space inspect --operation-id ID;
   for File open, retain the original resource and inspect its actual Regions as above.
   An unknown original operation stays unconfirmed; do not blindly repeat.

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

${DEVICE_GUIDE}

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
