import { readControlJsonInput } from './cli-json-input.js'
import { randomUUID } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE } from './agent-messaging-guidance.js'
import { parseSettingsCommand } from './settings-cli.js'
import { parseToolkitCommand } from './toolkit-cli.js'
import { SPLIT_FLAG_DIRECTIONS } from './split-direction-ssot.js'
import type { AgentMuxRpcParams } from './public-rpc.js'

type FlagKind = 'boolean' | 'value' | 'data'
type FlagSpec = Readonly<Record<string, FlagKind>>
type Flags = { values: Map<string, string>; booleans: Set<string> }
export interface AgentMuxCliCommand {
  method: string
  usage: string
  summary: string
  details?: string
  flags?: FlagSpec
  positionalData?: number
  stream?: boolean
  local?: boolean
  parse(args: readonly string[]): Promise<Record<string, unknown>>
}
export interface AgentMuxCliInvocation {
  command: AgentMuxCliCommand
  params: Record<string, unknown>
  endpoint?: string
}

const invalid = (message: string): never => { throw new AgentMuxError(message, 'INVALID_CLI_ARGUMENT') }
function flags(args: readonly string[], specs: FlagSpec): Flags {
  const values = new Map<string, string>(), booleans = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    const separator = argument.indexOf('=')
    const name = separator < 0 ? argument : argument.slice(0, separator)
    const inline = separator < 0 ? undefined : argument.slice(separator + 1)
    if (!Object.hasOwn(specs, name)) invalid(`Unsupported option: ${name}`)
    if (values.has(name) || booleans.has(name)) invalid(`Duplicate option: ${name}`)
    if (specs[name] === 'boolean') {
      if (inline !== undefined) invalid(`Option does not accept a value: ${name}`)
      booleans.add(name)
    } else {
      const value = inline ?? args[++index]
      if (value === undefined || (inline === undefined && specs[name] === 'value' && value.startsWith('--'))) invalid(`Missing value for ${name}.`)
      values.set(name, value!)
    }
  }
  return { values, booleans }
}
const value = (f: Flags, name: string, required = false): string | undefined => {
  const result = f.values.get(name)
  if (required && result === undefined) invalid(`${name} is required.`)
  return result
}
function id(f: Flags, name: string, exact = false): string {
  const result = value(f, name, true)!
  if (!result.length) invalid(`${name} must not be empty.`)
  if (exact && result === 'self') invalid(`${name} requires an exact ID, not self.`)
  return result
}
function one(f: Flags, names: readonly string[], label: string): string {
  const selected = names.filter(name => f.values.has(name))
  if (selected.length !== 1) invalid(`${label} requires exactly one of ${names.join(', ')}.`)
  return selected[0]!
}
function fields(f: Flags, map: Readonly<Record<string, string>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(map).filter(([flag]) => f.values.has(flag)).map(([flag, key]) => [key, key.endsWith('Id') ? id(f, flag) : f.values.get(flag)]))
}
const operation = (f: Flags): { operationId: string } => ({ operationId: f.values.has('--operation-id') ? id(f, '--operation-id') : randomUUID() })
const numbers = (f: Flags, map: Readonly<Record<string, string>>): Record<string, unknown> => Object.fromEntries(
  Object.entries(map).filter(([flag]) => f.values.has(flag)).map(([flag, key]) => {
    const result = Number(f.values.get(flag))
    if (!Number.isFinite(result)) invalid(`${flag} must be a number.`)
    return [key, result]
  }))
function command(method: string, usage: string, summary: string, specs: FlagSpec,
  parse: (f: Flags) => Record<string, unknown> | Promise<Record<string, unknown>>, details?: string): AgentMuxCliCommand {
  return { method, usage, summary, flags: specs, ...(details ? { details } : {}), parse: async args => parse(flags(args, specs)) }
}
const empty = (method: string, summary: string): AgentMuxCliCommand => command(method, '', summary, {}, () => ({}))
const OP = { '--operation-id': 'data' } as const
const SELECTOR = { '--space': 'data', '--zone': 'data', '--tab': 'data', '--region': 'data', '--display-workspace': 'data', '--group': 'data' } as const
const DESTINATION = { ...SELECTOR, '--new-tab': 'boolean', '--split': 'value', '--focus': 'boolean', ...OP } as const
const FILTERS = { '--project': 'data', '--workspace': 'data', '--topic': 'data', '--session': 'data', '--goal': 'data', '--executor': 'data', '--status': 'value', '--since': 'value', '--limit': 'value' } as const
const GOAL_FILTERS = { '--project': 'data', '--session': 'data', '--goal': 'data', '--executor': 'data', '--status': 'value', '--since': 'value', '--limit': 'value' } as const
const FILTER_FIELDS = { '--project': 'projectId', '--workspace': 'workspaceId', '--topic': 'topicId', '--session': 'agentSessionId', '--goal': 'goalId', '--executor': 'executorId', '--status': 'status' }
const selector = (f: Flags) => fields(f, { '--space': 'spaceId', '--zone': 'zoneId', '--tab': 'tabId', '--region': 'regionId', '--display-workspace': 'displayWorkspaceId', '--group': 'groupId' })
const filters = (f: Flags) => ({ ...fields(f, FILTER_FIELDS), ...numbers(f, { '--since': 'since', '--limit': 'limit' }) })
const destination = (f: Flags) => ({ ...selector(f), ...(f.booleans.has('--new-tab') ? { newTab: true } : {}), ...fields(f, { '--split': 'split' }) })
const focus = (f: Flags) => f.booleans.has('--focus')
const targetSession = (session: string) => session === 'self' ? { kind: 'self' } : { kind: 'agent-session', agentSessionId: session }
const name = (f: Flags): string | null => {
  if (Number(f.values.has('--name')) + Number(f.booleans.has('--clear')) !== 1) invalid('Rename requires exactly one of --name or --clear.')
  return f.booleans.has('--clear') ? null : value(f, '--name', true)!
}
const SAVE_NOTICE = 'A missing complete reply leaves the operation unconfirmed. Read back the exact business identity before deciding; do not automatically retry a write. Save requests do not prove disk durability.'

