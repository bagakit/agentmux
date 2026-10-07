import { AGENTMUX_CLI_COMMANDS } from './agentmux-cli-commands.js'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE } from './agent-messaging-guidance.js'
import { AGENTMUX_NOTE_GUIDE } from './agentmux-cli-note-guide.js'
import { AGENTMUX_BROWSER_PROGRAM_GUIDE, AGENTMUX_BROWSER_TASK_GUIDE, AGENTMUX_BROWSER_TARGET_GUIDE } from './agentmux-cli-browser-guide.js'
import { AGENTMUX_SETTINGS_RESOURCE_GUIDE, AGENTMUX_TOOLKIT_GUIDE, AGENTMUX_GOAL_CREATE_GUIDE } from './agentmux-cli-resource-guide.js'
import { AGENT_OPEN_WORKFLOW, DEVICE_GUIDE, DIAGNOSTIC_GUIDE, GIT_GUIDE, GOAL_ACTIVITY_GUIDE, NATIVE_RESUME_GUIDE, SPATIAL_GUIDE } from './agentmux-cli-shared-guides.js'
import { browserPageCapabilityNames } from './browser-page-capability.js'
import { goalRoleGuidanceContract } from './goal-role-guidance.js'

interface ModuleDefinition {
  summary: string
  roles: string
  when: string
  guide: string
}

