import { readControlJsonInput } from './cli-json-input.js'
import { parseSessionHistoryResourceParams } from './session-history-resource.js'
import { randomUUID } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { parseAgentNativeSessionConfirmation } from './agent-native-session-confirmation.js'
import { parseAgentForkSource } from './agent-fork.js'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE } from './agent-messaging-guidance.js'
import { parseSettingsCommand } from './settings-cli.js'
import { parseFileReadCommand } from './agentmux-cli-files.js'

import { AGENTMUX_SCHEDULE_CLI_COMMANDS } from './schedule-cli.js'
import { parseFileListParams, parseFileUploadIdentity, parseFileUploadParams } from './public-rpc-files.js'
import { parseToolkitCommand } from './toolkit-cli.js'
import { isSplitDirection, SPLIT_FLAG_DIRECTIONS } from './split-direction-ssot.js'
import type { AgentMuxRpcParams } from './public-rpc.js'

type FlagKind = 'boolean' | 'value' | 'data'
type FlagSpec = Readonly<Record<string, FlagKind>>
type Flags = { values: Map<string, string>; booleans: Set<string> }
export interface AgentMuxCliCommand {
  method: string
  rpcMethod?: string
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
function jsonValue(value: string, label: string): unknown {
  try { return JSON.parse(value) } catch { return invalid(`${label} requires valid JSON.`) }
}

const GOAL_FILTERS = { '--project': 'data', '--session': 'data', '--goal': 'data', '--executor': 'data', '--status': 'value', '--since': 'value', '--limit': 'value' } as const
const FILTER_FIELDS = { '--project': 'projectId', '--workspace': 'workspaceId', '--topic': 'topicId', '--session': 'agentSessionId', '--goal': 'goalId', '--executor': 'executorId', '--status': 'status' }
const selector = (f: Flags) => fields(f, { '--space': 'spaceId', '--zone': 'zoneId', '--tab': 'tabId', '--region': 'regionId', '--display-workspace': 'displayWorkspaceId', '--group': 'groupId' })
const filters = (f: Flags) => ({ ...fields(f, FILTER_FIELDS), ...numbers(f, { '--since': 'since', '--limit': 'limit' }) })
const destination = (f: Flags) => {
  const split = value(f, '--split')
  if (split !== undefined && !isSplitDirection(split)) invalid('--split requires left, right, up or down.')
  return { ...selector(f), ...(f.booleans.has('--new-tab') ? { newTab: true } : {}), ...(split === undefined ? {} : { split }) }
}
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
    ...(action === 'install' ? { rpcMethod: 'toolkit.create' } : {}),
    ...(action === 'watch' ? { stream: true } : {}), details: SAVE_NOTICE,
    parse: async args => (await parseToolkitCommand([action, ...args])).params }
}
function goal(method: string, usage: string, summary: string, specs: FlagSpec, build: (f: Flags) => Record<string, unknown>, write = false): AgentMuxCliCommand {
  return command(`goal.${method}`, usage, summary, { '--goal': 'data', ...specs, ...(write ? OP : {}) }, f => ({ goalId: id(f, '--goal'), ...build(f), ...(write ? operation(f) : {}) }), write ? SAVE_NOTICE : undefined)
}