function openPlacement(f: Flags): Record<string, unknown> {
  const selected = one(f, [...Object.keys(SPLIT_FLAG_DIRECTIONS), '--tab', '--in-region'], 'Open')
  const target = id(f, selected)
  if ((selected === '--tab') !== f.booleans.has('--new-tab')) invalid('--tab and --new-tab must be used together.')
  if (selected === '--tab') return { destination: { kind: 'new-tab', after: target === 'self' ? { kind: 'self' } : { kind: 'tab', tabId: target } } }
  if (selected === '--in-region') return { destination: { kind: 'launcher', regionId: id(f, selected, true) } }
  const direction = SPLIT_FLAG_DIRECTIONS[selected as keyof typeof SPLIT_FLAG_DIRECTIONS]
  if (!direction) invalid('Unsupported split direction.')
  return { destination: { kind: 'split', direction, region: target === 'self' ? { kind: 'self' } : { kind: 'region', regionId: target } } }
}
const PLACEMENT: FlagSpec = { ...Object.fromEntries(Object.keys(SPLIT_FLAG_DIRECTIONS).map(flag => [flag, 'data' as const])), '--tab': 'data', '--new-tab': 'boolean', '--in-region': 'data', ...OP }
const PLACEMENT_USAGE = '(--left-of ID|--right-of ID|--above ID|--below ID|--tab ID --new-tab|--in-region ID)'
function inspectTarget(f: Flags): Record<string, unknown> {
  const selected = one(f, ['--session', '--run', '--provider-native', '--acp-native'], 'Agent inspect')
  if (f.values.has('--provider') !== (selected === '--provider-native') || f.values.has('--adapter') !== (selected === '--acp-native')) invalid('Native Session selectors require their matching Provider or adapter, and no unrelated qualifier.')
  const selectedId = id(f, selected)
  if (selected === '--session') return targetSession(selectedId)
  if (selected === '--run') return { kind: 'run', run: { runId: selectedId } }
  if (selected === '--provider-native') return { kind: 'provider-native', providerId: id(f, '--provider'), sessionId: selectedId }
  return { kind: 'acp-native', adapterId: id(f, '--adapter'), sessionId: selectedId }
}
function settings(method: string, usage: string, summary: string, positionalData = 0): AgentMuxCliCommand {
  const prefix = method.split('.').slice(1)
  return { method, usage, summary, positionalData, details: SAVE_NOTICE,
    parse: async args => (await parseSettingsCommand([...prefix, ...args])).params }
}
function toolkit(action: string, usage: string, summary: string, positionalData = 1): AgentMuxCliCommand {
  return { method: `toolkit.${action}`, usage, summary, positionalData,
    ...(action === 'watch' ? { stream: true } : {}), details: SAVE_NOTICE,
    parse: async args => (await parseToolkitCommand([action, ...args])).params }
}
function goal(method: string, usage: string, summary: string, specs: FlagSpec, build: (f: Flags) => Record<string, unknown>, write = false): AgentMuxCliCommand {
  return command(`goal.${method}`, usage, summary, { '--goal': 'data', ...specs, ...(write ? OP : {}) }, f => ({ goalId: id(f, '--goal'), ...build(f), ...(write ? operation(f) : {}) }), write ? SAVE_NOTICE : undefined)
}