/** Documents are owned here; module names and availability follow the executable registry. */
const definitions: Readonly<Record<string, ModuleDefinition>> = {
  agent: {
    summary: 'Agent Sessions, original inputs, conversation and lifecycle',
    roles: 'All Agents; execution and coordination',
    when: 'Inspect, open, communicate with or recover an Agent',
    guide: `Core owns AgentSession, Provider semantic state, input permission and recovery; ctxmux
owns Run/process/output facts. Executor configuration, durable Session, one Run and its
display Regions are distinct objects. Begin with agent ls and agent inspect for the exact
Session and routeHostId. Use configured settings executors discovery before opening.
Choose Provider-native collaboration or an independent Session from the user's purpose.
Keep original operation, Session, Run and resource identities; a new display is not a new task.

agent output reads ordered original bytes; closing the reader does not stop the Agent.
agent conversation operations read source-qualified records, while original history/resource
reads retain their own provenance and cursor. Status prose is not permission or input proof.
Ordinary input must use the original public input/message owner and returned admission facts.
agent interrupt, stop, resume and reopen are distinct explicit lifecycle operations. Observe
the original input after an uncertain send; inspect a creation/move operation before another
action. A handshake or status probe failure never authorizes stopping a healthy Run.

${AGENTMUX_AGENT_MESSAGING_GUIDANCE}

${NATIVE_RESUME_GUIDE}

${AGENT_OPEN_WORKFLOW}

${SPATIAL_GUIDE}`
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

Use app search with the appropriate metadata/content mode, retaining each result's source
identity and availability. Inspect an exact returned object through its module before an
operation. app focus selects a surface; it does not accept a task or certify input eligibility.
Selection, focus and native input receipts are separate. Preserve current drafts and caret
unless navigation/input change was explicitly requested. Partial or unavailable discovery
does not mean objects are absent; retain the original view and inspect its exact owner.
For Agent/File/Browser opening or layout changes, read their module and the space module first.`
  },
  browser: {
    summary: 'Embedded Browser targets, page programs, tasks and original receipts',
    roles: 'Agents reading or operating web pages',
    when: 'Open, inspect, automate or recover a Browser operation',
    guide: `The Browser owner holds exact Browser/page targets, page capabilities and operation
receipts. Core does not infer website-specific state from labels. Read targets and the exact
Browser identity before a program; use only capabilities and elements named by that read.
Keep action/navigation/delivery and business completion separate. An application link may
await a person's system handoff while the original page remains unchanged.

Page capabilities come from the actual owner:
${(['observe', 'act', 'wait', 'navigate'] as const).map(effect => `${effect}: ${browserPageCapabilityNames(effect).map(name => `\`${name}\``).join(', ')}`).join('\n')}

${AGENTMUX_BROWSER_TARGET_GUIDE}

${AGENTMUX_BROWSER_PROGRAM_GUIDE}

${AGENTMUX_BROWSER_TASK_GUIDE}

${SPATIAL_GUIDE}`
  },
  connection: {
    summary: 'External connection configuration, bindings, ingress and delivery',
    roles: 'Authorized connection operators and coordinating Agents',
    when: 'Inspect or operate an exact external communication connection',
    guide: `The connection owner holds configured adapters, bindings, grants, ingress and delivery
receipts. Begin with connection ls/inspect; configuration, a successful test, an enabled
binding, ingress and actual outgoing delivery are distinct facts. Keep the exact connection,
binding and source identities rather than matching human labels or assuming transport trust.

Configure or bind only within the user's authorized target. Inspect current values before
changing them; use the current help's exact input and operation identities. A grant is an
explicit authority decision, not an effect of reading this guide or an adapter message.
Read connection ingress and delivery records for their original source and acknowledgement.
Pause/relink affects the exact binding; it does not complete external work or stop Agents.
After an unknown delivery, inspect the original delivery identity. Retry only as the explicit
supported delivery operation with its frozen facts; never generate a second logical message
because a response was lost. Unavailable adapters retain configured bindings and known receipts.`
  },
  device: {
    summary: 'Local device pairing, encrypted identity and revocation',
    roles: 'Authorized local user; connected devices for their own hello',
    when: 'Inspect or explicitly administer a paired device',
    guide: `The local device owner holds pairing and revocation; encrypted handshake facts identify
one device, not a general user approval. Read device ls before administering an exact device.
Pairing changes connectivity and does not create an Agent or accept a Goal. Retain the complete
returned offer and exact deviceId. Current discovery cannot certify an earlier lost revocation.

${DEVICE_GUIDE}`
  },
  file: {
    summary: 'Exact file resources, editor presentation, saves, uploads and builds',
    roles: 'Agents reading, editing or presenting files',
    when: 'Read/write a file or open its editor workface',
    guide: `The file owner holds resource reads/writes, save/upload/build receipts and editor state.
Identify the original Host, Zone/workspace and literal path independently from the intended
display Tab/Region. file read/ls access resources; file open/view access presentation. Opening
does not save or overwrite a file. Inspect the original view and preserve unsaved user drafts.

Use file write/create with the exact current contract and retain the original result. A save
request is not a confirmed disk write; partial or unknown results remain unconfirmed. Upload
and build operations have their own retained identities and inspect/cancel paths. Inspect the
same upload/build after a lost reply instead of issuing a new logical operation. Formatting
and build output do not certify a user's acceptance. Wrong targets reject only that request;
unavailable resource reads never authorize removing a view, replacing content or stopping a Run.

${SPATIAL_GUIDE}`
  },
  git: {
    summary: 'Read-only Git history/diff and exact Desktop Git presentation',
    roles: 'Agents inspecting repository evidence',
    when: 'Read commits or display the original repository history',
    guide: `The Git owner reads an exact resource repository. Commits, parent-selected trees and
diff snapshots retain their original identities; a displayed history is not a checkout or
workspace mutation. Begin with global resource discovery, then preserve complete OIDs and
the returned pagination/snapshot facts through each read and presentation request.

${GIT_GUIDE}`
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

${AGENTMUX_GOAL_CREATE_GUIDE}`
  },
  message: {
    summary: 'Authenticated messages, pending input, inbox and original dispatch reports',
    roles: 'Agents communicating across independent Sessions',
    when: 'Inspect delivery, manage pending input or report through an original dispatch',
    guide: `Core owns authenticated messages, ordered delivery, inbox generations and original
dispatch threads. Begin with message inbox check and read the exact original message or
dispatch before replying. Keep operationId, messageId, source message, thread and reply
identities. Pending drafts, queued input, delivery and business reports are different states.

Use agent send for a new authorized cross-Session message; message read/delivery inspect and
dispatch inspect/read reconcile the original exchange. Pending edit/send/stop/archive/restore
operate one retained pending item, not a new message. Inbox acknowledgement records reading
of its exact generation and reader Run; it does not report work or complete a Goal. Dispatch
report uses the actual source/reply and kind; worker_done is a report pending collection.
Unknown/partial input remains original and cannot be blindly resent with fresh identities.

${AGENTMUX_AGENT_MESSAGING_GUIDANCE}`
  },
  mote: {
    summary: 'Read-only PMO working manual and Mote collaboration boundaries',
    roles: 'PMO and coordinating Agents',
    when: 'Load the default management working method',
    guide: `Mote is a real Topic/resource-backed workface; its SOUL/Wiki and user composition remain
filesystem/user materials. mote playbook pmo returns a read-only default coordination manual.
It launches nothing, sends nothing, registers no role and changes no SOUL/Wiki/user profile.
Read that manual for opening, naming, coordination and recovery choices, and amux goal --skill
for the shared execution/management responsibility contract. A loaded guide does not prove
that an existing live model adopted new instructions.

Discover Mote resources through app/space and topic owners; do not derive a resource path from
its display HomeZone or invent absent material. For work, inspect the exact Goal and original
Session/Run. Management must inspect evidence and write progress/next responsibility back to
the same Goal after actual patrol; delivery or worker_done does not finish the work. Missing
resources or a busy manager retain original drafts, request identities and recovery actions.`
  },
  name: {
    summary: 'Original naming history and name-write persistence confirmation',
    roles: 'Agents inspecting names or confirming an original name write',
    when: 'Inspect naming provenance or the disk result of an exact operation',
    guide: `The original object owner holds displayName, source and nameRevision; names never
authenticate identity, ownership or execution. Read name history for the exact Agent/Tab
before a confirmation. Keep object identity, name source, operation and revision separate.

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
their real filesystem source. Begin with notebook ls/resolve/inspect, retain exact source
and revision, then apply only the authorized graph/content changes. A visual link or name
is not a source identity, and unavailable notes are not an empty catalog.

${AGENTMUX_NOTE_GUIDE}`
  },
  schedule: {
    summary: 'Explicit scheduled-task discovery and lifecycle',
    roles: 'Authorized scheduling operators',
    when: 'Inspect, create, pause, resume or cancel a scheduled task',
    guide: `The scheduler owns schedule identity, timing, lifecycle and original run references.
Reading this module creates no schedule or periodic Loop. Begin with schedule list/inspect
and retain the exact schedule ID, current revision and requested trigger. Create only when
the user has explicitly authorized scheduled work, within that scope and original target.

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

${AGENTMUX_SETTINGS_RESOURCE_GUIDE}`
  },
  space: {
    summary: 'Durable spatial identities, display layout and exact navigation',
    roles: 'Agents opening, arranging or navigating workfaces',
    when: 'Inspect a visible layout or move an exact presentation',
    guide: `Core owns durable Space/Zone/Tab/Region identities, topology and bindings; the client
owns presentation, navigation and input focus. Inspect exact locations and display
Workspace/Group occurrences before changing a layout. A presentation move leaves execution
Host, cwd, Session and Run intact. Keep original operation receipts and all location candidates.

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

${AGENTMUX_TOOLKIT_GUIDE}`
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
    `| ${module.root} | ${module.summary} | ${module.roles}; ${module.when} | \`${module.readCommand}\` |`).join('\n')
  return `---\nname: amux\ndescription: Discover AgentMux identity, common boundaries and local module guides.\n---\n
Start with \`amux whoami\` once to learn your verified Session, Run, Host, presentation
and capabilities. Discover exact objects before acting; the current UI or cwd is not a
global inventory. Endpoint, Host route, execution identity and display location are distinct.
Core owns Agent identity, permission, input and recovery; ctxmux owns Run/process/bytes;
the original business or client owner holds its own records and presentation.

RPC wire IDs only correlate transport messages; the business operation ID identifies the
original action. Without a complete success reply, the commit result is unconfirmed;
do not automatically retry the write. A current read cannot certify an earlier lost receipt.
Unknown/stale/unavailable observations retain original identities, requests, healthy input
and durable work surfaces. Reader cancellation only detaches that reader. Selection,
presentation and input eligibility have separate receipts. Guidance changes no SOUL/Wiki/user profile.

${AGENTMUX_AGENT_MESSAGING_GUIDANCE}

## Load only the needed modules

Read \`amux MODULE --skill\` before working in that domain. The directory below follows
this version's actual registered command roots. Each module supplies its owner, journey,
responsibility and failure/recovery guidance. Before opening an Agent/file/page or changing
layout, read its module and \`amux space --skill\` for the advisory opening playbook; inspect
the actual visible layout and briefly explain the chosen location.

| Module | Scope | Roles and trigger | Local read |
| --- | --- | --- | --- |
${directory}

Module reads and \`--help\` are local: they do not connect to Runtime, launch a Run,
send a task or register a role. Use \`amux MODULE --help\` and leaf \`--help\` for exact
arguments in this version; IDs and text are literal data. For positional data, prefer
\`amux --help MODULE ACTION\` so help flags cannot be mistaken for that data. A missing
module rejects only that read; retain original healthy Agents and requests. Goal executors
and managers read \`amux goal --skill\`; the default PMO handbook is discovered in \`amux mote --skill\`.
Reading a module is not proof that an existing live model adopted its instructions.
`
}