/** Actual executable registration. Help, skill and playbooks enumerate this same source. */
export const AGENTMUX_CLI_COMMANDS: readonly AgentMuxCliCommand[] = [
  ...Object.values(AGENTMUX_SCHEDULE_CLI_COMMANDS),
  empty('notebook.ls', 'Read the durable Notebook and Note directory without opening an App or a page.'),
  command('notebook.inspect', '(--notebook ID|--note ID|--operation-id ID)', 'Read an exact Notebook, Note source/history or original knowledge operation.',
    { '--notebook':'data','--note':'data',...OP }, f => { const selected=one(f,['--notebook','--note','--operation-id'],'Inspect');return {[selected==='--notebook'?'notebookId':selected==='--note'?'noteId':'operationId']:id(f,selected)} }),
  command('notebook.apply', '--revision N --operation-id ID --change-json JSON', 'Apply one typed knowledge change, including archive/restore and Notebook deletion; preserve original Note bodies and reconcile the same operation after a lost response.',
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
  command('topic.knowledge.ls', '--topic ID [--limit N]', 'Discover saved entries and original document names in one exact ordinary Topic; documents retain bounded file.read targets.', { '--topic': 'data', '--limit': 'value' }, f => ({ topicId: id(f, '--topic', true), ...numbers(f, { '--limit': 'limit' }) })),
  command('topic.knowledge.search', '--query TEXT [--topic ID] [--limit N]', 'Search saved entries and original document names and text; documents are original files, not classified knowledge. Read unavailable for omitted or partial work.', { '--topic': 'data', '--query': 'data', '--limit': 'value' }, f => ({ query: value(f, '--query', true)!, ...fields(f, { '--topic': 'topicId' }), ...numbers(f, { '--limit': 'limit' }) })),
  command('topic.knowledge.read', '--topic ID --entry UUID', 'Read one exact knowledge entry, its sources and content revision.', { '--topic': 'data', '--entry': 'data' }, f => ({ topicId: id(f, '--topic', true), entryId: id(f, '--entry', true) })),
  command('topic.knowledge.write', '--input FILE|-', 'Save a typed knowledge entry at its exact expectedRevision without starting or messaging an Agent.', { '--input': 'data' }, async f => await readControlJsonInput(value(f, '--input', true)!, 'Topic knowledge') as Record<string, unknown>, 'The JSON carries exact topicId/entryId, title, content, form, certainty, sources and expectedRevision (null to create). Read the original revision before editing. ' + SAVE_NOTICE),
  empty('topic.migrate.preview', 'Preview existing local Topic identities and exact category changes without writing.'),
  command('topic.migrate.apply', '--revision NUMBER', 'Apply the inspected local Topic organization at its exact spatial revision.', { '--revision': 'value' }, f => ({ expectedRevision: Number(value(f, '--revision', true)) }), 'Read topic migrate preview first. The original owner preserves content and writes a backup before the spatial change. ' + SAVE_NOTICE),
  empty('space.state', 'Read the Core durable spatial graph and revision without a graphical frontend.'),
  command('name.confirm', '--operation-id ID', 'Confirm the current name document on disk without replaying a prior name edit.',
    { '--operation-id': 'value' }, f => ({ operationId: value(f, '--operation-id', true)! })),
  command('name.history', '[--kind KIND --id ID] [--after ID] [--limit N]', 'Read durable name records; use nextCursor with --after for the next page.',
    { '--kind': 'data', '--id': 'data', '--after': 'data', '--limit': 'value' }, f => {
      if (f.values.has('--kind') !== f.values.has('--id')) invalid('Name history target requires both --kind and --id.')
      return { ...(f.values.has('--kind') ? { target: { kind: id(f, '--kind'), id: id(f, '--id') } } : {}),
        ...(f.values.has('--after') ? { afterId: id(f, '--after') } : {}), ...numbers(f, { '--limit': 'limit' }) }
    }),
  command('space.commit', '--revision N [--removed-project-groups FILE] [--allow-entity-removal] < graph.json', 'Commit a spatial graph from JSON stdin using an exact revision; stale writes are refused.',
    {'--revision':'value','--removed-project-groups':'data','--allow-entity-removal':'boolean'}, async f => {
      const expectedRevision = Number(value(f,'--revision',true))
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalid('Revision must be a nonnegative integer.')
      const removalFile = value(f, '--removed-project-groups')
      if (removalFile === '-') invalid('Project group removal IDs require a JSON file; stdin supplies the spatial graph.')
      return {expectedRevision,...(f.booleans.has('--allow-entity-removal') ? {allowEntityRemoval:true} : {}),
        ...(removalFile === undefined ? {} : {removedProjectGroupIds:await readControlJsonInput(removalFile, 'Project group removal IDs')})}
    }, 'To dissolve groups, provide a JSON array of exact group IDs in --removed-project-groups FILE and omit only those groups from graph.json. Original projects and execution remain unchanged. ' + SAVE_NOTICE),
  command('space.resolve', '--tab ID --region ID --direction left|right|up|down', 'Resolve relative positions from the original durable split tree.',
    {'--tab':'data','--region':'data','--direction':'value'}, f => ({tabId:id(f,'--tab'),regionId:id(f,'--region'),direction:value(f,'--direction',true)})),
  empty('whoami', 'Read your verified Session, Run, presentation and available capabilities.'),
  empty('device.ls', 'Read the original Host devices and mobile connection state.'),
  empty('device.link', 'Read the complete connection offer URL from the local Host.'),
  command('device.hello', '--name NAME', 'Name this authenticated encrypted device.',
    { '--name': 'data' }, f => ({ name: value(f, '--name', true)! } satisfies AgentMuxRpcParams<'device.hello'>)),
  command('device.revoke', '--device ID', 'Revoke the exact device from the local Host.',
    { '--device': 'data' }, f => ({ deviceId: id(f, '--device') } satisfies AgentMuxRpcParams<'device.revoke'>)),
  command('agent.ls', '[--session ID] [--executor ID] [--status VALUE] [--since N] [--limit N]', 'List actual Core Agent Sessions with native turn failures and unavailable item facts.', { '--session': 'data', '--executor': 'data', '--status': 'value', '--since': 'value', '--limit': 'value' }, filters),
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
  command('agent.inspect', '(--session ID|--run ID|--provider-native ID --provider ID|--acp-native ID --adapter ID)', 'Inspect the service routeHostId, original Core identity and Desktop display facts separately.',
    { '--session': 'data', '--run': 'data', '--provider-native': 'data', '--provider': 'data', '--acp-native': 'data', '--adapter': 'data' }, f => ({ target: inspectTarget(f) }),
    'status.session.semanticStatus.failure carries code, message, recovery, nativeTurnId and available nativeCode/httpStatusCode. Failed turns retain their original healthy Run; observation errors are reported separately.'),
  command('agent.history', '--host ID --session ID --source captured|native [--limit N] [--cursor CURSOR] [--max-bytes N]',
    'Read exact retained Session history without operating its Run.',
    { '--host': 'data', '--session': 'data', '--source': 'value', '--limit': 'value', '--cursor': 'data', '--max-bytes': 'value' }, f => {
      const source = value(f, '--source', true)
      if (source !== 'captured' && source !== 'native') invalid('--source requires captured or native.')
      return { hostId: id(f, '--host'), agentSessionId: id(f, '--session', true), source,
        ...numbers(f, { '--limit': 'limit', '--max-bytes': 'maxBytes' }), ...fields(f, { '--cursor': 'cursor' }) }
    }, 'Sources are explicit: missing native identity does not erase captured work. Follow nextCursor with the same Host/Session/source. A fragment is exact JSON UTF-8 bytes in base64; concatenate contiguous offsets and verify its SHA-256 before parsing. Host restart or source change requires reading the first page again. Reading never restores, attaches, sends or stops a Run.'),
  command('agent.history.resource', '--input FILE|-', 'Read one exact recorded image at its original Host without operating a Run.', { '--input': 'data' },
    async f => parseSessionHistoryResourceParams(await readControlJsonInput(value(f, '--input', true)!, 'Recorded image')) as unknown as Record<string, unknown>,
    'JSON requires hostId, agentSessionId, source {providerId,nativeSessionId}, recordId, partIndex and expectedReference; preserve turnId when recorded. Locate these facts with agent.history --source native. maxBytes can only reduce the fixed 16 MiB cap. The Host rereads the exact original record and image part; expectedReference grants no arbitrary path access. File and raster data references may yield MIME/base64 bytes; opaque/HTTP or unavailable images retain their reference and readable reason. No network fetch or Run operation occurs.'),
  command('agent.native.confirm', '--input FILE|-', 'Explicitly adopt this exact Run’s witnessed current native conversation; inspect the Session first.',
    { '--input': 'data' }, async f => ({ ...parseAgentNativeSessionConfirmation(await readControlJsonInput(value(f, '--input', true)!, 'Native confirmation')) }),
    'JSON requires agentSessionId, expectedRun, expectedNativeHandle, candidateNativeHandle, expectedObservationAt and operationId. Native locators and observation time come from agent.inspect. No Run is started or restarted; repeat the same operationId to reconcile its durable receipt.'),
  command('agent.context', '--host ID --session ID [--cursor TOKEN] [--limit N]', 'Read all available original context sources, complete entries and diagnostics without controlling the Agent.',
    { '--host': 'data', '--session': 'data', '--cursor': 'data', '--limit': 'value' }, f => ({ hostId: id(f, '--host', true), agentSessionId: id(f, '--session', true), ...fields(f, { '--cursor': 'cursor' }), ...numbers(f, { '--limit': 'limit' }) }),
    'Both saved Core work and native conversation are included automatically. Follow nextCursor with the same exact Host and Session; limit bounds entries per source, never text length. Unavailable sources are reported alongside readable material. local means this Core Host, including on a remote machine. Read-only requests and cancellation never stop the original Run.'),
  command('agent.open', '(--executor ID [--execution-workspace ID]|--session ID|--fork-from ID --fork-source FILE|-) <destination> [--prompt TEXT] [--focus] [--operation-id ID]', 'Open or natively fork an Agent at an explicit Space/Zone/Tab/Region; default is background.',
    { ...DESTINATION, '--executor': 'data', '--execution-workspace': 'data', '--session': 'data', '--fork-from': 'data', '--fork-source': 'data', '--prompt': 'data', '--new-zone': 'boolean', '--worktree': 'boolean', '--path': 'data', '--branch': 'data', '--new-branch': 'data', '--directory': 'data', '--project': 'data', '--source-workspace': 'data' }, async f => {
      const selected = one(f, ['--executor', '--session', '--fork-from'], 'Agent open')
      if (f.values.has('--execution-workspace') && (selected !== '--executor' || f.booleans.has('--new-zone'))) invalid('--execution-workspace requires --executor and an existing display destination, without --new-zone.')
      const resourceOptions = ['--path', '--branch', '--new-branch', '--directory', '--project', '--source-workspace'].filter(flag => f.values.has(flag))
      const dest = destination(f)
      if (selected === '--session' && (f.values.has('--prompt') || f.booleans.has('--new-zone'))) invalid('--session cannot supply an initial prompt or create a Zone.')
      if (selected !== '--fork-from' && f.values.has('--fork-source')) invalid('--fork-source requires --fork-from.')
      if (selected === '--fork-from' && f.booleans.has('--new-zone')) invalid('Fork retains the source execution directory; choose an existing display destination.')
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
      const fork = selected === '--fork-from' ? parseAgentForkSource(await readControlJsonInput(value(f, '--fork-source', true)!, 'Fork source')) : undefined
      if (fork && fork.agentSessionId !== id(f, '--fork-from', true)) invalid('--fork-from must match the exact Session in --fork-source.')
      return { ...operation(f), content: fork ? { kind: 'fork-agent', source: fork, ...fields(f, { '--prompt': 'prompt' }) } : selected === '--executor'
        ? { kind: 'new-agent', executorId: id(f, selected), ...fields(f, { '--prompt': 'prompt', '--execution-workspace': 'executionWorkspaceId' }) }
        : { kind: 'agent-session', agentSessionId: id(f, selected, true) }, destination: dest, focus: focus(f) }
    }, `Use --zone ZONE --new-tab for an existing Zone. For a new Agent, --execution-workspace WORKSPACE chooses the exact saved execution Host and directory independently of the display destination, including --region REGION --split down on the local screen. It requires --executor and cannot be combined with --new-zone. For current native fork, inspect the source first: --fork-source JSON carries agentSessionId, expectedRun and expectedNativeHandle from agent.inspect. --fork-from names that exact Session. The Provider must support current-session native fork; a new Session and Region are created with a new amux identity reminder. The source Host/cwd are retained. Repeat --operation-id to read the original outcome; never resend uncertain input. New resources require --project PROJECT --space SPACE --new-zone, then --worktree --path PATH (--branch BRANCH|--new-branch BRANCH) or --directory PATH. --source-workspace WORKSPACE resolves an explicit source within the Project when necessary. Project is an execution resource; its Host and directory determine execution. Space is a presentation and cannot choose or change an existing Session Host or cwd. No existing Tab anchor is required. ${SAVE_NOTICE}`),
  command('agent.rename', '--session ID --name-revision N (--name TEXT|--clear)', 'Edit the exact Session display name at its observed revision.', { '--session': 'data', '--name': 'data', '--clear': 'boolean', '--name-revision': 'value', ...OP }, f => ({ ...operation(f), agentSessionId: id(f, '--session', true), name: name(f), expectedNameRevision: Number(value(f, '--name-revision', true)) }), SAVE_NOTICE),
  command('agent.view', '--session ID [--mode terminal|activity]', 'Read or change all presentations of one exact SID without taking focus.', { '--session': 'data', '--mode': 'value', ...OP }, f => ({ agentSessionId: id(f, '--session', true), ...fields(f, { '--mode': 'mode' }), ...(f.values.has('--mode') ? operation(f) : {}) }), 'Without --mode this is read-only. A known durable Agent projection remains usable while Core facts are unknown; no healthy Run is stopped.'),
  { ...command('agent.output', '--session ID [--after-byte N] [--follow]', 'Read replay or follow ordered raw output bytes, with cursor and Gap facts.', { '--session': 'data', '--after-byte': 'value', '--follow': 'boolean' }, f => ({ agentSessionId: id(f, '--session'), ...numbers(f, { '--after-byte': 'afterByte' }), follow: f.booleans.has('--follow') }), 'Replay and live bytes use bounded base64 notifications, never reconstructed terminal text. Without --follow, the reader ends after replay. Ctrl-C cancels this reader, not the Agent Run.'), stream: true },
  command('message.delivery.inspect', '--logid ID [--host-id HOST]', 'Read the immutable failure attempt for this exact log ID.', { '--logid': 'data', '--host-id': 'data' }, f => ({ logId: id(f, '--logid'), ...fields(f, { '--host-id': 'hostId' }) }), 'Input operation, diagnostic attempt and RPC IDs are distinct. The original record retains its cause and confirmation facts; missing or unavailable is not proof of no Input.'),
  command('message.pending.ls', '--session ID', 'Read active and retained archived messages with exact input identity, confirmed delivery facts and edit eligibility.', { '--session': 'data' }, f => ({ agentSessionId: id(f, '--session', true) })),
  command('message.pending.edit', '--session ID --pending-id ID --expected-text TEXT --text TEXT', 'A trusted user or device edits one never-submitted message without sending or changing its original target.', { '--session': 'data', '--pending-id': 'data', '--expected-text': 'data', '--text': 'data', ...OP }, f => ({ ...operation(f), agentSessionId: id(f, '--session', true), pendingId: id(f, '--pending-id', true), expectedText: value(f, '--expected-text', true), text: value(f, '--text', true) })),
  command('message.pending.send', '--session ID --pending-id ID', 'A trusted user or device explicitly submits only this original pending message; submitted input is not proof of completed work.', { '--session': 'data', '--pending-id': 'data', ...OP }, f => ({ ...operation(f), agentSessionId: id(f, '--session', true), pendingId: id(f, '--pending-id', true) })),
  command('message.pending.archive', '--session ID --pending-id ID --expected-text TEXT', 'Archive this exact original pending intent without recalling Provider input or discarding its delivery facts.', { '--session': 'data', '--pending-id': 'data', '--expected-text': 'data', ...OP }, f => ({ ...operation(f), agentSessionId: id(f, '--session', true), pendingId: id(f, '--pending-id', true), expectedText: value(f, '--expected-text', true) })),
  command('message.pending.restore', '--session ID --pending-id ID --expected-text TEXT', 'Restore the original archived message to the Outbox, waiting for explicit Send; never replay it.', { '--session': 'data', '--pending-id': 'data', '--expected-text': 'data', ...OP }, f => ({ ...operation(f), agentSessionId: id(f, '--session', true), pendingId: id(f, '--pending-id', true), expectedText: value(f, '--expected-text', true) })),
  command('agent.question.reply', '--input FILE|-', 'Answer exact native asynchronous questions through ordinary user input.', { '--input': 'data' },
    async f => ({ ...await readControlJsonInput(value(f, '--input', true)!, 'Question reply') as Record<string, unknown>, sourceChannel: 'cli' }),
    'JSON carries agentSessionId, source, turnId, recordId, answers [{questionId,answer}], operationId and the original expectedRun/afterSubmissionId condition. Read agent history first. Submitted input is not proof of an observed native answer; no Agent message envelope or Hook confirmation is created.'),
  command('agent.send', '(--to-session ID|--to-region ID|--to-tab ID) --text TEXT [--execution default|immediate] [message identity]', 'Queue and deliver one exact semantic Agent message.', { '--to-session': 'data', '--to-region': 'data', '--to-tab': 'data', '--text': 'data', '--execution': 'value', '--message-id': 'data', '--thread': 'data', '--correlation': 'data', '--reply-to': 'data', ...OP }, f => {
    const selected = one(f, ['--to-session', '--to-region', '--to-tab'], 'Agent send')
    const execution = value(f,'--execution')
    if (execution !== undefined && execution !== 'default' && execution !== 'immediate') invalid('--execution must be default or immediate.')
    return { ...operation(f), sourceChannel: 'cli', target: selected === '--to-session' ? targetSession(id(f, selected)) : selected === '--to-region' ? { kind: 'region', regionId: id(f, selected, true) } : { kind: 'tab', tabId: id(f, selected, true) }, text: value(f, '--text', true), ...(execution === undefined ? {} : { execution }), ...fields(f, { '--message-id': 'messageId', '--thread': 'threadId', '--correlation': 'correlationId', '--reply-to': 'replyTo' }) }
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
  command('space.rename', '--tab ID --name-revision N (--name TEXT|--clear)', 'Edit one exact Tab name at its observed revision.', { '--tab': 'data', '--name': 'data', '--clear': 'boolean', '--name-revision': 'value', ...OP }, f => ({ ...operation(f), tabId: id(f, '--tab', true), name: name(f), expectedNameRevision: Number(value(f, '--name-revision', true)) }), SAVE_NOTICE),
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
  command('file.open', '--path PATH --zone ID [--space ID] [--display-workspace ID --group ID] [--tab ID --region ID --split left|right|up|down] [--focus]', 'Open a Zone-relative file in a new Tab or beside an exact anchor Region through its existing document owner.', { '--path': 'data', ...SELECTOR, '--split': 'value', '--focus': 'boolean', ...OP }, f => {
    const regionPlacement = ['--tab', '--region', '--split'].some(flag => f.values.has(flag))
    if (regionPlacement && !['--tab', '--region', '--split', '--display-workspace', '--group'].every(flag => f.values.has(flag))) invalid('File Region placement requires --tab, --region, --split, --display-workspace and --group together.')
    const split = value(f, '--split')
    if (split !== undefined && !isSplitDirection(split)) invalid('--split must be left, right, up or down.')
    return { ...operation(f), path: value(f, '--path', true), ...selector(f), ...(split === undefined ? {} : { split }), focus: focus(f) }
  }, 'Without --tab/--region/--split, open in a new Tab. A Region destination requires the exact existing Tab, anchor Region, Display Workspace and Group together. The returned placement names the actual File Region, which may differ from the anchor. --focus controls navigation independently; its default is background. ' + SAVE_NOTICE),
  command('file.read', '--zone ID --path PATH --host ID --workspace ID --workspace-path PATH [--space ID] [--max-bytes N]', 'Read the original Zone-relative file with its exact resource and saved revision. An optional byte cap refuses oversized bodies before reading them.',
    { '--zone': 'data', '--path': 'data', '--host': 'data', '--workspace': 'data', '--workspace-path': 'data', '--space': 'data', '--max-bytes': 'value' },
    f => parseFileReadCommand({ zoneId: value(f, '--zone', true)!, path: value(f, '--path', true)!, hostId: value(f, '--host', true)!, workspaceId: value(f, '--workspace', true)!, workspacePath: value(f, '--workspace-path', true)!,
      ...(f.values.has('--space') ? { spaceId: value(f, '--space', true)! } : {}), ...numbers(f, { '--max-bytes': 'maxBytes' }) }) as unknown as Record<string, unknown>),
  command('file.write', '--zone ID --path PATH --resource JSON --expected-revision REV [--space ID] < content', 'Save the exact existing file pinned by its original read resource and revision.',
    { '--zone': 'data', '--path': 'data', '--resource': 'data', '--space': 'data', '--expected-revision': 'data' },
    f => ({ zoneId: value(f, '--zone', true)!, path: value(f, '--path', true)!, expectedResource: JSON.parse(value(f, '--resource', true)!),
      ...(f.values.has('--space') ? { spaceId: value(f, '--space', true)! } : {}), expectedRevision: value(f, '--expected-revision', true)! }),
    'Content is read verbatim from stdin. Read the original file first and pass its complete resource JSON (including zonePath and mapped path) plus sha256 revision. Changed Zone mapping is refused. Written, conflict, error and unknown remain distinct; reconcile unknown by reading the same file, never automatically resend.'),
  command('file.upload', '--input FILE|-', 'Import one bounded image or ordinary file to its exact original Host and Session without sending input.', { '--input': 'data' },
    async f => parseFileUploadParams(await readControlJsonInput(value(f, '--input', true)!, 'File upload')) as unknown as Record<string, unknown>,
    'JSON carries hostId, exact agentSessionId, expectedRun:{runId}, operationId, name, mimeType, byteLength, sha256 revision and dataBase64. Maximum 4 MiB; no destination path, audio or video. The Host chooses a private no-overwrite file. A confirmed receipt is a file reference, not a message or model result. Inspect the original operation after an unknown reply; never automatically resend.'),
  command('file.upload.inspect', '--input FILE|-', 'Read back the exact original upload operation and file revision without writing or sending input.', { '--input': 'data' },
    async f => parseFileUploadIdentity(await readControlJsonInput(value(f, '--input', true)!, 'Original upload')) as unknown as Record<string, unknown>,
    'Pass the original upload JSON without dataBase64. Uploaded means the same target, operation and bytes were read back from the Host; missing and unknown remain distinct. This does not resend a file or control an Agent.'),
  command('file.view', '--region ID [--mode source|diff|preview]', 'Read or change one FileRegion mode without forcing focus.', { '--region': 'data', '--mode': 'value', ...OP }, f => ({ regionId: id(f, '--region', true), ...fields(f, { '--mode': 'mode' }), ...(f.values.has('--mode') ? operation(f) : {}) })),
  { ...command('file.ls', '--zone ID --host ID --workspace ID --workspace-path PATH [--path DIR] [--space ID] [--limit N]', 'Discover original Zone-relative file names without reading content or changing focus.',
    { '--zone': 'data', '--host': 'data', '--workspace': 'data', '--workspace-path': 'data', '--path': 'data', '--space': 'data', '--limit': 'value' },
    f => parseFileListParams({ ...parseFileReadCommand({ zoneId: value(f, '--zone', true)!, path: value(f, '--path') ?? '.', hostId: value(f, '--host', true)!, workspaceId: value(f, '--workspace', true)!, workspacePath: value(f, '--workspace-path', true)!,
      ...(f.values.has('--space') ? { spaceId: value(f, '--space', true)! } : {}) }), ...numbers(f, { '--limit': 'limit' }) }) as unknown as Record<string, unknown>,
    'Calls file.list. Results are relative to the requested directory. Git ignore rules apply; complete/partial and its reason are explicit. To continue with file open --zone, prepend the requested directory to each result for --path (omit the default dot prefix).'), rpcMethod: 'file.list' },
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
  command('browser.stop', '--operation-id ID', 'Stop an active Browser operation; return retained state if finished.', OP, f => ({ operationId: id(f, '--operation-id') }), 'For an active operation on an external shared tab, explicit stop ends only that original tab\'s sharing grant; other targets retain their grants. The original tab stays open. Another action on it requires an explicit share. A finished operation returns its retained terminal state without ending its sharing grant. Reader cancellation only detaches the reader and does not stop the operation or end sharing.'),
  { ...command('browser.follow', '--operation-id ID [--after-sequence N]', 'Follow retained operation progress and Gap facts.', { ...OP, '--after-sequence': 'value' }, f => ({ operationId: id(f, '--operation-id'), ...numbers(f, { '--after-sequence': 'afterSequence' }) })), stream: true },
  command('browser.replay', '--browser ID --operation-id ID [--preview|--step N|--run]', 'Replay the original operation with exact Browser identity.', { '--browser': 'data', ...OP, '--preview': 'boolean', '--run': 'boolean', '--step': 'value' }, f => {
    if (Number(f.booleans.has('--preview')) + Number(f.booleans.has('--run')) + Number(f.values.has('--step')) > 1) invalid('Choose one replay mode.')
    return { browserId: id(f, '--browser', true), operationId: id(f, '--operation-id'), mode: f.booleans.has('--preview') ? 'preview' : f.values.has('--step') ? 'step' : 'run', ...numbers(f, { '--step': 'step' }) }
  }),
  command('goal.ls', '[filters]', 'List original durable Goals with real field filters.', GOAL_FILTERS, filters),
  goal('inspect', '--goal ID', 'Inspect the original Goal identity and content.', {}, () => ({})),
  command('goal.create', '--title TEXT [--goal ID] [--description TEXT] [--project ID] [--priority VALUE] [--status VALUE] [--session ID] [--content-refs JSON]', 'Create through the original Goal owner and record decision provenance.', { '--title': 'data', '--goal': 'data', '--description': 'data', '--project': 'data', '--priority': 'value', '--status': 'value', '--session': 'data', '--risk': 'value', '--confirm': 'value', '--wiki-version': 'data', '--content-refs': 'data', ...OP }, f => ({ ...operation(f), title: value(f, '--title', true), ...fields(f, { '--goal': 'goalId', '--description': 'description', '--project': 'projectId', '--priority': 'priority', '--status': 'status', '--risk': 'risk', '--confirm': 'confirmation', '--wiki-version': 'wikiVersion' }), ...(f.values.has('--session') ? { sessionIds: [id(f, '--session')] } : {}), ...(f.values.has('--content-refs') ? { contentRefs: jsonValue(value(f, '--content-refs', true)!, '--content-refs') } : {}) }), SAVE_NOTICE),
  goal('update', '--goal ID [--title TEXT|--description TEXT|--project ID|--priority VALUE|--status VALUE|--session ID|--alignment JSON|--grounding JSON|--content-refs JSON] [--expected-updated-at MS]', 'Update original Goal content; proposal validation belongs to its owner.', { '--title': 'data', '--goal': 'data', '--description': 'data', '--project': 'data', '--priority': 'value', '--status': 'value', '--session': 'data', '--alignment': 'data', '--grounding': 'data', '--content-refs': 'data', '--expected-updated-at': 'value' }, f => {
    const patch = fields(f, { '--title': 'title', '--description': 'description', '--project': 'projectId', '--priority': 'priority', '--status': 'status' })
    if (f.values.has('--session')) patch.sessionIds = [id(f, '--session')]
    for (const key of ['alignment', 'grounding', 'content-refs']) if (f.values.has(`--${key}`)) {
      try { patch[key === 'content-refs' ? 'contentRefs' : key] = JSON.parse(value(f, `--${key}`, true)!) } catch { invalid(`--${key} requires valid JSON.`) }
    }
    if (!Object.keys(patch).length) invalid('Goal update requires at least one patch option.')
    return { patch, ...numbers(f, { '--expected-updated-at': 'expectedUpdatedAt' }) }
  }, true),
  goal('delete', '--goal ID --confirm delete', 'Delete one explicitly confirmed Goal.', { '--confirm': 'value' }, f => ({ confirmation: value(f, '--confirm', true) }), true),
  goal('assign', '--goal ID [--project ID] [--executor ID] [--start]', 'Assign an original Goal; optional start remains an explicit side effect.', { '--project': 'data', '--executor': 'data', '--start': 'boolean' }, f => ({ ...fields(f, { '--project': 'projectId', '--executor': 'assigneeExecutorId' }), start: f.booleans.has('--start') }), true),
  goal('start', '--goal ID [--session ID] [--continue-ms MS --alignment-revision REV] [--operation-id OP]', 'Start finite execution or opt in to an exact confirmed Goal continuation.', { '--session': 'data', '--continue-ms': 'value', '--alignment-revision': 'value' }, f => {
    const continuation = numbers(f, { '--continue-ms': 'intervalMs', '--alignment-revision': 'alignmentRevision' })
    if (f.values.has('--continue-ms') !== f.values.has('--alignment-revision')) invalid('Continuation requires both --continue-ms and --alignment-revision.')
    return { ...fields(f, { '--session': 'sessionId' }), ...(f.values.has('--continue-ms') ? { continuation } : {}) }
  }, true),
  goal('continuation-action', '--goal ID --loop ID --action pause|resume|stop|check --revision REV [--operation-id OP]', 'Control the exact original Goal loop; stopping a loop keeps the Agent Run.', { '--loop': 'data', '--action': 'value', '--revision': 'value' }, f => {
    value(f, '--revision', true)
    return { loopId: id(f, '--loop', true), action: value(f, '--action', true), ...numbers(f, { '--revision': 'expectedRevision' }) }
  }, true),
  goal('discuss', '--goal ID --mode open|grill|grounding', 'Open the original Goal discussion or request clarification/result inspection; navigation is not Prompt acceptance.', { '--mode': 'value' }, f => ({ mode: value(f, '--mode', true) }), true),
  goal('confirm', '--goal ID --revision N', 'Confirm the exact original Goal proposal as an authenticated person or device.', { '--revision': 'value' }, f => numbers(f, { '--revision': 'expectedRevision' }), true),
  goal('accept', '--goal ID --revision N --submission ID [--accept-gaps]', 'Accept the exact original result submission as a person; reported gaps remain in its record.', { '--revision': 'value', '--submission': 'data', '--accept-gaps': 'boolean' }, f => ({ ...numbers(f, { '--revision': 'expectedAlignmentRevision' }), expectedSubmissionId: id(f, '--submission', true), acceptGaps: f.booleans.has('--accept-gaps') }), true),
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
  settings('settings.executors.discover', '--host <id>', 'Discover registered and supported default Executors on the exact target Host.'),
  settings('settings.executors.register', '<id> --host <id> --input <file|->', 'Save an explicit Executor configuration on its executing Host.', 1),
  settings('settings.hosts.ls', '', 'List actual configured Hosts.'),
  settings('settings.hosts.test', '<id>|--input <file|->', 'Test an exact saved Host or a complete draft.', 1),
  settings('settings.hosts.trusted-sources', '--host <id>', 'Read this Host creation authority and explicitly trusted source keys.'),
  settings('settings.hosts.trust-source', '--host <id> --input <file|->', 'Trust one explicit source Runtime key; requires a transport-approved user.'),
  settings('settings.hosts.upgrade-check', '<id>|--input <file|->', 'Check the original SSH Core and exact offline update candidate without changing it.', 1),
  settings('settings.hosts.upgrade', '<id> --input <file|->', 'Upgrade the checked original Core, carrying expected and operationId.', 1),
  settings('settings.hosts.upgrade-inspect', '<id> --operation-id ID', 'Inspect the original Core update without replaying it.', 1),
  settings('settings.workspaces.register', '--input <file|->', 'Register an existing directory; this does not run Git, focus or start an Agent.'),
  settings('settings.browser-links.ls', '', 'List remembered system-application link choices.'),
  settings('settings.browser-links.forget', '<scheme>|--input <file|->', 'Forget one exact remembered scheme decision.', 1),
  command('system.storage', '--host HOST --run RUN', 'Read original Runtime storage failure, watermarks and effective capacity for one exact Run.', { '--host': 'data', '--run': 'data' }, f => ({ hostId: id(f, '--host'), runId: id(f, '--run') })),
  command('system.doctor', '[--workspace PATH]', 'Read original Runtime and Provider diagnostics through their owners.', { '--workspace': 'data' }, f => fields(f, { '--workspace': 'workspacePath' })),
  { ...command('system.endpoint', '[--stdio]', 'Describe the selected endpoint with connection=not-attempted, or relay strict RPC stdio.', { '--stdio': 'boolean' }, f => ({ stdio: f.booleans.has('--stdio') })), local: true },
  empty('system.crash-log.inspect', 'Read retained original crash-log facts.'),
  empty('system.crash-log.reveal', 'Reveal the retained crash-log through the client owner.'),
  empty('system.metrics.get', 'Read per-source bounded metrics with availability and observation times.'),
  { ...empty('system.metrics.watch', 'Watch metrics; a slow reader ends without an unbounded frame queue.'), stream: true },
  toolkit('ls', '', 'List original saved Toolkit resources.', 0),
  toolkit('inspect', '<id>', 'Inspect current definition, execution and result facts.'),
  toolkit('create', '<id> --input <file|->', 'Create a complete tool using its original owner.'),
  toolkit('install', '<id> --path <absolute-directory> [--cwd <absolute-directory>]', 'Save a local package reference and preferences without running it.'),
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
  const command = match!.command.rpcMethod ? { ...match!.command, method: match!.command.rpcMethod } : match!.command
  return { command, params: await match!.command.parse(match!.tail), ...(endpoint === undefined ? {} : { endpoint }) }
}