/** Actual executable registration. Help, skill and playbooks enumerate this same source. */
export const AGENTMUX_CLI_COMMANDS: readonly AgentMuxCliCommand[] = [
  empty('notebook.ls', 'Read the durable Notebook and Note directory without opening an App or a page.'),
  command('notebook.inspect', '(--notebook ID|--note ID|--operation-id ID)', 'Read an exact Notebook, Note source/history or original knowledge operation.',
    { '--notebook':'data','--note':'data',...OP }, f => { const selected=one(f,['--notebook','--note','--operation-id'],'Inspect');return {[selected==='--notebook'?'notebookId':selected==='--note'?'noteId':'operationId']:id(f,selected)} }),
  command('notebook.apply', '--revision N --operation-id ID --change-json JSON', 'Apply one typed knowledge change; preserve original Note bodies and reconcile the same operation after a lost response.',
    { '--revision':'value','--change-json':'data',...OP }, f => {
      const expectedRevision=Number(value(f,'--revision',true));if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)invalid('Revision must be a nonnegative integer.')
      let change:unknown;try{change=JSON.parse(value(f,'--change-json',true)!)}catch{invalid('--change-json requires valid JSON.')}
      return {expectedRevision,...operation(f),change}
    },SAVE_NOTICE),

  empty('topic.category.ls', 'Discover original filesystem-backed knowledge categories.'),
  command('topic.category.create', '--category UUID --title TEXT', 'Create one exact knowledge category without starting an Agent.', { '--category': 'data', '--title': 'data' }, f => ({ categoryId: id(f, '--category', true), title: value(f, '--title', true)! }), SAVE_NOTICE),
  command('topic.category.rename', '--category UUID --title TEXT --revision HASH', 'Rename a category while preserving its directory and spatial identity.', { '--category': 'data', '--title': 'data', '--revision': 'data' }, f => ({ categoryId: id(f, '--category', true), title: value(f, '--title', true)!, expectedRevision: id(f, '--revision') }), SAVE_NOTICE),
  command('topic.ls', '[--category UUID] [--topic ID]', 'Discover ordinary Topics with original category and Chat bindings.', { '--category': 'data', '--topic': 'data' }, f => fields(f, { '--category': 'categoryId', '--topic': 'topicId' })),
  command('topic.inspect', '--topic ID', 'Read one exact Topic and its original spatial membership.', { '--topic': 'data' }, f => ({ topicId: id(f, '--topic', true) })),
  command('topic.create', '--topic ID --title TEXT [--category UUID]', 'Create one exact Topic in a knowledge category without starting a Run.', { '--topic': 'data', '--title': 'data', '--category': 'data' }, f => ({ topicId: id(f, '--topic', true), title: value(f, '--title', true)!, ...fields(f, { '--category': 'categoryId' }) }), SAVE_NOTICE),
  command('topic.move', '--topic ID --category UUID --revision NUMBER', 'Move the whole Topic to one category, preserving content, Chat identities and execution.', { '--topic': 'data', '--category': 'data', '--revision': 'value' }, f => ({ topicId: id(f, '--topic', true), categoryId: id(f, '--category', true), expectedRevision: Number(value(f, '--revision', true)) }), SAVE_NOTICE),
  command('topic.knowledge.ls', '--topic ID [--limit N]', 'Read knowledge entries in one exact ordinary Topic, retaining per-entry unknown facts.', { '--topic': 'data', '--limit': 'value' }, f => ({ topicId: id(f, '--topic', true), ...numbers(f, { '--limit': 'limit' }) })),
  command('topic.knowledge.search', '--query TEXT [--topic ID] [--limit N]', 'Search saved knowledge and source locators without reading or copying original conversations.', { '--topic': 'data', '--query': 'data', '--limit': 'value' }, f => ({ query: value(f, '--query', true)!, ...fields(f, { '--topic': 'topicId' }), ...numbers(f, { '--limit': 'limit' }) })),
  command('topic.knowledge.read', '--topic ID --entry UUID', 'Read one exact knowledge entry, its sources and content revision.', { '--topic': 'data', '--entry': 'data' }, f => ({ topicId: id(f, '--topic', true), entryId: id(f, '--entry', true) })),
  command('topic.knowledge.write', '--input FILE|-', 'Save a typed knowledge entry at its exact expectedRevision without starting or messaging an Agent.', { '--input': 'data' }, async f => await readControlJsonInput(value(f, '--input', true)!, 'Topic knowledge') as Record<string, unknown>, 'The JSON carries exact topicId/entryId, title, content, form, certainty, sources and expectedRevision (null to create). Read the original revision before editing. ' + SAVE_NOTICE),
  empty('topic.migrate.preview', 'Preview existing local Topic identities and exact category changes without writing.'),
  command('topic.migrate.apply', '--revision NUMBER', 'Apply the inspected local Topic organization at its exact spatial revision.', { '--revision': 'value' }, f => ({ expectedRevision: Number(value(f, '--revision', true)) }), 'Read topic migrate preview first. The original owner preserves content and writes a backup before the spatial change. ' + SAVE_NOTICE),
  empty('space.state', 'Read the Core durable spatial graph and revision without a graphical frontend.'),
  command('space.commit', '--revision N [--allow-entity-removal] < graph.json', 'Commit a spatial graph from JSON stdin using an exact revision; stale writes are refused.',
    {'--revision':'value','--allow-entity-removal':'boolean'}, f => {
      const expectedRevision = Number(value(f,'--revision',true))
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalid('Revision must be a nonnegative integer.')
      return {expectedRevision,...(f.booleans.has('--allow-entity-removal') ? {allowEntityRemoval:true} : {})}
    }),
  command('space.resolve', '--tab ID --region ID --direction left|right|up|down', 'Resolve relative positions from the original durable split tree.',
    {'--tab':'data','--region':'data','--direction':'value'}, f => ({tabId:id(f,'--tab'),regionId:id(f,'--region'),direction:value(f,'--direction',true)})),
  empty('whoami', 'Read your verified Session, Run, presentation and available capabilities.'),
  empty('device.ls', 'Read original Host device and pending-request facts through a local Unix user request.'),
  empty('device.invite', 'Request an invitation; the Host requires actual local OS confirmation.'),
  command('device.approve', '--device ID --confirmation-code CODE', 'Request approval of one exact pending device; the Host confirms the original code and user decision.',
    { '--device': 'data', '--confirmation-code': 'data' }, f => ({ deviceId: id(f, '--device'), confirmationCode: value(f, '--confirmation-code', true)! } satisfies AgentMuxRpcParams<'device.approve'>)),
  command('device.reject', '--device ID', 'Request rejection of one exact pending device with actual local OS confirmation.',
    { '--device': 'data' }, f => ({ deviceId: id(f, '--device') } satisfies AgentMuxRpcParams<'device.reject'>)),
  command('device.revoke', '--device ID', 'Request revocation of one exact device with actual local OS confirmation.',
    { '--device': 'data' }, f => ({ deviceId: id(f, '--device') } satisfies AgentMuxRpcParams<'device.revoke'>)),
  command('agent.ls', '[--session ID] [--executor ID] [--status VALUE] [--since N] [--limit N]', 'List actual Core Agent Sessions; retain unavailable item facts.', { '--session': 'data', '--executor': 'data', '--status': 'value', '--since': 'value', '--limit': 'value' }, filters),
  command('agent.reopen', '--session ID --retired-at MS [--launch-json JSON] [--operation-id ID]',
    'Explicitly continue the same retired native conversation without sending a prompt.',
    { '--session': 'data', '--retired-at': 'value', '--launch-json': 'data', ...OP }, f => {
      if (!f.values.has('--retired-at')) invalid('--retired-at is required.')
      let launch: Record<string, unknown> = {}
      if (f.values.has('--launch-json')) {
        try { launch = JSON.parse(value(f, '--launch-json', true)!) } catch { invalid('--launch-json requires valid JSON.') }
        if (!launch || typeof launch !== 'object' || Array.isArray(launch) ||
          Object.keys(launch).some(key => !['args', 'env', 'commandOverride', 'launchOptions', 'cols', 'rows'].includes(key))) invalid('--launch-json requires current launch configuration only.')
      }
      return { ...launch, ...operation(f), agentSessionId: id(f, '--session', true), ...numbers(f, { '--retired-at': 'expectedRetiredAt' }) }
    }),
  command('agent.reopen.check', '--session ID --retired-at MS --operation-id ID',
    'Confirm the original continue operation without starting or stopping a Run.',
    { '--session': 'data', '--retired-at': 'value', ...OP }, f => {
      if (!f.values.has('--operation-id') || !f.values.has('--retired-at')) invalid('--operation-id and --retired-at are required.')
      return { agentSessionId: id(f, '--session', true), operationId: value(f, '--operation-id', true)!, ...numbers(f, { '--retired-at': 'expectedRetiredAt' }) }
    }),
  command('agent.inspect', '(--session ID|--run ID|--provider-native ID --provider ID|--acp-native ID --adapter ID)', 'Inspect Core identity and current Desktop display facts separately.',
    { '--session': 'data', '--run': 'data', '--provider-native': 'data', '--provider': 'data', '--acp-native': 'data', '--adapter': 'data' }, f => ({ target: inspectTarget(f) })),
  command('agent.history', '--host ID --session ID --source captured|native [--limit N] [--cursor CURSOR] [--max-bytes N]',
    'Read exact retained Session history without operating its Run.',
    { '--host': 'data', '--session': 'data', '--source': 'value', '--limit': 'value', '--cursor': 'data', '--max-bytes': 'value' }, f => {
      const source = value(f, '--source', true)
      if (source !== 'captured' && source !== 'native') invalid('--source requires captured or native.')
      return { hostId: id(f, '--host'), agentSessionId: id(f, '--session', true), source,
        ...numbers(f, { '--limit': 'limit', '--max-bytes': 'maxBytes' }), ...fields(f, { '--cursor': 'cursor' }) }
    }, 'Sources are explicit: missing native identity does not erase captured work. Follow nextCursor with the same Host/Session/source. A fragment is exact JSON UTF-8 bytes in base64; concatenate contiguous offsets and verify its SHA-256 before parsing. Host restart or source change requires reading the first page again. Reading never restores, attaches, sends or stops a Run.'),
  command('agent.open', '(--executor ID|--session ID) <destination> [--prompt TEXT] [--focus] [--operation-id ID]', 'Open an Agent at an explicit Space/Zone/Tab/Region; default is background.',
    { ...DESTINATION, '--executor': 'data', '--session': 'data', '--prompt': 'data', '--new-zone': 'boolean', '--worktree': 'boolean', '--path': 'data', '--branch': 'data', '--new-branch': 'data', '--directory': 'data', '--project': 'data', '--source-workspace': 'data' }, f => {
      const selected = one(f, ['--executor', '--session'], 'Agent open')
      const resourceOptions = ['--path', '--branch', '--new-branch', '--directory', '--project', '--source-workspace'].filter(flag => f.values.has(flag))
      const dest = destination(f)
      if (selected === '--session' && (f.values.has('--prompt') || f.booleans.has('--new-zone'))) invalid('--session cannot supply an initial prompt or create a Zone.')
      if (!f.booleans.has('--new-zone')) {
        if (resourceOptions.length || f.booleans.has('--worktree')) invalid('Project/resource options require --new-zone.')
      } else {
        const projectId = id(f, '--project'), source = fields(f, { '--source-workspace': 'sourceWorkspaceId' })
        if (f.booleans.has('--worktree')) {
          if (f.values.has('--directory')) invalid('--worktree cannot be combined with --directory.')
          const branch = one(f, ['--branch', '--new-branch'], 'Worktree Zone')
          Object.assign(dest, { newZone: { kind: 'worktree', projectId, ...source, path: id(f, '--path'), branch: id(f, branch), createBranch: branch === '--new-branch' } })
        } else {
          if (['--path', '--branch', '--new-branch'].some(flag => f.values.has(flag))) invalid('Git path/branch options require --worktree.')
          Object.assign(dest, { newZone: { kind: 'directory', projectId, ...source, path: id(f, '--directory') } })
        }
      }
      return { ...operation(f), content: selected === '--executor'
        ? { kind: 'new-agent', executorId: id(f, selected), ...fields(f, { '--prompt': 'prompt' }) }
        : { kind: 'agent-session', agentSessionId: id(f, selected, true) }, destination: dest, focus: focus(f) }
    }, `Use --zone ZONE --new-tab for an existing Zone. New resources require --project PROJECT --space SPACE --new-zone, then --worktree --path PATH (--branch BRANCH|--new-branch BRANCH) or --directory PATH. --source-workspace WORKSPACE resolves an explicit source within the Project when necessary. Project is an execution resource; Space is a presentation. No existing Tab anchor is required. ${SAVE_NOTICE}`),
  command('agent.rename', '--session ID (--name TEXT|--clear)', 'Set or clear the original Session display override.', { '--session': 'data', '--name': 'data', '--clear': 'boolean', ...OP }, f => ({ ...operation(f), agentSessionId: id(f, '--session', true), name: name(f) }), SAVE_NOTICE),
  command('agent.view', '--session ID [--mode terminal|activity]', 'Read or change all presentations of one exact SID without taking focus.', { '--session': 'data', '--mode': 'value', ...OP }, f => ({ agentSessionId: id(f, '--session', true), ...fields(f, { '--mode': 'mode' }), ...(f.values.has('--mode') ? operation(f) : {}) }), 'Without --mode this is read-only. A known durable Agent projection remains usable while Core facts are unknown; no healthy Run is stopped.'),
  { ...command('agent.output', '--session ID [--after-byte N] [--follow]', 'Read replay or follow ordered raw output bytes, with cursor and Gap facts.', { '--session': 'data', '--after-byte': 'value', '--follow': 'boolean' }, f => ({ agentSessionId: id(f, '--session'), ...numbers(f, { '--after-byte': 'afterByte' }), follow: f.booleans.has('--follow') }), 'Replay and live bytes use bounded base64 notifications, never reconstructed terminal text. Without --follow, the reader ends after replay. Ctrl-C cancels this reader, not the Agent Run.'), stream: true },
  command('message.pending.ls', '--session ID', 'Read every unsubmitted client-owned message with exact input identity and edit eligibility.', { '--session': 'data' }, f => ({ agentSessionId: id(f, '--session', true) })),
  command('message.pending.edit', '--session ID --pending-id ID --expected-text TEXT --text TEXT', 'A trusted user or device edits one never-submitted message without sending or changing its original target.', { '--session': 'data', '--pending-id': 'data', '--expected-text': 'data', '--text': 'data', ...OP }, f => ({ ...operation(f), agentSessionId: id(f, '--session', true), pendingId: id(f, '--pending-id', true), expectedText: value(f, '--expected-text', true), text: value(f, '--text', true) })),
  command('message.pending.send', '--session ID --pending-id ID', 'A trusted user or device explicitly submits only this original pending message; submitted input is not proof of completed work.', { '--session': 'data', '--pending-id': 'data', ...OP }, f => ({ ...operation(f), agentSessionId: id(f, '--session', true), pendingId: id(f, '--pending-id', true) })),
  command('agent.send', '(--to-session ID|--to-region ID|--to-tab ID) --text TEXT [--execution default|immediate] [message identity]', 'Queue and deliver one exact semantic Agent message.', { '--to-session': 'data', '--to-region': 'data', '--to-tab': 'data', '--text': 'data', '--execution': 'value', '--message-id': 'data', '--thread': 'data', '--correlation': 'data', '--reply-to': 'data', ...OP }, f => {
    const selected = one(f, ['--to-session', '--to-region', '--to-tab'], 'Agent send')
    const execution = value(f,'--execution')
    if (execution !== undefined && execution !== 'default' && execution !== 'immediate') invalid('--execution must be default or immediate.')
    return { ...operation(f), target: selected === '--to-session' ? targetSession(id(f, selected)) : selected === '--to-region' ? { kind: 'region', regionId: id(f, selected, true) } : { kind: 'tab', tabId: id(f, selected, true) }, text: value(f, '--text', true), ...(execution === undefined ? {} : { execution }), ...fields(f, { '--message-id': 'messageId', '--thread': 'threadId', '--correlation': 'correlationId', '--reply-to': 'replyTo' }) }
  }, AGENTMUX_AGENT_MESSAGING_GUIDANCE + ' A Tab must identify one distinct Agent Session. Delivery, consumption and completed work are separate facts. ' + SAVE_NOTICE),
  command('agent.discuss', '--agent EXECUTOR --text TEXT [--provider ID]', 'Start the original Discussion and deliver its first message as an authorized caller.', { '--agent': 'data', '--text': 'data', '--provider': 'data', ...OP }, f => ({ ...operation(f), executorId: id(f, '--agent'), text: value(f, '--text', true), ...fields(f, { '--provider': 'providerId' }) })),
  command('agent.handoff', '--to-session ID --task ID', 'Declare communication handoff; do not complete an external Task.', { '--to-session': 'data', '--task': 'data' }, f => ({ toAgentSessionId: id(f, '--to-session', true), taskId: id(f, '--task') })),
  ...(['interrupt', 'resume', 'stop'] as const).map(action => command(`agent.${action}`, `--session ID${action === 'resume' ? ' [--text TEXT]' : ''}`, `${action} one Agent through its original lifecycle owner.`, { '--session': 'data', ...(action === 'resume' ? { '--text': 'data' as const } : {}), ...OP }, f => ({ ...operation(f), target: targetSession(id(f, '--session')), ...fields(f, { '--text': 'text' }) }))),
  command('agent.role.ls', '[--workspace PATH]', 'Read original role bindings in an explicit or verified execution scope.', { '--workspace': 'data' }, f => fields(f, { '--workspace': 'workspacePath' })),
  command('agent.role.register', '--role ROLE [--provider ID]', 'Register the verified caller in its original role directory.', { '--role': 'data', '--provider': 'data' }, f => ({ role: id(f, '--role'), ...fields(f, { '--provider': 'providerId' }) })),
  command('agent.role.resolve', '--role ROLE [--workspace PATH]', 'Resolve a role through its original owner; unavailable is not unassigned.', { '--role': 'data', '--workspace': 'data' }, f => ({ role: id(f, '--role'), ...fields(f, { '--workspace': 'workspacePath' }) })),
  command('space.ls', '[--space ID] [--zone ID]', 'List actual Space/Zone/Tab/Region bindings globally.', { '--space': 'data', '--zone': 'data' }, f => ({ target: selector(f) })),
  command('space.inspect', '<selector>|--operation-id ID', 'Read exact presentation facts or retained spatial operation facts.', { ...SELECTOR, ...OP }, f => {
    const selected = selector(f)
    if (f.values.has('--operation-id') && Object.keys(selected).length) invalid('--operation-id cannot be combined with a spatial selector.')
    return { target: f.values.has('--operation-id') ? { operationId: id(f, '--operation-id') } : selected }
  }),
  command('space.rename', '--tab ID (--name TEXT|--clear)', 'Set or clear one exact Tab entity display override.', { '--tab': 'data', '--name': 'data', '--clear': 'boolean', ...OP }, f => ({ ...operation(f), tabId: id(f, '--tab', true), name: name(f) }), SAVE_NOTICE),
  command('space.mv', '--from-region ID --expect-session SID <destination>', 'Move a presentation while keeping Session, Run, Host and cwd.', { ...DESTINATION, '--from-region': 'data', '--expect-session': 'data', '--from-space': 'data', '--from-display-workspace': 'data', '--from-group': 'data' }, f => {
    const fromLocation = fields(f, { '--from-space': 'spaceId', '--from-display-workspace': 'displayWorkspaceId', '--from-group': 'groupId' })
    return { ...operation(f), fromRegionId: id(f, '--from-region', true), expectedAgentSessionId: id(f, '--expect-session', true), ...(Object.keys(fromLocation).length ? { fromLocation } : {}), destination: destination(f), focus: focus(f) }
  }, 'Source is exact even when the SID has several presentations. Other presentations and healthy Runs remain. ' + SAVE_NOTICE),
  command('space.swap', '--region ID --with ID', 'Swap two leaves of the same Tab entity across all its presentations.', { '--region': 'data', '--with': 'data', ...OP }, f => ({ ...operation(f), regionId: id(f, '--region', true), withRegionId: id(f, '--with', true) })),
  ...(['bind', 'unbind'] as const).map(action => command(`space.${action}`, '(--zone ID --space ID|--tab ID --display-workspace ID --group ID)', `${action} an exact resource relation or Tab occurrence.`, { ...SELECTOR, ...OP }, f => {
    if (f.values.has('--region')) invalid('Bindings target a Zone/Space pair or a Tab occurrence.')
    const tab = f.values.has('--tab')
    if (tab && (f.values.has('--zone') || f.values.has('--space')) || !tab && (f.values.has('--display-workspace') || f.values.has('--group'))) invalid('Do not combine resource relations and Tab display placements.')
    return { ...operation(f), binding: tab ? { kind: 'tab-group', tabId: id(f, '--tab', true), displayWorkspaceId: id(f, '--display-workspace', true), groupId: id(f, '--group', true) } : { kind: 'zone-space', zoneId: id(f, '--zone', true), spaceId: id(f, '--space', true) } }
  })),
  command('space.focus', '<selector> [--input preserve|target]', 'Navigate an exact spatial object with separate presentation and input facts.', { ...SELECTOR, '--input': 'value', ...OP }, f => ({ ...operation(f), target: { kind: 'space', ...selector(f) }, inputPolicy: value(f, '--input') ?? 'preserve' }), 'Default --input preserve keeps eligible conversation input. Explicit --input target requires an exact existing Tab or Region. Partial navigation, presentation and input facts remain separate; read app inspect for current client facts.'),
  command('space.promote', '--region ID', 'Move an existing Region into its own Tab.', { '--region': 'data', ...OP }, f => ({ ...operation(f), target: value(f, '--region', true) === 'self' ? { kind: 'self' } : { kind: 'region', regionId: id(f, '--region', true) } })),
  command('space.arrange', '--tab ID (--preset NAME|--balance|--active-first)', 'Arrange one existing Tab through the original layout owner.', { '--tab': 'data', '--preset': 'value', '--balance': 'boolean', '--active-first': 'boolean', ...OP }, f => {
    if (Number(f.values.has('--preset')) + Number(f.booleans.has('--balance')) + Number(f.booleans.has('--active-first')) !== 1) invalid('Arrange requires exactly one of --preset, --balance, --active-first.')
    const tab = id(f, '--tab')
    return { ...operation(f), target: tab === 'self' ? { kind: 'self' } : { kind: 'tab', tabId: tab }, mode: f.values.has('--preset') ? { kind: 'preset', preset: value(f, '--preset') } : { kind: f.booleans.has('--balance') ? 'balance' : 'active-first' } }
  }),
  command('file.open', '--path PATH --zone ID [--space ID] [--display-workspace ID --group ID] [--focus]', 'Open a Zone-relative file through its existing document owner.', { '--path': 'data', '--zone': 'data', '--space': 'data', '--display-workspace': 'data', '--group': 'data', '--focus': 'boolean', ...OP }, f => ({ ...operation(f), path: value(f, '--path', true), ...selector(f), focus: focus(f) }), SAVE_NOTICE),
  command('file.view', '--region ID [--mode source|diff|preview]', 'Read or change one FileRegion mode without forcing focus.', { '--region': 'data', '--mode': 'value', ...OP }, f => ({ regionId: id(f, '--region', true), ...fields(f, { '--mode': 'mode' }), ...(f.values.has('--mode') ? operation(f) : {}) })),
  command('terminal.open', `[--command TEXT] ${PLACEMENT_USAGE}`, 'Open a terminal at an exact destination.', { ...PLACEMENT, '--command': 'data' }, f => ({ ...operation(f), ...openPlacement(f), ...fields(f, { '--command': 'shellCommand' }) })),
  command('browser.open', `--url URL ${PLACEMENT_USAGE}`, 'Open a Browser at an exact destination.', { ...PLACEMENT, '--url': 'data' }, f => ({ ...operation(f), ...openPlacement(f), url: id(f, '--url') })),
  command('browser.targets', '[--workspace ID]', 'Discover original embedded and explicitly shared external Browser targets without selecting or focusing them.', { '--workspace': 'data' }, f => f.values.has('--workspace') ? { workspaceId: id(f, '--workspace') } : {}, 'Each target carries its source, readiness, document identity and actual capabilities/CDP methods. Pairing alone does not share a tab. Choose its exact id for browser run; disconnected or revoked targets require the original connection or another explicit share. Unshared tabs remain outside discovery.'),
  command('browser.run', '--browser ID [--operation-id ID] < program.js', 'Execute one page program read from stdin.', { '--browser': 'data', ...OP }, f => ({ ...operation(f), browserId: id(f, '--browser', true) })),
  command('browser.task.assets', '--browser ID', 'Read saved task assets and their original selected run.', { '--browser': 'data' }, f => ({ browserId: id(f, '--browser', true) })),
  command('browser.task.reliability', '--browser ID --asset ID --version N', 'Read retained outcomes for one exact immutable task version.', { '--browser': 'data', '--asset': 'data', '--version': 'value' }, f => {
    value(f, '--version', true)
    return { browserId: id(f, '--browser', true), assetId: id(f, '--asset'), ...numbers(f, { '--version': 'version' }) }
  }),
  command('browser.task.run', '--browser ID --asset ID --version N [--step] [--run ID] < parameters.json', 'Run an immutable task version with fresh stdin parameters.', { '--browser': 'data', '--asset': 'data', '--version': 'value', '--step': 'boolean', '--run': 'data' }, f => {
    value(f, '--version', true)
    return { browserId: id(f, '--browser', true), assetId: id(f, '--asset'), ...numbers(f, { '--version': 'version' }), ...(f.booleans.has('--step') ? { mode: 'step' } : {}), ...fields(f, { '--run': 'runId' }) }
  }, 'Only an existing immutable version runs. Fresh JSON object parameters are bounded to 64 KiB and never enter the saved asset or durable progress. This cannot approve a human checkpoint or reclaim human input ownership.'),
  command('browser.task.batch', '--browser ID --asset ID --version N [--batch ID] < batch.json', 'Run a bounded list of items through the original immutable task version.', { '--browser': 'data', '--asset': 'data', '--version': 'value', '--batch': 'data' }, f => {
    value(f, '--version', true)
    return { browserId: id(f, '--browser', true), assetId: id(f, '--asset'), ...numbers(f, { '--version': 'version' }), ...fields(f, { '--batch': 'batchId' }) }
  }, 'Fresh stdin JSON contains parameters and 1–16 items with unique ids and per-item parameters. Values never enter durable progress. Unknown results or human checkpoints stop the group; this cannot approve them. Original group limits are 256 operations and 120 seconds of execution.'),
  command('browser.task.batch-stop', '--browser ID --batch ID', 'Stop the original batch and its current run while retaining item results.', { '--browser': 'data', '--batch': 'data' }, f => ({ browserId: id(f, '--browser', true), batchId: id(f, '--batch') })),
  command('browser.task.stop', '--browser ID --run ID', 'Stop an exact task run while retaining its original progress cursor.', { '--browser': 'data', '--run': 'data' }, f => ({ browserId: id(f, '--browser', true), runId: id(f, '--run') })),
  command('browser.history', '[--browser ID]', 'Read retained Browser operation history.', { '--browser': 'data' }, f => fields(f, { '--browser': 'browserId' })),
  command('browser.inspect', '--operation-id ID', 'Inspect one exact retained Browser operation.', OP, f => ({ operationId: id(f, '--operation-id') })),
  command('browser.stop', '--operation-id ID', 'Stop one explicit Browser operation; this is separate from reader cancellation.', OP, f => ({ operationId: id(f, '--operation-id') })),
  { ...command('browser.follow', '--operation-id ID [--after-sequence N]', 'Follow retained operation progress and Gap facts.', { ...OP, '--after-sequence': 'value' }, f => ({ operationId: id(f, '--operation-id'), ...numbers(f, { '--after-sequence': 'afterSequence' }) })), stream: true },
  command('browser.replay', '--browser ID --operation-id ID [--preview|--step N|--run]', 'Replay the original operation with exact Browser identity.', { '--browser': 'data', ...OP, '--preview': 'boolean', '--run': 'boolean', '--step': 'value' }, f => {
    if (Number(f.booleans.has('--preview')) + Number(f.booleans.has('--run')) + Number(f.values.has('--step')) > 1) invalid('Choose one replay mode.')
    return { browserId: id(f, '--browser', true), operationId: id(f, '--operation-id'), mode: f.booleans.has('--preview') ? 'preview' : f.values.has('--step') ? 'step' : 'run', ...numbers(f, { '--step': 'step' }) }
  }),
  command('goal.ls', '[filters]', 'List original durable Goals with real field filters.', GOAL_FILTERS, filters),
  goal('inspect', '--goal ID', 'Inspect the original Goal identity and content.', {}, () => ({})),
  command('goal.create', '--title TEXT [--description TEXT] [--project ID] [--priority VALUE] [--status VALUE] [--session ID]', 'Create through the original Goal owner and record decision provenance.', { '--title': 'data', '--description': 'data', '--project': 'data', '--priority': 'value', '--status': 'value', '--session': 'data', '--risk': 'value', '--confirm': 'value', '--wiki-version': 'data', ...OP }, f => ({ ...operation(f), title: value(f, '--title', true), ...fields(f, { '--description': 'description', '--project': 'projectId', '--priority': 'priority', '--status': 'status', '--risk': 'risk', '--confirm': 'confirmation', '--wiki-version': 'wikiVersion' }), ...(f.values.has('--session') ? { sessionIds: [id(f, '--session')] } : {}) }), SAVE_NOTICE),
  goal('update', '--goal ID [--title TEXT|--description TEXT|--project ID|--priority VALUE|--status VALUE|--session ID|--alignment JSON|--grounding JSON]', 'Update original Goal content; proposal validation belongs to its owner.', { '--title': 'data', '--description': 'data', '--project': 'data', '--priority': 'value', '--status': 'value', '--session': 'data', '--alignment': 'data', '--grounding': 'data' }, f => {
    const patch = fields(f, { '--title': 'title', '--description': 'description', '--project': 'projectId', '--priority': 'priority', '--status': 'status' })
    if (f.values.has('--session')) patch.sessionIds = [id(f, '--session')]
    for (const key of ['alignment', 'grounding']) if (f.values.has(`--${key}`)) {
      try { patch[key] = JSON.parse(value(f, `--${key}`, true)!) } catch { invalid(`--${key} requires valid JSON.`) }
    }
    if (!Object.keys(patch).length) invalid('Goal update requires at least one patch option.')
    return { patch }
  }, true),
  goal('delete', '--goal ID --confirm delete', 'Delete one explicitly confirmed Goal.', { '--confirm': 'value' }, f => ({ confirmation: value(f, '--confirm', true) }), true),
  goal('assign', '--goal ID [--project ID] [--executor ID] [--start]', 'Assign an original Goal; optional start remains an explicit side effect.', { '--project': 'data', '--executor': 'data', '--start': 'boolean' }, f => ({ ...fields(f, { '--project': 'projectId', '--executor': 'assigneeExecutorId' }), start: f.booleans.has('--start') }), true),
  goal('start', '--goal ID [--session ID]', 'Start work through the existing Goal and Session owners.', { '--session': 'data' }, f => fields(f, { '--session': 'sessionId' }), true),
  goal('handoff', '--goal ID [--executor ID] [--session ID]', 'Handoff the original Goal without changing its durable identity.', { '--executor': 'data', '--session': 'data' }, f => fields(f, { '--executor': 'assigneeExecutorId', '--session': 'sessionId' }), true),
  goal('focus', '--goal ID', 'Navigate a Goal while preserving eligible conversation input.', {}, () => ({ input: 'preserve' }), true),
  goal('link-session', '--goal ID --session ID', 'Link an actual Session to the original Goal.', { '--session': 'data' }, f => ({ sessionId: id(f, '--session') }), true),
  goal('link-project', '--goal ID --project ID', 'Link a real Project to the original Goal.', { '--project': 'data' }, f => ({ projectId: id(f, '--project') }), true),
  goal('decisions', '--goal ID', 'Read original Goal decision records.', {}, () => ({})),
  command('goal.activity', '[--goal ID] [filters]', 'Read original Goal activity, never Runtime logs or a cross-domain surrogate.', GOAL_FILTERS, filters),
  command('message.inbox.check', '[--limit N]', 'Read a bounded delivery batch for the verified caller.', { '--limit': 'value' }, f => numbers(f, { '--limit': 'limit' })),
  command('message.inbox.ack', '--generation N --reader-run ID', 'Acknowledge the exact reader Run and generation.', { '--generation': 'value', '--reader-run': 'data' }, f => ({ generation: Number(value(f, '--generation', true)), readerRun: { runId: id(f, '--reader-run') } })),
  ...(['open', 'inspect'] as const).map(action => command(`message.dispatch.${action}`, '--source-message ID', `${action} the original durable communication supervision.`, { '--source-message': 'data' }, f => ({ sourceMessageId: id(f, '--source-message') }))),
  command('message.dispatch.report', '--source-message ID --reply-message ID --kind KIND', 'Record an actual reply under the original participant and thread rules.', { '--source-message': 'data', '--reply-message': 'data', '--kind': 'value' }, f => ({ sourceMessageId: id(f, '--source-message'), replyMessageId: id(f, '--reply-message'), kind: value(f, '--kind', true) })),
  empty('app.inspect', 'Inspect actual Desktop selection, presentation and input facts.'),
  command('app.snapshot', '[--include SOURCE,...] [filters]', 'Observe Project/Workspace/Topic/Mote/Space/Zone/Executor/Session/Goal globally.', { ...FILTERS, '--include': 'data' }, f => ({ ...filters(f), ...(f.values.has('--include') ? { include: value(f, '--include', true)!.split(',') } : {}) }), 'Known sources remain when another source is unavailable. Topic/SOUL/Wiki come from real filesystem owners; unknown is explicit. No current Space or cwd is used as a global filter.'),
  command('app.focus', '--surface space|focus|goals|survey [--input preserve|target]', 'Select a main Surface without silently stealing conversation input.', { '--surface': 'value', '--input': 'value', ...OP }, f => ({ ...operation(f), target: { kind: 'surface', surface: value(f, '--surface', true) }, inputPolicy: value(f, '--input') ?? 'preserve' })),
  { ...empty('mote.playbook.pmo', 'Read the PMO work manual using the actual public commands.'), local: true },
  settings('settings.inspect', '[target]', 'Read supported host settings.'),
  settings('settings.set', '<key> <value>', 'Set one supported scalar value.', 2),
  ...(['executors', 'prompts'] as const).flatMap(resource => [
    settings(`settings.${resource}.ls`, '', `List configured ${resource}, not active Sessions.`),
    settings(`settings.${resource}.inspect`, resource === 'prompts' ? '<id>|--keyword <code>' : '<id>',
      resource === 'prompts' ? 'Read an exact saved Prompt by ID or its explicit keyword; quick reply meaning is its saved body.' : 'Inspect an exact saved resource.', 1),
    settings(`settings.${resource}.create`, '<id> --input <file|->', 'Create a complete saved resource.', 1),
    settings(`settings.${resource}.update`, '<id> --input <file|->', 'Update using {changes, expected?}.', 1),
    settings(`settings.${resource}.delete`, '<id> [--input <file|->]', 'Delete using optional complete expected fields.', 1)
  ]),
  settings('settings.executors.refresh', '<id> --host <id>', 'Refresh one Executor availability observation.', 1),
  settings('settings.hosts.ls', '', 'List actual configured Hosts.'),
  settings('settings.hosts.test', '<id>|--input <file|->', 'Test an exact saved Host or a complete draft.', 1),
  settings('settings.workspaces.register', '--input <file|->', 'Register an existing directory; this does not run Git, focus or start an Agent.'),
  settings('settings.browser-links.ls', '', 'List remembered system-application link choices.'),
  settings('settings.browser-links.forget', '<scheme>|--input <file|->', 'Forget one exact remembered scheme decision.', 1),
  command('system.storage', '--host HOST --run RUN', 'Read original Runtime storage failure, watermarks and effective capacity for one exact Run.', { '--host': 'data', '--run': 'data' }, f => ({ hostId: id(f, '--host'), runId: id(f, '--run') })),
  command('system.doctor', '[--workspace PATH]', 'Read original Runtime and Provider diagnostics through their owners.', { '--workspace': 'data' }, f => fields(f, { '--workspace': 'workspacePath' })),
  { ...command('system.endpoint', '[--stdio]', 'Discover the selected endpoint without connecting, or relay strict RPC stdio.', { '--stdio': 'boolean' }, f => ({ stdio: f.booleans.has('--stdio') })), local: true },
  empty('system.crash-log.inspect', 'Read retained original crash-log facts.'),
  empty('system.crash-log.reveal', 'Reveal the retained crash-log through the client owner.'),
  empty('system.metrics.get', 'Read per-source bounded metrics with availability and observation times.'),
  { ...empty('system.metrics.watch', 'Watch metrics; a slow reader ends without an unbounded frame queue.'), stream: true },
  toolkit('ls', '', 'List original saved Toolkit resources.', 0),
  toolkit('inspect', '<id>', 'Inspect current definition, execution and result facts.'),
  toolkit('create', '<id> --input <file|->', 'Create a complete tool using its original owner.'),
  toolkit('update', '<id> --input <file|->', 'Update {changes,expected?} without running the tool.'),
  toolkit('delete', '<id> [--input <file|->]', 'Delete a saved tool with original expected-field checks.'),
  toolkit('action', '<id> <action-id> --input <file|->', 'Run a saved action against its exact original result/admission baseline.', 2),
  toolkit('script', '<id>', 'Read the original tool script; do not execute it.'),
  toolkit('run', '<id> [--input <file|->]', 'Admit one execution; service captures omitted CAS baseline once.'),
  toolkit('stop', '<id> [--input <file|->]', 'Stop the exact admitted execution or observation.'),
  toolkit('watch', '<id>', 'Follow one bounded tool result; closing the reader does not stop its execution.')
]

export function agentMuxCliArguments(argv: readonly string[]): { args: string[]; endpoint?: string } {
  const args = [...argv]
  let endpoint: string | undefined
  while (args[0] === '--endpoint' || args[0]?.startsWith('--endpoint=')) {
    if (endpoint !== undefined) invalid('Duplicate option: --endpoint')
    const option = args.shift()!
    endpoint = option === '--endpoint' ? args.shift() : option.slice('--endpoint='.length)
    if (!endpoint?.length) invalid('--endpoint requires a descriptor.')
  }
  return { args, ...(endpoint === undefined ? {} : { endpoint }) }
}
export function agentMuxCliMatch(args: readonly string[]): { command: AgentMuxCliCommand; tail: string[] } | null {
  let selected: AgentMuxCliCommand | undefined
  let length = 0
  for (const entry of AGENTMUX_CLI_COMMANDS) {
    const path = entry.method.split('.')
    if (path.length > length && path.every((part, index) => args[index] === part)) {
      selected = entry
      length = path.length
    }
  }
  return selected ? { command: selected, tail: args.slice(length) } : null
}
export function agentMuxCliRequestsHelp(command: AgentMuxCliCommand, args: readonly string[]): boolean {
  // Help is a syntax-only invocation. A data-bearing request cannot hide extra
  // arguments behind a later --help; positional IDs and carrier paths stay literal.
  return args.length === 1 && command.positionalData !== 1 &&
    (args[0] === '--help' || args[0] === '-h')
}
export async function parseAgentMuxCliInvocation(argv: readonly string[]): Promise<AgentMuxCliInvocation> {
  const { args, endpoint } = agentMuxCliArguments(argv)
  const match = agentMuxCliMatch(args)
  if (!match) invalid('Unknown command. Run agentmux --help.')
  return { command: match!.command, params: await match!.command.parse(match!.tail), ...(endpoint === undefined ? {} : { endpoint }) }
}
