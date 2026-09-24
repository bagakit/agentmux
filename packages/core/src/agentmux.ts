#!/usr/bin/env node
import { parseAlignmentProposal, parseGroundingProposal } from '@agentmux/demand/goals'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import packageManifest from '../package.json' with { type: 'json' }
import type { AgentMuxAgentSessionLookup } from './agent-session-registry.js'
import { resolveAgentSessionId } from './agent-session-id.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from './agent-session-store.js'
import { classifySelfViewFailure, SELF_CONTEXT_TOPIC_HINT, type SelfViewOutcome } from './agent-self-context.js'
import { AGENTMUX_CLI_HELP, AGENTMUX_CLI_SKILL, AGENTMUX_SELF_CONTEXT_VERB, agentMuxCommandHelp } from './agentmux-cli-help.js'
import type { AgentMuxClient } from './client.js'
import {
  AGENTMUX_CONTROL_ERROR_CODES,
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  AGENTMUX_DEMAND_PRIORITIES,
  AGENTMUX_DEMAND_STATUSES,
  type AgentMuxControlCaller,
  type AgentMuxOpenDestination,
  type AgentMuxSpaceDestination,
  type AgentMuxSpaceSelector
  , type AgentMuxDemandPriority
  , type AgentMuxDemandStatus
} from './control.js'
import { requestAgentMuxControl, subscribeAgentMuxControl } from './control-host.js'
import { diagnoseAgentMux } from './doctor.js'
import { AgentMuxError } from './errors.js'
import { defaultAgentMuxControlSocketPath } from './runtime-paths.js'
import { pmoSessionMatches } from './pmo-session-filter.js'
import { OrderedSessionOutputFollow, type FollowOutput } from './session-output-follow.js'
import { isWorkbenchLayoutPreset } from './workbench-layout-preset.js'
import { SPLIT_FLAG_DIRECTIONS, type SplitDirection } from './split-direction-ssot.js'
import { assertDispatchEventKind } from './agent-handoff.js'
import { registerAgentRole, resolveAgentRole, readAgentRoleBindings } from './agent-role-directory.js'
import { appendGlobalMessage, prepareGlobalMessagePrompt, recordGlobalMessageDelivery, recordGlobalMessageDeliveryIssue, type AgentMuxMessageAppendInput } from './agent-global-message-queue.js'
import { validateAgentPromptCondition } from './agent-prompt-condition.js'
import { parseSettingsCommand } from './settings-cli.js'
import { settingsResourceBudget } from './settings-resource-json.js'
import { parseSpaceControlRequest, spaceControlId } from './space-control-parser.js'

// 版本号的唯一真相是 package.json 的 `version`——那是 npm 发布、也是用户 `--version` 应当与之一致的
// 那个字段。这里用 `with { type: 'json' }` 直接引用它，而不是手抄一份常量：tsc 在 NodeNext 下把
// package.json 拉进程序（`resolveJsonModule`），JSON import 原样出到 dist，运行时由 Node 解析同一份
// 文件。所以这不是「构建图之外的手抄常量」——改 package.json 的 version，编译产物与 `--version` 一起变。
const VERSION = packageManifest.version
let CLI_REQUEST_ID: string = randomUUID()
const CLI_ERROR_CODES = [
  ...AGENTMUX_CONTROL_ERROR_CODES,
  'INVALID_CLI_ARGUMENT',
  'MANAGED_AGENT_CONTEXT_REQUIRED',
  'AGENTMUX_FAILED',
  'MAINTAINER_TARGET_UNRESOLVED',
  // 角色目录读不出来。与 `MAINTAINER_TARGET_UNRESOLVED` 是**相反的两件事**，这正是它必须单独在册的
  // 理由：后者说「这个角色没人认领」（去 register 一个），前者说「登记表我读不了」（去修那个文件）。
  // 不在册时 `cliErrorCode` 把它折成 `AGENTMUX_FAILED`——与「命令打错了」同一个码，于是机读侧分不出
  // 「你的文件坏了」与「你的命令错了」。人读的 message 一直是对的，机读的码此前是错的。
  'AGENT_ROLE_DIRECTORY_UNREADABLE',
  // `inspect --run/--provider-native/--acp-native <不存在的 id>`。`registry.resolve` 在同一个函数里抛
  // 四种码，另外三种（UNKNOWN_AGENT_SESSION / STALE_AGENT_SESSION_BINDING ×2）都经控制码表在册，
  // 只有这一种漏了——于是「你给的 run id 不存在」与「你把命令打错了」在机读侧是同一个
  // `AGENTMUX_FAILED`，而 `--session <不存在>` 走 `registry.get`，报的是它自己的
  // `UNKNOWN_AGENT_SESSION`。同一条命令的两个选择器，一个说得清一个说不清。
  //
  // 不进控制码表而进这里：它是**进程内**抛的（CLI 直接 new AgentMuxClient，registry 是本地 Map），
  // 不经 daemon 往返，定型它的是这条顶层 catch。
  'UNKNOWN_AGENT_SESSION_BINDING',
  'AMBIGUOUS_AGENT_SESSION',
  // Preserve Core durable-store and queue errors at the CLI's local catch boundary.
  'AGENT_SESSION_BUSY',
  'AGENT_SESSION_STORE_BUSY',
  'AGENT_SESSION_STORE_LIMIT',
  'AGENT_SESSION_STORE_LOCK_RELEASE_FAILED',
  'AGENT_TIMELINE_REVISION_LIMIT',
  'AGENT_TIMELINE_STORE_LIMIT',
  'DUPLICATE_AGENT_SESSION',
  'INVALID_AGENT_TIMELINE_STORE',
  'MESSAGE_ACK_GENERATION_STALE',
  'AGENT_DELIVERY_GENERATION_STALE',
  'MESSAGE_BATCH_LIMIT_INVALID',
  'MESSAGE_ID_CONFLICT',
  'MESSAGE_ID_REQUEST_ID_COLLISION',
  'MESSAGE_NOT_FOUND',
  'MESSAGE_QUEUE_BACKPRESSURE',
  'MESSAGE_QUEUE_UNAVAILABLE',
  'DISPATCH_MESSAGE_UNAVAILABLE',
  'DISPATCH_NOT_FOUND',
  'DISPATCH_PARTICIPANT_MISMATCH',
  'DISPATCH_MESSAGE_INVALID',
  'DISPATCH_EVENT_CONFLICT',
  'DISPATCH_IDENTITY_UNAVAILABLE',
  // Session 存档自身读不出来。判据是一条真命令：把 store 的 `version` 改成 5 以外的值，
  // `agentmux inspect --session <任意>` 报的是「Agent Session store is invalid.」，而码折成了
  // `AGENTMUX_FAILED`——与「命令打错了」同一个码。和 `AGENT_ROLE_DIRECTORY_UNREADABLE` 完全同族：
  // 人读的 message 一直对，机读的码在撒谎，而这一个说的是「去修你那个文件」，不是「去改你的命令」。
  //
  // 注意它**不是**只在写路径上：`connect()` → `registry.load` → `store.load()` 的读路径同步就抛，
  // 于是每一条 `withClient` 命令都够得着。（垃圾字节反而不抛——那条路会 salvage+quarantine；
  // 真正抛的是 schema 对不上。）
  'INVALID_AGENT_SESSION_STORE',
  // `handoff` / `discuss` 的凭证校验。两条命令都经 `client.handOff` / `client.startDiscussion` →
  // `resolveMessageAuthor` → `resolveCapabilityAuthor`（agent-capability.ts）在**进程内**抛，同样
  // 落这条顶层 catch。三个码说的是三件不同的事——凭证不对 / 还没生效 / 属于已被替换的 Run——
  // 而它们此前一起折成 `AGENTMUX_FAILED`，于是「你的凭证过期了，重取一个」和「你把命令打错了」
  // 在机读侧无从分辨。agent-capability.ts 的注释自己写着「调用方就只能猜该重试还是该放弃」，
  // 折叠恰好把那句话变成现实。
  'AGENT_CAPABILITY_INVALID',
  'AGENT_CAPABILITY_NOT_READY',
  'AGENT_CAPABILITY_STALE_RUN',
  // 同一条 `discuss` 线更深一层（agent-discussion.ts）：跨 workspace 的对话被拒。这一个说的是
  // 「你要谈的对象不在这个 workspace」，属于用户改得动的事，更不该长着「命令打错了」的脸。
  'AGENT_MESSAGE_CROSS_WORKSPACE'
] as const
type CliErrorCode = typeof CLI_ERROR_CODES[number]
// Session selectors are opaque data values, not CLI options; their identity is resolved by Core.
type FlagKind = 'boolean' | 'value' | 'data'
type ParsedFlags = { values: Map<string, string>; booleans: Set<string> }

function cliError(message: string): AgentMuxError { return new AgentMuxError(message, 'INVALID_CLI_ARGUMENT') }

function cliErrorCode(value: unknown): CliErrorCode {
  return (CLI_ERROR_CODES as readonly unknown[]).includes(value) ? value as CliErrorCode : 'AGENTMUX_FAILED'
}

function parseFlags(args: readonly string[], specs: Readonly<Record<string, FlagKind>>): ParsedFlags {
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument?.startsWith('--')) throw cliError(`Unexpected argument: ${argument ?? ''}`)
    const separator = argument.indexOf('=')
    const flag = separator < 0 ? argument : argument.slice(0, separator)
    const inlineValue = separator < 0 ? undefined : argument.slice(separator + 1)
    if (values.has(flag) || booleans.has(flag)) throw cliError(`Duplicate option: ${flag}`)
    const kind = specs[flag]
    if (!kind) throw cliError(`Unsupported option: ${flag}`)
    if (kind === 'boolean') {
      if (inlineValue !== undefined) throw cliError(`Option does not accept a value: ${flag}`)
      booleans.add(flag); continue
    }
    if (inlineValue !== undefined) { values.set(flag, inlineValue); continue }
    const value = args[index + 1]
    if (value === undefined || (kind === 'value' && value.startsWith('--'))) throw cliError(`Missing value for ${flag}.`)
    values.set(flag, value); index += 1
  }
  return { values, booleans }
}

function identifier(value: string | undefined, label: string): string {
  if (!value) throw cliError(`${label} is required.`)
  return value
}

function explicitSelectorId(value: string | undefined, label: string): string {
  const result = identifier(value, label)
  if (result === 'self') throw cliError(`${label} cannot use the reserved self selector.`)
  return result
}

function requiredData(flags: ParsedFlags, name: string, label: string): string {
  const value = flags.values.get(name)
  if (value === undefined) throw cliError(`${label} is required.`)
  return value
}

function exactlyOne(flags: ParsedFlags, names: readonly string[], label: string): string {
  const present = names.filter((name) => flags.values.has(name))
  if (present.length !== 1) throw cliError(`${label} requires exactly one of ${names.join(', ')}.`)
  return present[0]!
}

function managedCaller(): AgentMuxControlCaller {
  const agentSessionId = process.env.AGENTMUX_AGENT_SESSION_ID?.trim()
  if (process.env.AGENTMUX_ENV !== '1' || !agentSessionId) throw new AgentMuxError('This command requires an AgentMux-managed Agent caller.', 'MANAGED_AGENT_CONTEXT_REQUIRED')
  return { agentSessionId }
}

function callerForSelf(value: string): AgentMuxControlCaller | undefined {
  return value === 'self' ? managedCaller() : undefined
}

function sessionId(value: string): string { return value === 'self' ? managedCaller().agentSessionId : identifier(value, 'Agent Session id') }

/** Resolve against Core's durable identities without requiring the Run daemon to be available. */
async function normalizeSessionFlags(flags: ParsedFlags, names: readonly string[] = ['--session', '--to-session']): Promise<void> {
  const selectors = names.filter((name) => flags.values.has(name) && flags.values.get(name) !== 'self')
  if (selectors.length === 0) return
  const store = new AgentMuxFileAgentSessionStore()
  const [sessions, retired] = await Promise.all([loadAgentSessions(store), store.loadRetiredAgentSessions()])
  const activeIds = new Set(sessions.map((session) => session.agentSessionId))
  const knownIds = [...activeIds, ...retired.map((session) => session.agentSessionId)]
  for (const name of selectors) {
    const resolved = resolveAgentSessionId(identifier(flags.values.get(name), 'Agent Session id'), knownIds)
    if (!activeIds.has(resolved)) throw new AgentMuxError(`Agent Session is retired: ${resolved}`, 'UNKNOWN_AGENT_SESSION')
    flags.values.set(name, resolved)
  }
}
function requestBase() { return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: CLI_REQUEST_ID } as const }
function writeJson(value: unknown, stream: NodeJS.WritableStream = process.stdout): void { stream.write(`${JSON.stringify(value)}\n`) }
function printSuccess(operation: string, result: unknown): void {
  writeJson({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: CLI_REQUEST_ID, ok: true, operation, result })
}
function printPmoSuccess(operation: string, result: unknown): void {
  writeJson({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: CLI_REQUEST_ID, ok: true, operation, observedAt: Date.now(), result })
}
function printStream(operation: string, event: string, result: unknown): void {
  writeJson({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: CLI_REQUEST_ID, ok: true, operation, event, result })
}

async function withClient<T>(operation: (client: AgentMuxClient) => Promise<T>): Promise<T> {
  const { connectLocalAgentMux } = await import('./runtime-client.js')
  const client = await connectLocalAgentMux()
  try { return await operation(client) } finally { await client.dispose() }
}

async function inspectCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, {
    '--session': 'data', '--run': 'value', '--tab': 'value', '--region': 'value',
    '--provider-native': 'value', '--provider': 'value', '--acp-native': 'value', '--adapter': 'value'
  })
  const selector = exactlyOne(flags, ['--session', '--run', '--tab', '--region', '--provider-native', '--acp-native'], 'inspect')
  if ((selector === '--provider-native') !== flags.values.has('--provider')) {
    throw cliError('--provider-native and --provider must be used together.')
  }
  if ((selector === '--acp-native') !== flags.values.has('--adapter')) {
    throw cliError('--acp-native and --adapter must be used together.')
  }
  // Refuse an ambiguous/unknown Session before connecting can start or repair any Run service.
  await normalizeSessionFlags(flags)
  if (selector === '--tab') {
    const value = flags.values.get(selector)!
    const owner = callerForSelf(value)
    const receipt = await requestAgentMuxControl({
      ...requestBase(), operation: 'inspect.tab',
      target: value === 'self' ? { kind: 'self' } : { kind: 'tab', tabId: explicitSelectorId(value, 'Tab id') },
      ...(owner ? { caller: owner } : {})
    })
    printSuccess(receipt.operation, receipt.result); return 0
  }
  if (selector === '--region') {
    const value = flags.values.get(selector)!
    const owner = callerForSelf(value)
    const receipt = await requestAgentMuxControl({
      ...requestBase(), operation: 'inspect.region',
      target: value === 'self' ? { kind: 'self' } : { kind: 'region', regionId: explicitSelectorId(value, 'Region id') },
      ...(owner ? { caller: owner } : {})
    })
    printSuccess(receipt.operation, receipt.result); return 0
  }
  return await withClient(async (client) => {
    let lookup: AgentMuxAgentSessionLookup
    if (selector === '--session') lookup = { kind: 'agent-session', agentSessionId: sessionId(flags.values.get(selector)!) }
    else if (selector === '--run') lookup = { kind: 'run', run: { runId: identifier(flags.values.get(selector), 'Run id') } }
    else if (selector === '--provider-native') {
      lookup = { kind: 'provider-native', providerId: identifier(flags.values.get('--provider'), 'Provider id'), sessionId: identifier(flags.values.get(selector), 'Provider-native session id') }
    } else {
      lookup = { kind: 'acp-native', adapterId: identifier(flags.values.get('--adapter'), 'ACP adapter id'), sessionId: identifier(flags.values.get(selector), 'ACP-native session id') }
    }
    const session = client.resolveAgentSession(lookup)
    printSuccess('inspect.session', { session })
    return 0
  })
}

async function roleCommand(args: readonly string[]): Promise<number> {
  const action = args[0]
  if (action === 'list') {
    const bindings = await readAgentRoleBindings(process.cwd())
    printSuccess('roles.list', { bindings }); return 0
  }
  if (action === 'register') {
    const flags = parseFlags(args.slice(1), { '--role': 'value', '--provider': 'value' })
    const caller = managedCaller()
    const role = identifier(flags.values.get('--role'), 'Role')
    const providerId = identifier(flags.values.get('--provider') ?? process.env.AGENTMUX_AGENT_PROVIDER, 'Provider id')
    const binding = await registerAgentRole({ role, agentSessionId: caller.agentSessionId, workspacePath: process.cwd(), providerId })
    printSuccess('roles.register', { binding }); return 0
  }
  if (action === 'resolve') {
    const flags = parseFlags(args.slice(1), { '--role': 'value' })
    const role = identifier(flags.values.get('--role'), 'Role')
    const binding = await withClient(async (client) => await resolveAgentRole({ workspacePath: process.cwd(), role, sessionExists: async (id) => { try { await client.statusAgent(id); return true } catch { return false } } }))
    if (!binding) throw new AgentMuxError('Maintainer role is unresolved or stale.', 'MAINTAINER_TARGET_UNRESOLVED')
    printSuccess('roles.resolve', { binding }); return 0
  }
  throw cliError('roles requires list, register, or resolve.')
}

async function listCommand(args: readonly string[]): Promise<number> {
  if (args[0] !== 'agents' && args[0] !== 'sessions' && args[0] !== 'projects' && args[0] !== 'active-agents') throw cliError('list requires agents, sessions, projects, or active-agents.')
  parseFlags(args.slice(1), {})
  if (args[0] === 'agents') {
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'list.agents' })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  if (args[0] === 'projects') {
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'list.projects' })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  if (args[0] === 'active-agents') {
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'list.active-agents' })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  return await withClient(async (client) => {
    // One stale Session binding must not hide healthy Sessions. Keep the item-level
    // error typed and visible while preserving a successful list for the rest.
    const results = await Promise.allSettled(client.agentSessions().map(async (session) => await client.statusAgent(session.agentSessionId)))
    const sessions = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const errors = results.flatMap((result) => result.status === 'rejected' ? [{ error: result.reason instanceof AgentMuxError ? { code: result.reason.code, message: result.reason.message } : { code: 'LIST_SESSION_FAILED', message: String(result.reason) } }] : [])
    printSuccess('list.sessions', { sessions, ...(errors.length ? { errors } : {}) }); return 0
  })
}

/**
 * PMO Teams needs one bounded, machine-readable observation surface instead of
 * scraping several human-oriented commands. Each projection remains owned by
 * its existing Core/Control owner; this command only joins the receipts.
 */
async function pmoCommand(args: readonly string[]): Promise<number> {
  const action = args[0] ?? 'snapshot'
  if (action !== 'snapshot' && action !== 'projects' && action !== 'workspaces' && action !== 'topics' && action !== 'agents' && action !== 'sessions' && action !== 'demands' && action !== 'activity' && action !== 'inspect') {
    throw cliError('pmo requires snapshot, projects, workspaces, topics, agents, sessions, demands, activity, or inspect.')
  }
  const flags = parseFlags(args.slice(1), {
    '--project': 'value', '--workspace': 'value', '--topic': 'value', '--agent': 'data', '--session': 'data', '--demand': 'value', '--executor': 'value', '--status': 'value', '--since': 'value', '--limit': 'value'
  })
  const limitValue = flags.values.get('--limit')
  const limit = limitValue === undefined ? 100 : Number(limitValue)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw cliError('--limit must be an integer between 1 and 1000.')
  const sinceValue = flags.values.get('--since')
  const since = sinceValue === undefined ? undefined : Number(sinceValue)
  if (since !== undefined && !Number.isFinite(since)) throw cliError('--since must be a timestamp in milliseconds.')
  if (action === 'workspaces') {
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'space.ls', target: {} })
    if (receipt.operation !== 'space.ls') throw new AgentMuxError('Workspace discovery receipt operation is mismatched.', 'CONTROL_PROTOCOL_ERROR')
    const { spaces, zones } = receipt.result.catalog
    const workspaceId = flags.values.get('--workspace'), projectId = flags.values.get('--project')
    const selected = zones.filter(zone => (!workspaceId || zone.workspaceId === workspaceId) &&
      (!projectId || spaces.some(space => space.spaceId === zone.spaceId && space.projectId === projectId)))
    const workspaces = [...new Set(selected.map(zone => zone.workspaceId))].map(workspaceId => ({
      workspaceId, zones: selected.filter(zone => zone.workspaceId === workspaceId)
    })).slice(0, limit)
    printPmoSuccess('pmo.workspaces', { workspaces }); return 0
  }
  // PMO's mixed observations include generic Desktop Session links in Demands.
  // Only the strictly Agent projections resolve --session through Core.
  await normalizeSessionFlags(flags, action === 'agents' || action === 'sessions' ? ['--session', '--agent'] : ['--agent'])

  const [projectsReceipt, agentsReceipt, demandsReceipt] = await Promise.allSettled([
    requestAgentMuxControl({ ...requestBase(), operation: 'list.projects' }),
    requestAgentMuxControl({ ...requestBase(), operation: 'list.active-agents' }),
    requestAgentMuxControl({ ...requestBase(), operation: 'demand.list' })
  ])
  const unavailable: Array<{ surface: string; code: string; message: string; recovery: string }> = []
  const failedObservation = (surface: string, result: PromiseSettledResult<unknown>): null => {
    if (result.status === 'fulfilled') return null
    const error = result.reason as { code?: unknown; message?: unknown }
    unavailable.push({ surface, code: typeof error.code === 'string' ? error.code : 'OBSERVATION_UNAVAILABLE', message: typeof error.message === 'string' ? error.message : String(result.reason), recovery: 'Retry this surface after its owner reports ready.' })
    return null
  }
  const projects = projectsReceipt.status === 'fulfilled' && projectsReceipt.value.operation === 'list.projects' ? projectsReceipt.value.result.projects : (failedObservation('projects', projectsReceipt), [])
  const agents = agentsReceipt.status === 'fulfilled' && agentsReceipt.value.operation === 'list.active-agents' ? agentsReceipt.value.result.agents : (failedObservation('agents', agentsReceipt), [])
  const demands = demandsReceipt.status === 'fulfilled' && demandsReceipt.value.operation === 'demand.list' ? demandsReceipt.value.result.demands : (failedObservation('demands', demandsReceipt), [])
  const projectId = flags.values.get('--project')
  const agentId = flags.values.get('--agent')
  const sessionId = flags.values.get('--session')
  const demandId = flags.values.get('--demand')
  const executorId = flags.values.get('--executor')
  const status = flags.values.get('--status')
  const filteredProjects = projectId ? projects.filter((project) => project.projectId === projectId) : projects
  const filteredAgents = agents.filter((agent) => (!projectId || agent.projectId === projectId) && (!agentId || agent.agentSessionId === agentId) && (!sessionId || agent.agentSessionId === sessionId) && (!executorId || agent.executorId === executorId) && (!status || agent.status === status))
  const filteredDemands = demands.filter((demand) => (!projectId || demand.projectId === projectId) && (!sessionId || demand.sessionIds.includes(sessionId)) && (!demandId || demand.id === demandId) && (!executorId || demand.assigneeExecutorId === executorId) && (!status || demand.status === status) && (since === undefined || demand.updatedAt >= since)).slice(0, limit)
  const sessions = await withClient(async (client) => {
    const results = await Promise.allSettled(client.agentSessions().map(async (session) => await client.statusAgent(session.agentSessionId)))
    return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  })
  const filteredSessions = sessions.filter((session) => pmoSessionMatches(session, { sessionId, status, since })).slice(0, limit)
  if (action === 'projects') { printPmoSuccess(`pmo.${action}`, { projects: filteredProjects, ...(unavailable.length ? { unavailable } : {}) }); return 0 }
  if (action === 'agents') { printPmoSuccess('pmo.agents', { agents: filteredAgents, ...(unavailable.length ? { unavailable } : {}) }); return 0 }
  if (action === 'sessions') { printPmoSuccess('pmo.sessions', { sessions: filteredSessions, ...(unavailable.length ? { unavailable } : {}) }); return 0 }
  if (action === 'demands') { printPmoSuccess('pmo.demands', { demands: filteredDemands, ...(unavailable.length ? { unavailable } : {}) }); return 0 }
  if (action === 'topics') {
    // Topic truth lives in workspace files, not Core. Keep the boundary explicit
    // until a host-neutral topic reader is available rather than inventing a registry.
    printPmoSuccess('pmo.topics', { topics: [], unavailable: { code: 'TOPIC_FILESYSTEM_SCOPE_REQUIRED', message: 'Topic discovery requires an explicit workspace filesystem scope.' } }); return 0
  }
  if (action === 'activity') {
    const activity = filteredDemands.flatMap((demand) => (demand.activityLog ?? []).map((message) => ({ demandId: demand.id, message, updatedAt: demand.updatedAt }))).slice(-limit)
    printPmoSuccess('pmo.activity', { activity, ...(unavailable.length ? { unavailable } : {}) }); return 0
  }
  if (action === 'inspect') {
    const selected = demandId ? filteredDemands.find((demand) => demand.id === demandId) : agentId ? filteredAgents.find((agent) => agent.agentSessionId === agentId) : projectId ? filteredProjects.find((project) => project.projectId === projectId) : null
    printPmoSuccess('pmo.inspect', { item: selected ?? null, ...(unavailable.length ? { unavailable } : {}) }); return 0
  }
  printPmoSuccess('pmo.snapshot', { projects: filteredProjects.slice(0, limit), agents: filteredAgents.slice(0, limit), sessions: filteredSessions, demands: filteredDemands, topics: [], unavailable, topicDiscovery: { code: 'TOPIC_FILESYSTEM_SCOPE_REQUIRED', message: 'Topic discovery requires an explicit workspace filesystem scope.' } })
  return 0
}

async function demandCommand(args: readonly string[]): Promise<number> {
  const action = args[0]
  if (action === 'list') {
    const flags = parseFlags(args.slice(1), { '--status': 'value', '--project': 'value', '--executor': 'value', '--session': 'data', '--limit': 'value' })
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'demand.list' })
    if (receipt.operation !== 'demand.list') throw new AgentMuxError('Demand list receipt operation does not match.', 'CONTROL_PROTOCOL_ERROR')
    const limit = flags.values.get('--limit') === undefined ? 100 : Number(flags.values.get('--limit'))
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw cliError('--limit must be an integer between 1 and 1000.')
    const filtered = receipt.result.demands.filter((demand) => (!flags.values.has('--status') || demand.status === flags.values.get('--status')) && (!flags.values.has('--project') || demand.projectId === flags.values.get('--project')) && (!flags.values.has('--executor') || demand.assigneeExecutorId === flags.values.get('--executor')) && (!flags.values.has('--session') || demand.sessionIds.includes(identifier(flags.values.get('--session'), 'Session id')))).slice(0, limit)
    printSuccess(receipt.operation, { demands: filtered })
    return 0
  }
  if (action === 'show') {
    const flags = parseFlags(args.slice(1), { '--demand': 'value' })
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'demand.show', demandId: identifier(flags.values.get('--demand'), 'Demand id') })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  if (action === 'create') {
    const flags = parseFlags(args.slice(1), { '--title': 'data', '--description': 'data', '--project': 'value', '--priority': 'value', '--status': 'value', '--session': 'data', '--risk': 'value', '--confirm': 'value', '--wiki-version': 'value' })
    const priority = flags.values.get('--priority')
    const status = flags.values.get('--status')
    if (priority && !(AGENTMUX_DEMAND_PRIORITIES as readonly string[]).includes(priority)) throw cliError(`Unknown demand priority: ${priority}`)
    if (status && !(AGENTMUX_DEMAND_STATUSES as readonly string[]).includes(status)) throw cliError(`Unknown demand status: ${status}`)
    const description = flags.values.get('--description'); const projectId = flags.values.get('--project')
    const risk = flags.values.get('--risk') ?? 'unknown'; const confirmation = flags.values.get('--confirm') ?? 'pending'
    if (!['low', 'medium', 'high', 'unknown'].includes(risk)) throw cliError(`Unknown demand risk: ${risk}`)
    if (!['automatic', 'user', 'pending'].includes(confirmation)) throw cliError(`Unknown demand confirmation: ${confirmation}`)
    const decision = { input: requiredData(flags, '--title', 'Demand title'), candidates: projectId ? [{ projectId, reason: 'explicit CLI project' }] : [], selectedProjectId: projectId ?? null, risk: risk as 'low' | 'medium' | 'high' | 'unknown', confirmation: confirmation as 'automatic' | 'user' | 'pending', wikiVersion: flags.values.get('--wiki-version') ?? null, recordedAt: Date.now(), sourceSessionId: process.env.AGENTMUX_AGENT_SESSION_ID ?? null }
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'demand.create', title: requiredData(flags, '--title', 'Demand title'), ...(description === undefined ? {} : { description }), ...(projectId === undefined ? {} : { projectId }), ...(priority ? { priority: priority as AgentMuxDemandPriority } : {}), ...(status ? { status: status as AgentMuxDemandStatus } : {}), ...(flags.values.has('--session') ? { sessionIds: [identifier(flags.values.get('--session'), 'Session id')] } : {}), decision })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  if (action === 'update') {
    const flags = parseFlags(args.slice(1), { '--demand': 'value', '--title': 'data', '--description': 'data', '--project': 'value', '--priority': 'value', '--status': 'value', '--session': 'data', '--alignment': 'data', '--grounding': 'data' })
    const priority = flags.values.get('--priority'); const status = flags.values.get('--status')
    if (priority && !(AGENTMUX_DEMAND_PRIORITIES as readonly string[]).includes(priority)) throw cliError(`Unknown demand priority: ${priority}`)
    if (status && !(AGENTMUX_DEMAND_STATUSES as readonly string[]).includes(status)) throw cliError(`Unknown demand status: ${status}`)
    const patch: Record<string, unknown> = {}
    try {
      if (flags.values.has('--alignment')) patch.alignment = parseAlignmentProposal(JSON.parse(requiredData(flags, '--alignment', 'Goal proposal')))
      if (flags.values.has('--grounding')) patch.grounding = parseGroundingProposal(JSON.parse(requiredData(flags, '--grounding', 'Result proposal')))
    } catch (error) {
      throw cliError(error instanceof Error ? error.message : 'Goal proposal is invalid.')
    }
    for (const [flag, key] of [['--title', 'title'], ['--description', 'description'], ['--project', 'projectId'], ['--priority', 'priority'], ['--status', 'status'], ['--session', 'sessionIds']] as const) {
      if (!flags.values.has(flag)) continue
      patch[key] = flag === '--session' ? [identifier(flags.values.get(flag), 'Session id')] : flags.values.get(flag)
    }
    if (Object.keys(patch).length === 0) throw cliError('demand update requires at least one patch option.')
    const typedPatch = { ...patch, ...(typeof patch.priority === 'string' ? { priority: patch.priority as AgentMuxDemandPriority } : {}), ...(typeof patch.status === 'string' ? { status: patch.status as AgentMuxDemandStatus } : {}) }
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'demand.update', demandId: identifier(flags.values.get('--demand'), 'Demand id'), patch: typedPatch })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  if (action === 'assign') {
    const flags = parseFlags(args.slice(1), { '--demand': 'value', '--project': 'value', '--executor': 'value', '--start': 'boolean' })
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'demand.assign', demandId: identifier(flags.values.get('--demand'), 'Demand id'), ...(flags.values.has('--project') ? { projectId: identifier(flags.values.get('--project'), 'Project id') } : {}), ...(flags.values.has('--executor') ? { assigneeExecutorId: identifier(flags.values.get('--executor'), 'Agent id') } : {}), start: flags.booleans.has('--start') })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  if (action === 'start') {
    const flags = parseFlags(args.slice(1), { '--demand': 'value', '--session': 'data' })
    await normalizeSessionFlags(flags)
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'demand.start', demandId: identifier(flags.values.get('--demand'), 'Demand id'), ...(flags.values.has('--session') ? { sessionId: identifier(flags.values.get('--session'), 'Agent Session id') } : {}) })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  if (action === 'handoff') {
    const flags = parseFlags(args.slice(1), { '--demand': 'value', '--executor': 'value', '--session': 'data' })
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'demand.handoff', demandId: identifier(flags.values.get('--demand'), 'Demand id'), ...(flags.values.has('--executor') ? { assigneeExecutorId: identifier(flags.values.get('--executor'), 'Agent id') } : {}), ...(flags.values.has('--session') ? { sessionId: identifier(flags.values.get('--session'), 'Session id') } : {}) })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  if (action === 'delete') {
    const flags = parseFlags(args.slice(1), { '--demand': 'value', '--confirm': 'value' })
    if (flags.values.get('--confirm') !== 'delete') throw cliError('demand delete requires --confirm delete.')
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'demand.delete', demandId: identifier(flags.values.get('--demand'), 'Demand id'), confirmation: 'delete' })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  if (action === 'link-session' || action === 'link-project') {
    const flags = parseFlags(args.slice(1), { '--demand': 'value', [action === 'link-session' ? '--session' : '--project']: action === 'link-session' ? 'data' : 'value' })
    const receipt = action === 'link-session'
      ? await requestAgentMuxControl({ ...requestBase(), operation: 'demand.link-session', demandId: identifier(flags.values.get('--demand'), 'Demand id'), sessionId: identifier(flags.values.get('--session'), 'Session id') })
      : await requestAgentMuxControl({ ...requestBase(), operation: 'demand.link-project', demandId: identifier(flags.values.get('--demand'), 'Demand id'), projectId: identifier(flags.values.get('--project'), 'Project id') })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  if (action === 'decision-log') {
    const flags = parseFlags(args.slice(1), { '--demand': 'value' })
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'demand.decision-log', demandId: identifier(flags.values.get('--demand'), 'Demand id') })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  throw cliError('demand requires list, show, create, update, assign, start, handoff, delete, link-session, link-project, or decision-log.')
}

function openDestination(flags: ParsedFlags): { destination: AgentMuxOpenDestination; caller?: AgentMuxControlCaller } {
  const splitFlags = Object.keys(SPLIT_FLAG_DIRECTIONS)
  const selected = exactlyOne(flags, [...splitFlags, '--tab', '--in-region'], 'open')
  const value = flags.values.get(selected)!
  const owner = callerForSelf(value)
  if ((selected === '--tab') !== flags.booleans.has('--new-tab')) throw cliError('--tab and --new-tab must be used together.')
  if (selected === '--tab') return { destination: { kind: 'new-tab', after: value === 'self' ? { kind: 'self' } : { kind: 'tab', tabId: explicitSelectorId(value, 'Tab id') } }, ...(owner ? { caller: owner } : {}) }
  if (selected === '--in-region') return { destination: { kind: 'launcher', regionId: explicitSelectorId(value, 'Launcher Region id') } }
  const direction = (SPLIT_FLAG_DIRECTIONS as Record<string, SplitDirection>)[selected]
  if (!direction) throw cliError(`open received an unmapped direction flag: ${selected}.`)
  return { destination: { kind: 'split', direction, region: value === 'self' ? { kind: 'self' } : { kind: 'region', regionId: explicitSelectorId(value, 'Region id') } }, ...(owner ? { caller: owner } : {}) }
}

async function openCommand(args: readonly string[]): Promise<number> {
  if (args[0] !== 'terminal' && args[0] !== 'browser') throw cliError('open requires terminal or browser. Use agentmux agent open for an Agent.')
  const flags = parseFlags(args.slice(1), {
    ...(args[0] === 'terminal' ? { '--command': 'data' as const } : { '--url': 'value' as const }),
    '--left-of': 'value', '--right-of': 'value', '--above': 'value', '--below': 'value',
    '--tab': 'value', '--new-tab': 'boolean', '--in-region': 'value'
  })
  const placement = openDestination(flags)
  const receipt = args[0] === 'terminal'
    ? await requestAgentMuxControl({ ...requestBase(), operation: 'open.terminal',
      ...(flags.values.has('--command') ? { shellCommand: flags.values.get('--command')! } : {}), ...placement })
    : await requestAgentMuxControl({ ...requestBase(), operation: 'open.browser',
      url: identifier(flags.values.get('--url'), 'Browser URL'), ...placement })
  printSuccess(receipt.operation, receipt.result); return 0
}

const SPACE_SELECTOR_FLAGS = { '--space': 'data', '--zone': 'data', '--tab': 'data', '--region': 'data' } as const
const SPACE_DESTINATION_FLAGS = { ...SPACE_SELECTOR_FLAGS, '--new-tab': 'boolean', '--split': 'value', '--focus': 'boolean', '--request-id': 'data' } as const
function spaceSelector(flags: ParsedFlags): AgentMuxSpaceSelector {
  return Object.fromEntries(['space', 'zone', 'tab', 'region'].filter(key => flags.values.has(`--${key}`))
    .map(key => [`${key}Id`, spaceControlId(flags.values.get(`--${key}`), key, 'INVALID_CLI_ARGUMENT', key === 'space' || key === 'zone')]))
}
function useSpaceRequestId(flags: ParsedFlags): void {
  if (flags.values.has('--request-id')) CLI_REQUEST_ID = spaceControlId(flags.values.get('--request-id'), 'Request ID', 'INVALID_CLI_ARGUMENT')
}
function spaceDestination(flags: ParsedFlags): AgentMuxSpaceDestination {
  const target: AgentMuxSpaceDestination = { ...spaceSelector(flags),
    ...(flags.booleans.has('--new-tab') ? { newTab: true } : {}),
    ...(flags.values.has('--split') ? { split: flags.values.get('--split') as NonNullable<AgentMuxSpaceDestination['split']> } : {}) }
  const resources = ['--path', '--branch', '--new-branch', '--directory'].filter(key => flags.values.has(key))
  if (!flags.booleans.has('--new-zone')) {
    if (resources.length || flags.booleans.has('--worktree')) throw cliError('Zone resource options require --new-zone.')
    return target
  }
  if (flags.booleans.has('--worktree')) {
    if (flags.values.has('--directory')) throw cliError('--worktree cannot be combined with --directory.')
    const branch = exactlyOne(flags, ['--branch', '--new-branch'], 'New worktree Zone')
    target.newZone = { kind: 'worktree', path: identifier(flags.values.get('--path'), 'Worktree absolute path'),
      branch: identifier(flags.values.get(branch), 'Worktree branch'), createBranch: branch === '--new-branch' }
  } else {
    if (resources.some(key => key !== '--directory')) throw cliError('Git branch/path options require --worktree.')
    target.newZone = { kind: 'directory', path: identifier(flags.values.get('--directory'), 'Existing absolute directory') }
  }
  return target
}
async function agentCommand(args: readonly string[]): Promise<number> {
  if (args[0] !== 'open') throw cliError('agent requires open. Run agentmux agent open --help.')
  const flags = parseFlags(args.slice(1), { ...SPACE_DESTINATION_FLAGS,
    '--executor': 'data', '--session': 'data', '--prompt': 'data', '--new-zone': 'boolean', '--worktree': 'boolean',
    '--path': 'data', '--branch': 'data', '--new-branch': 'data', '--directory': 'data' })
  useSpaceRequestId(flags)
  const contentFlag = exactlyOne(flags, ['--executor', '--session'], 'agent open')
  if (contentFlag === '--session' && (flags.values.has('--prompt') || flags.booleans.has('--new-zone'))) throw cliError('--session cannot supply an initial prompt or create a Zone.')
  const request = parseSpaceControlRequest({ ...requestBase(), operation: 'agent.open',
    content: contentFlag === '--executor'
      ? { kind: 'new-agent', executorId: identifier(flags.values.get('--executor'), 'Exact Executor ID'),
        ...(flags.values.has('--prompt') ? { prompt: flags.values.get('--prompt')! } : {}) }
      : { kind: 'agent-session', agentSessionId: explicitSelectorId(flags.values.get('--session'), 'Exact Agent Session ID') },
    destination: spaceDestination(flags), focus: flags.booleans.has('--focus'),
    ...(process.env.AGENTMUX_ENV === '1' ? { caller: managedCaller() } : {})
  }, 'INVALID_CLI_ARGUMENT')
  const receipt = await requestAgentMuxControl(request)
  if (receipt.operation !== 'agent.open') throw new AgentMuxError('Agent open receipt operation is mismatched.', 'CONTROL_PROTOCOL_ERROR')
  writeJson(receipt)
  return receipt.result.outcome === 'partial' || receipt.result.outcome === 'unknown' ? 1 : 0
}
async function spaceCommand(args: readonly string[]): Promise<number> {
  const action = args[0]
  if (action !== 'ls' && action !== 'inspect' && action !== 'mv') throw cliError('space requires ls, inspect, or mv.')
  const flags = parseFlags(args.slice(1), action === 'mv'
    ? { ...SPACE_DESTINATION_FLAGS, '--from-region': 'data', '--expect-session': 'data' }
    : action === 'inspect' ? { ...SPACE_SELECTOR_FLAGS, '--request': 'data' } : { '--space': 'data', '--zone': 'data' })
  useSpaceRequestId(flags)
  const target = spaceSelector(flags)
  if (flags.values.has('--request') && Object.keys(target).length) throw cliError('--request cannot be combined with a spatial selector.')
  const request = parseSpaceControlRequest(action === 'mv'
    ? { ...requestBase(), operation: 'space.mv', fromRegionId: identifier(flags.values.get('--from-region'), 'Source Region'),
      expectedAgentSessionId: identifier(flags.values.get('--expect-session'), 'Expected Session'), destination: spaceDestination(flags), focus: flags.booleans.has('--focus') }
    : { ...requestBase(), operation: action === 'ls' ? 'space.ls' : 'space.inspect',
      target: flags.values.has('--request') ? { requestId: flags.values.get('--request')! } : target }, 'INVALID_CLI_ARGUMENT')
  const receipt = await requestAgentMuxControl(request)
  writeJson(receipt)
  if (receipt.operation === 'space.inspect' && flags.values.has('--request')) {
    const inspected = receipt.result.request
    return inspected?.known && inspected.report && inspected.report.outcome !== 'partial' && inspected.report.outcome !== 'unknown' ? 0 : 1
  }
  return receipt.operation === 'space.mv' && (receipt.result.outcome === 'partial' || receipt.result.outcome === 'unknown') ? 1 : 0
}

async function arrangeCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--tab': 'value', '--preset': 'value', '--balance': 'boolean', '--active-first': 'boolean' })
  const tab = identifier(flags.values.get('--tab'), 'Tab id')
  const selections = [
    ...(flags.values.has('--preset') ? ['--preset'] : []),
    ...(flags.booleans.has('--balance') ? ['--balance'] : []),
    ...(flags.booleans.has('--active-first') ? ['--active-first'] : [])
  ]
  if (selections.length !== 1) throw cliError('arrange requires exactly one of --preset, --balance, --active-first.')
  const preset = flags.values.get('--preset')
  if (preset !== undefined && !isWorkbenchLayoutPreset(preset)) throw cliError('Arrange preset is invalid.')
  const owner = callerForSelf(tab)
  const receipt = await requestAgentMuxControl({
    ...requestBase(),
    operation: 'arrange',
    target: tab === 'self' ? { kind: 'self' } : { kind: 'tab', tabId: explicitSelectorId(tab, 'Tab id') },
    mode: preset !== undefined
      ? { kind: 'preset', preset }
      : flags.booleans.has('--balance') ? { kind: 'balance' } : { kind: 'active-first' },
    ...(owner ? { caller: owner } : {})
  })
  printSuccess(receipt.operation, receipt.result); return 0
}

/**
 * 发起一次 Discussion：创建专属 Agent 并投递首条消息。
 *
 * 走 Core（`withClient`）而非 Control socket：消息真相归 Core，而 Control 面的 handler
 * 住在 Desktop。把账本挂到 Control 上等于让布局层拥有消息真相。
 *
 * 身份不靠 `AGENTMUX_AGENT_SESSION_ID` 自证——那只是上下文提示，改一下就能冒充。
 * raw 凭证从环境里取出交回 Core 验证，Core 据此解析 author。
 */
async function discussCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--agent': 'value', '--text': 'data', '--provider': 'value' })
  const caller = managedCaller()
  const capability = process.env.AGENTMUX_AGENT_CAPABILITY?.trim()
  if (!capability) {
    throw new AgentMuxError(
      'This command requires an AgentMux-managed Agent caller.',
      'MANAGED_AGENT_CONTEXT_REQUIRED'
    )
  }
  const executorId = identifier(flags.values.get('--agent') ?? '', 'Agent Executor id')
  const providerId = identifier(flags.values.get('--provider') ?? executorId, 'Agent Provider id')
  const body = requiredData(flags, '--text', 'Message text')
  const result = await withClient(async (client) => await client.startDiscussion({
    capability,
    callerAgentSessionId: caller.agentSessionId,
    executorId,
    providerId,
    workspacePath: process.cwd(),
    body,
    operationId: CLI_REQUEST_ID
  }))
  printSuccess('discuss', {
    threadId: result.thread.threadId,
    // 只声明证据支持的状态：启动投递最多证明 delivered。
    delivery: result.thread.delivery.state,
    targetAgentSessionId: result.session.agentSessionId
  })
  return 0
}

/** Declare a communication handoff through Core; no send, lifecycle or external Task mutation. */
async function handoffCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--to-session': 'data', '--task': 'value' })
  const caller = managedCaller()
  const capability = process.env.AGENTMUX_AGENT_CAPABILITY?.trim()
  if (!capability) {
    throw new AgentMuxError(
      'This command requires an AgentMux-managed Agent caller.',
      'MANAGED_AGENT_CONTEXT_REQUIRED'
    )
  }
  explicitSelectorId(flags.values.get('--to-session'), 'Handoff target Agent Session id')
  const taskId = identifier(flags.values.get('--task'), 'Task id')
  await normalizeSessionFlags(flags)
  const result = await withClient(async (client) => client.handOff({
    capability,
    callerAgentSessionId: caller.agentSessionId,
    toAgentSessionId: flags.values.get('--to-session')!,
    taskId
  }))
  printSuccess('handoff', {
    ownerAgentSessionId: result.ownerAgentSessionId,
    // originAwaits 恒 false 由 Core 的 handOff 决定——如实回显，不在 CLI 侧另判。
    originAwaits: result.originAwaits,
    taskId: result.taskId
  })
  return 0
}

async function deliveriesCommand(args: readonly string[]): Promise<number> {
  const verb = args[0]
  if (verb !== 'check' && verb !== 'ack') throw cliError('deliveries requires check or ack.')
  const flags = parseFlags(args.slice(1), verb === 'check'
    ? { '--limit': 'value' } : { '--generation': 'value', '--reader-run': 'value' })
  const caller = managedCaller()
  const capability = process.env.AGENTMUX_AGENT_CAPABILITY?.trim()
  if (!capability) throw new AgentMuxError('This command requires an AgentMux-managed Agent capability.', 'MANAGED_AGENT_CONTEXT_REQUIRED')
  if (verb === 'check') {
    const limit = Number(requiredData(flags, '--limit', 'Message batch limit'))
    const result = await withClient(async (client) => await client.checkDeliveries({
      capability, callerAgentSessionId: caller.agentSessionId, limit
    }))
    printSuccess('deliveries.check', result)
  } else {
    const generation = Number(requiredData(flags, '--generation', 'Message generation'))
    const readerRun = { runId: identifier(flags.values.get('--reader-run'), 'Reader Run id') }
    const result = await withClient(async (client) => await client.ackDeliveryBatch({
      capability, callerAgentSessionId: caller.agentSessionId, readerRun, generation
    }))
    printSuccess('deliveries.ack', result)
  }
  return 0
}

async function dispatchCommand(args: readonly string[]): Promise<number> {
  const verb = args[0]
  if (verb !== 'open' && verb !== 'report' && verb !== 'show') throw cliError('dispatch requires open, report or show.')
  const flags = parseFlags(args.slice(1), verb === 'report'
    ? { '--source-message': 'value', '--reply-message': 'value', '--kind': 'value' }
    : { '--source-message': 'value' })
  const caller = managedCaller()
  const capability = process.env.AGENTMUX_AGENT_CAPABILITY?.trim()
  if (!capability) throw new AgentMuxError('This command requires an AgentMux-managed Agent capability.', 'MANAGED_AGENT_CONTEXT_REQUIRED')
  const input = { capability, callerAgentSessionId: caller.agentSessionId,
    sourceMessageId: identifier(flags.values.get('--source-message'), 'Source message id') }
  if (verb === 'open') {
    printSuccess('dispatch.open', await withClient(async (client) => await client.openDispatch(input)))
  } else if (verb === 'show') {
    printSuccess('dispatch.show', await withClient(async (client) => await client.showDispatch(input)))
  } else {
    const kind = requiredData(flags, '--kind', 'Dispatch event kind')
    assertDispatchEventKind(kind)
    const replyMessageId = identifier(flags.values.get('--reply-message'), 'Reply message id')
    printSuccess('dispatch.report', await withClient(async (client) => await client.recordDispatchEvent({ ...input, replyMessageId, kind })))
  }
  return 0
}

async function sendCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--to-session': 'data', '--to-region': 'value', '--to-tab': 'value', '--text': 'data', '--message-id': 'value', '--thread': 'value', '--correlation': 'value', '--reply-to': 'value' })
  const selected = exactlyOne(flags, ['--to-session', '--to-region', '--to-tab'], 'send')
  const value = flags.values.get(selected)!
  const owner = (selected === '--to-session' && value === 'self') || process.env.AGENTMUX_ENV === '1' ? managedCaller() : undefined
  await normalizeSessionFlags(flags)
  const target = selected === '--to-session'
    ? value === 'self' ? { kind: 'self' } as const : { kind: 'agent-session', agentSessionId: identifier(flags.values.get(selected), 'Agent Session id') } as const
    : selected === '--to-region'
      ? { kind: 'region', regionId: explicitSelectorId(value, 'Region id') } as const
      : { kind: 'tab', tabId: explicitSelectorId(value, 'Tab id') } as const
  const request = requestBase()
  const body = requiredData(flags, '--text', 'Message text')
  const capability = owner ? process.env.AGENTMUX_AGENT_CAPABILITY?.trim() : undefined
  if (owner && !capability) throw new AgentMuxError('This command requires an AgentMux-managed Agent capability.', 'MANAGED_AGENT_CONTEXT_REQUIRED')
  const recipientSessionId = await (async (): Promise<string> => {
    if (target.kind === 'self') return owner!.agentSessionId
    if (target.kind === 'agent-session') return target.agentSessionId
    const inspected = target.kind === 'region'
      ? await requestAgentMuxControl({ ...request, operation: 'inspect.region', target: { kind: 'region', regionId: target.regionId } })
      : await requestAgentMuxControl({ ...request, operation: 'inspect.tab', target: { kind: 'tab', tabId: target.tabId } })
    if (inspected.operation === 'inspect.region') {
      const region = (inspected.result as { region: { kind: string; agentSessionId?: string } }).region
      if (region.kind !== 'agent' || !region.agentSessionId) throw new AgentMuxError('Target Region is not an Agent.', 'MESSAGE_TARGET_NOT_AGENT')
      return region.agentSessionId
    }
    const regions = (inspected.result as { tab: { regions: Array<{ kind: string; agentSessionId?: string }> } }).tab.regions
    const candidates = regions.filter((region) => region.kind === 'agent' && region.agentSessionId)
    if (candidates.length !== 1) throw new AgentMuxError('Target Tab does not contain exactly one Agent Session.', 'MESSAGE_TARGET_NOT_UNIQUE')
    return candidates[0]!.agentSessionId!
  })()
  const facts = owner && capability
    ? await withClient((client) => Promise.resolve({
      sender: client.authorizeAgentCaller(capability, owner.agentSessionId),
      recipient: client.agentSession(recipientSessionId)
    }))
    : null
  const recipient = { kind: 'agent-session', agentSessionId: recipientSessionId } as const
  // The established non-Agent wire branch records ingress, never proof of a human participant.
  const sender = owner ? { kind: 'agent-session', agentSessionId: owner.agentSessionId } as const : { kind: 'human', principal: 'local-cli' } as const
  const requestedMessageId = flags.values.get('--message-id')
  const messageInputBase = {
    operationId: request.requestId,
    createdAt: Date.now(),
    sender,
    recipient,
    threadId: flags.values.get('--thread') ?? requestedMessageId ?? request.requestId,
    correlationId: flags.values.get('--correlation') ?? requestedMessageId ?? request.requestId,
    replyTo: flags.values.get('--reply-to') ?? null,
    workspaceId: process.env.AGENTMUX_WORKSPACE_ID?.trim() || null,
    senderSessionId: owner?.agentSessionId ?? null,
    senderRunId: facts?.sender.run.runId ?? null,
    recipientSessionId,
    recipientRunId: facts?.recipient.run.runId ?? null,
    body
  }
  if (owner && capability) {
    await withClient((client) => Promise.resolve(client.authorizeAgentMessage({
      capability,
      callerAgentSessionId: owner.agentSessionId,
      senderAgentSessionId: sender.kind === 'agent-session' ? sender.agentSessionId : null,
      senderSessionId: messageInputBase.senderSessionId,
      senderRunId: messageInputBase.senderRunId,
      recipientSessionId: messageInputBase.recipientSessionId,
      recipientRunId: messageInputBase.recipientRunId
    })))
  }
  const messageInput: AgentMuxMessageAppendInput = requestedMessageId === undefined ? messageInputBase : { ...messageInputBase, messageId: requestedMessageId }
  const queued = await appendGlobalMessage(messageInput)
  if (queued.delivery.state === 'delivered') {
    printSuccess('send', { messageId: queued.messageId, queueId: queued.queueId, receiptId: queued.receiptId, envelope: queued.envelope, delivery: queued.delivery })
    return 0
  }
  try {
    const promptCondition = await prepareGlobalMessagePrompt(queued.messageId, async envelope => {
      if (!envelope.recipientSessionId) throw new AgentMuxError('Message has no exact recipient Session.', 'MESSAGE_RECIPIENT_MISMATCH')
      // This existing Control projection carries Core facts for every Host. A local
      // Client must not substitute its Store or Run for a remote recipient's owner.
      const active = await requestAgentMuxControl({ ...requestBase(), requestId: randomUUID(), operation: 'list.active-agents',
        agentSessionId: envelope.recipientSessionId })
      if (active.operation !== 'list.active-agents') throw new AgentMuxError('Agent Session facts are unavailable.', 'CONTROL_PROTOCOL_ERROR')
      const recipient = active.result.agents.find(agent => agent.agentSessionId === envelope.recipientSessionId)
      return validateAgentPromptCondition(recipient?.promptCondition)
    })
    const receipt = await requestAgentMuxControl({ ...request, operation: 'send', target, text: body, promptCondition,
      ...(owner && capability ? { caller: { ...owner, capability } } : {}), message: queued.envelope })
    const delivered = await recordGlobalMessageDelivery(queued.messageId, 'delivered')
    printSuccess(receipt.operation, { ...receipt.result, messageId: delivered.messageId, queueId: delivered.queueId, receiptId: delivered.receiptId, envelope: delivered.envelope, delivery: delivered.delivery })
    return 0
  } catch (error) {
    await recordGlobalMessageDeliveryIssue(queued.messageId, 'Delivery is unconfirmed: ' + (error instanceof Error ? error.message : String(error))).catch(() => {})
    throw error
  }
}
async function focusCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--region': 'value', '--tab': 'value' })
  const selected = exactlyOne(flags, ['--region', '--tab'], 'focus')
  const value = flags.values.get(selected)!
  const receipt = await requestAgentMuxControl({
    ...requestBase(), operation: 'focus',
    target: selected === '--region' ? { kind: 'region', regionId: explicitSelectorId(value, 'Region id') } : { kind: 'tab', tabId: explicitSelectorId(value, 'Tab id') }
  })
  printSuccess(receipt.operation, receipt.result); return 0
}

/**
 * 促升：把一个 Region 单独变成它自己的一张 Tab（#487）。只带 `--region <id|self>`——促升没有
 * destination（它总是新建一张 Tab），`self` 是主用例（Agent 把自己所在的那格搬成一张新 Tab）。
 * 回执带出新 Tab 的坐标，可直接喂回 focus / inspect。
 */
async function promoteCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--region': 'value' })
  const value = identifier(flags.values.get('--region'), 'Region id')
  const owner = callerForSelf(value)
  const receipt = await requestAgentMuxControl({
    ...requestBase(), operation: 'promote.region',
    target: value === 'self' ? { kind: 'self' } : { kind: 'region', regionId: explicitSelectorId(value, 'Region id') },
    ...(owner ? { caller: owner } : {})
  })
  printSuccess(receipt.operation, receipt.result); return 0
}

function afterByte(value: string | undefined): number {
  if (value === undefined) return 0
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw cliError('--after-byte must be a non-negative safe integer.')
  return parsed
}

function formatOutputBytes({ dataBytes, ...range }: FollowOutput) {
  return { ...range, dataBase64: Buffer.from(dataBytes).toString('base64') }
}

async function outputCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--session': 'data', '--after-byte': 'value', '--follow': 'boolean' })
  await normalizeSessionFlags(flags)
  const agentSessionId = sessionId(identifier(flags.values.get('--session'), 'Agent Session id'))
  const follow = flags.booleans.has('--follow')
  const requestedAfterByte = afterByte(flags.values.get('--after-byte'))
  return await withClient(async (client) => {
    const runId = client.agentSession(agentSessionId).run.runId
    let finish: ((value: { state: string; exitCode?: number; exitSignal?: string }) => void) | null = null
    const completed = new Promise<{ state: string; exitCode?: number; exitSignal?: string }>((resolve) => { finish = resolve })
    const replayOutput: FollowOutput[] = []
    const ordered = new OrderedSessionOutputFollow(runId, requestedAfterByte, (event) => {
      if (follow) printStream('output', 'output', formatOutputBytes(event))
      else replayOutput.push(event)
    }, (event) => finish?.(event))
    const unsubscribe = follow ? client.onEvent((event) => ordered.accept(event)) : () => {}
    let attached: Awaited<ReturnType<AgentMuxClient['reattachAgent']>> | null = null
    try {
      attached = await client.reattachAgent(agentSessionId, requestedAfterByte)
      if (!follow) {
        ordered.finishReplay(attached.attachment.replay)
        printSuccess('output', { session: attached.session, run: attached.attachment.run,
          replay: replayOutput.map(formatOutputBytes), gap: attached.attachment.gap })
        return 0
      }
      printStream('output', 'attached', { session: attached.session, run: attached.attachment.run, gap: attached.attachment.gap })
      ordered.finishReplay(attached.attachment.replay)
      if (attached.attachment.run.state !== 'running') { printStream('output', 'end', { runId, state: attached.attachment.run.state }); return 0 }
      const interrupted = (): void => finish?.({ state: 'reader-interrupted' })
      process.once('SIGINT', interrupted)
      try { printStream('output', 'end', { runId, ...await completed }) } finally { process.off('SIGINT', interrupted) }
      return 0
    } finally { unsubscribe(); if (attached) await client.releaseRunAttachment(attached.attachment.run) }
  })
}

async function sessionMutation(operation: 'interrupt' | 'resume' | 'stop', args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, operation === 'resume' ? { '--session': 'data', '--text': 'data' } : { '--session': 'data' })
  await normalizeSessionFlags(flags)
  const value = identifier(flags.values.get('--session'), 'Agent Session id')
  const owner = callerForSelf(value)
  const target = value === 'self' ? { kind: 'self' } as const : { kind: 'agent-session', agentSessionId: value } as const
  const receipt = operation === 'resume'
    ? await requestAgentMuxControl({
        ...requestBase(), operation, target,
        text: requiredData(flags, '--text', 'Resume text'),
        ...(owner ? { caller: owner } : {})
      })
    : operation === 'interrupt'
      ? await requestAgentMuxControl({ ...requestBase(), operation, target, ...(owner ? { caller: owner } : {}) })
      : await requestAgentMuxControl({ ...requestBase(), operation, target, ...(owner ? { caller: owner } : {}) })
  printSuccess(receipt.operation, receipt.result); return 0
}

/**
 * browser：驱动一个已经开着的 Browser，跑一段程序。
 *
 * 为什么是顶层动词而不是挂在 `open` 下面：`open browser` 是**开**一个浏览器，`browser run` 是
 * **驱动**一个已经开着的。两件事，两条命令，并存（AGENTS.md:21 也禁止为此加兼容层）。
 *
 * 程序只从 stdin 进，不提供 `--code`：一段真实的调试程序里有引号、反斜杠、换行和 `$`，走命令行
 * 参数意味着每一层 shell 都要再转义一次，写的人和读的人都会错。stdin 是原样的字节。
 */
async function browserCommand(args: readonly string[]): Promise<number> {
  if (args[0] === 'history') {
    const flags = parseFlags(args.slice(1), { '--browser': 'value' })
    const browserId = flags.values.get('--browser')
    const receipt = await requestAgentMuxControl({
      ...requestBase(),
      operation: 'browser.history',
      ...(browserId ? { browserId: explicitSelectorId(browserId, 'Browser id') } : {})
    })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  if (args[0] === 'replay') {
    const flags = parseFlags(args.slice(1), { '--browser': 'value', '--operation': 'value', '--preview': 'boolean', '--step': 'value', '--run': 'boolean' })
    const browserId = explicitSelectorId(flags.values.get('--browser'), 'Browser id')
    const operationId = identifier(flags.values.get('--operation'), 'Browser operation id')
    if (flags.booleans.has('--preview') && flags.booleans.has('--run')) throw cliError('Choose one replay mode: --preview or --run.')
    const step = flags.values.get('--step')
    // 取值合法性归协议层（control-host.ts 的 `browser.replay` 解析），这里只把 flag 的字符串转成数字。
    // 此前两处各判一遍、用不同的码拒同一个输入。`Number` 对非数字给 NaN，协议那条会拿
    // INVALID_CONTROL_REQUEST 拒掉它——与 0、负数、小数同一个码，因为对调用方是同一件事。
    const mode = flags.booleans.has('--preview') ? 'preview' : step !== undefined ? 'step' : 'run'
    const receipt = await requestAgentMuxControl({
      ...requestBase(), operation: 'browser.replay', browserId, operationId, mode,
      ...(step === undefined ? {} : { step: Number(step) }),
    })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  // 凭 operationId 停一个操作，与发起它的那条连接无关。取消的是 **operation**，不是请求：
  // 这条命令可以在另一个 shell、另一台进程、CLI 断了之后重连再跑，只要手上有 id。
  if (args[0] === 'stop') {
    const flags = parseFlags(args.slice(1), { '--operation': 'value' })
    const receipt = await requestAgentMuxControl({
      ...requestBase(),
      operation: 'browser.stop',
      operationId: identifier(flags.values.get('--operation'), 'Browser operation id')
    })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  // 问一条操作现在怎么样了。与 history 的分工是寻址方式：history 按 Browser 列（要先知道是哪个
  // Browser），这条按 operation 问（只知道 id 也够）。
  if (args[0] === 'operation') {
    const flags = parseFlags(args.slice(1), { '--operation': 'value' })
    const receipt = await requestAgentMuxControl({
      ...requestBase(),
      operation: 'browser.operation',
      operationId: identifier(flags.values.get('--operation'), 'Browser operation id')
    })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  // 跟着一条操作的进展看。这是唯一一条**一问多答**的 browser 子命令：它不打印一条回执就返回，
  // 而是先印开场帧（含缺口），再逐条印事件，直到流结束。信封与 `output --follow` 是同一份
  // （`printStream`），所以同一段解析代码能读两边。
  if (args[0] === 'follow') {
    const flags = parseFlags(args.slice(1), { '--operation': 'value', '--after-sequence': 'value' })
    const operationId = identifier(flags.values.get('--operation'), 'Browser operation id')
    const after = flags.values.get('--after-sequence')
    // 取值合法性归协议层（control-host 的 `browser.subscribe` 解析）：负数、小数、NaN 在那里
    // 用同一个码拒掉。这里只把 flag 的字符串转成数字——两处各判一遍正是它们漂移的来路。
    let finish: (() => void) | null = null
    const ended = new Promise<void>((resolve) => { finish = resolve })
    const opened = await subscribeAgentMuxControl({
      ...requestBase(), operation: 'browser.subscribe', operationId,
      ...(after === undefined ? {} : { afterSequence: Number(after) })
    }, {
      onEvent: (event) => printStream('browser.subscribe', 'progress', event),
      onEnd: () => finish?.()
    })
    // 缺口跟开场帧一起印，**不吞掉**：客户端凭它知道自己手上这份时间线不完整，可以改去读一次
    // 完整快照（`agentmux browser operation`）。印成 `gap: null` 也是一条信息——"一条不落"。
    printStream('browser.subscribe', 'attached', { runOperation: opened.runOperation, gap: opened.gap })
    // Ctrl-C 是这条命令的正常退出方式（它本来就没有自然终点，除非那个操作结束）。
    const interrupted = (): void => finish?.()
    process.once('SIGINT', interrupted)
    try { await ended } finally { process.off('SIGINT', interrupted); opened.dispose() }
    printStream('browser.subscribe', 'end', { operationId })
    return 0
  }
  if (args[0] !== 'run') throw cliError('Unknown browser command. Run agentmux browser --help.')
  const flags = parseFlags(args.slice(1), { '--browser': 'value', '--operation': 'value' })
  const browserId = explicitSelectorId(flags.values.get('--browser'), 'Browser id')
  const code = await readAllStdin()
  // 空程序不在这里判：规则住在协议层（control-host.ts 的 `browser.run` 解析），CLI 与任何直连客户端
  // 经同一条。写在这里的话只有走 CLI 的那条路被拦住，别的客户端照旧拿到一次「跑完了、什么都没发生」
  // 的成功——那个结局与真的跑完一段空程序无法区分（AGENTS.md:32-52）。协议层那句拒绝已经点了
  // 「怎么把程序喂进来」，所以这里删掉不损失可执行性。
  //
  // `--operation` 可选：给了就是「我要在它跑的时候还能查它、停它」——那个 id 在这条命令返回之前
  // 就已经对别的连接可用。不给也照样能跑，只是只能等终局回执才知道 id（那时已无可取消）。
  // 取值合法性归协议层，这里只把 flag 取出来。
  const operationId = flags.values.get('--operation')
  const receipt = await requestAgentMuxControl({
    ...requestBase(), operation: 'browser.run', browserId, code,
    ...(operationId === undefined ? {} : { operationId })
  })
  printSuccess(receipt.operation, receipt.result); return 0
}

/** 把 stdin 整段读进来。程序可能有几十 KB，逐块拼，不假设一次 read 就到底。 */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function operationPath(args: readonly string[]): string | null {
  if (args[0] === 'diagnostics' && args[1] === 'crash-log') return args[2] === 'reveal' ? 'diagnostics.crash-log.reveal' : 'diagnostics.crash-log.get'
  if (args[0] === 'settings' && args[1] === 'workspaces') {
    return args[2] === undefined || args[2].startsWith('-') ? 'settings.workspaces' : `settings.workspaces.${args[2]}`
  }
  if (args[0] === 'settings' && args[1] === 'hosts') {
    return args[2] === undefined || args[2].startsWith('-') ? 'settings.hosts' : `settings.hosts.${args[2]}`
  }
  if (args[0] === 'settings' && args[1] === 'browser') {
    if (args[2] === 'links') return args[3] === undefined || args[3].startsWith('-') ? 'settings.browser.links' : `settings.browser.links.${args[3]}`
    return args[2] === undefined || args[2].startsWith('-') ? 'settings.browser' : `settings.browser.${args[2]}`
  }
  if (args[0] === 'settings' && (args[1] === 'executors' || args[1] === 'prompts')) {
    return ['list', 'get', 'add', 'update', 'remove'].includes(args[2] ?? '') ? `settings.resource.${args[2]}`
      : args[2] === undefined || args[2].startsWith('-') ? `settings.${args[1]}` : `settings.${args[1]}.${args[2]}`
  }
  if (args[0] === 'open' && ['agent', 'terminal', 'browser'].includes(args[1] ?? '')) {
    return `${args[0]}.${args[1]}`
  }
  // browser run → browser.run。与上面 open.* 同形：两级动词的 help 路径就是它的 operation 名。
  // 不写死 'run' 是因为将来若有第二个 browser 子命令，漏改这里会让它的 --help 静默落到 'browser'
  // 那条上（拿到一份讲别的命令的帮助，而不是一句"没这个命令"）。
  if ((args[0] === 'agent' || args[0] === 'space' || args[0] === 'browser' || args[0] === 'deliveries' || args[0] === 'dispatch' || args[0] === 'settings') && (args[1] ?? '') !== '' && !args[1]!.startsWith('-')) {
    return `${args[0]}.${args[1]}`
  }
  return args[0] ?? null
}
function requestsHelp(args: readonly string[]): boolean {
  if (args[0] === 'diagnostics') {
    const tail = args.at(-1)
    return (tail === '--help' || tail === '-h') && (args.length === 2 ||
      (args[1] === 'crash-log' && (args.length === 3 || (args.length === 4 && args[2] === 'reveal'))))
  }
  if (args[0] === 'settings') {
    const help = (value: string | undefined): boolean => value === '--help' || value === '-h'
    return (args.length === 2 && help(args[1])) ||
      (args.length === 3 && args[1] === 'workspaces' && help(args[2])) ||
      (args.length === 4 && args[1] === 'workspaces' && args[2] === 'add' && help(args[3])) ||
      (args.length === 3 && args[1] === 'browser' && help(args[2])) ||
      (args.length === 3 && args[1] === 'hosts' && help(args[2])) ||
      (args.length === 4 && args[1] === 'hosts' && args[2] === 'list' && help(args[3])) ||
      (args.length === 4 && args[1] === 'browser' && args[2] === 'links' && help(args[3])) ||
      (args.length === 5 && args[1] === 'browser' && args[2] === 'links' && args[3] === 'list' && help(args[4])) ||
      (args.length === 3 && (args[1] === 'get' || args[1] === 'set' || args[1] === 'executors' || args[1] === 'prompts') && help(args[2])) ||
      (args.length === 4 && (args[1] === 'executors' || args[1] === 'prompts') && args[2] === 'list' && help(args[3])) ||
      (args.length === 4 && args[1] === 'executors' && args[2] === 'refresh' && help(args[3]))
  }
  if (args[0] === 'agent' || args[0] === 'space') {
    const data = ['--executor', '--session', '--prompt', '--space', '--zone', '--tab', '--region', '--request-id', '--request', '--from-region', '--expect-session', '--path', '--branch', '--new-branch', '--directory']
    return args.some((argument, index) => (argument === '--help' || argument === '-h') && !data.includes(args[index - 1] ?? ''))
  }
  return args.some((argument, index) => (
    (argument === '--help' || argument === '-h') &&
    args[index - 1] !== '--text' && args[index - 1] !== '--prompt' && args[index - 1] !== '--command'
  ))
}

/**
 * 启动定向握手：报出这个 Agent 自己的坐标与可用能力，让它从第一步就认识所处环境。
 *
 * 坐标不新建第二份身份来源：Session/Provider/Executor/host/Workspace/当前 Run 与可用能力全取自
 * `statusAgent(self)`——那是每个 intent 读的同一份 Session 投影。View/Region/邻居复用既有的
 * `inspect.region self`；查不到 View 不是握手失败（没投影到画布是正常态），但也不静默——把缺席
 * 的原因如实带出（`no-desktop-view` 还是 `view-unavailable` + 错误码）。Topic 不在这里产出：它的
 * 唯一真相是工作区里的 `topic.md` 与 `.agents/`，Core 复刻那套目录约定只会造出第二份会漂移的来源，
 * 因此只给一句指向文件的话（见 {@link SELF_CONTEXT_TOPIC_HINT}）。语法不抄进来——确切用法在 --skill。
 */
async function whoamiCommand(args: readonly string[]): Promise<number> {
  if (args.length > 0) throw cliError('whoami takes no arguments.')
  const self = managedCaller().agentSessionId
  const status = await withClient(async (client) => await client.statusAgent(self))
  let view: SelfViewOutcome
  try {
    const receipt = await requestAgentMuxControl({
      ...requestBase(), operation: 'inspect.region', target: { kind: 'self' }, caller: { agentSessionId: self }
    })
    // 收窄到 inspect.region 那一枝：requestAgentMuxControl 的返回是所有 operation 的联合。
    view = receipt.operation === 'inspect.region'
      ? { attached: true, region: receipt.result.region }
      : classifySelfViewFailure(new AgentMuxError('Control returned an unexpected operation for whoami.', 'CONTROL_PROTOCOL_ERROR'))
  } catch (error) {
    view = classifySelfViewFailure(error)
  }
  printSuccess('whoami', {
    session: status.session,
    run: status.run,
    capabilities: status.capabilities,
    view,
    topic: { present: false, hint: SELF_CONTEXT_TOPIC_HINT }
  })
  return 0
}

/**
 * 诊断当前本地运行时。这是 doctor 报告唯一的用户可达入口——报告里 endpoint 目录占用与回收结果这两
 * 段，若没有这个命令就等于算了没人看：占用只能等磁盘告警才发现，回收失败则完全无声。
 */
async function doctorCommand(args: readonly string[]): Promise<number> {
  if (args.length > 0) throw cliError('doctor takes no arguments.')
  const { AgentMuxClient } = await import('./client.js')
  const client = new AgentMuxClient()
  try {
    printSuccess('doctor', await diagnoseAgentMux({ client, workspacePath: process.cwd(),
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) }))
  } finally {
    await client.dispose()
  }
  return 0
}

/**
 * 报出控制端点的位置与协议版本，好让一个非 Node 客户端**不必读我们的 TS 源码复算哈希**就能连上。
 *
 * 这条**不是**协议操作，是本地只读动词。原因是个绕不开的循环：要问协议"端点在哪"，先得连上端点。
 * 所以它只做两件事——把路径与版本从既有出口取出来印出来。
 *
 * `defaultAgentMuxControlSocketPath()` 是路径的唯一出口（control-host 的 server 与两个客户端函数
 * 都默认取它）。这里**调它**而不是重算一遍 `join(runtimeDir, 'control.sock')`：重算出来的第二份
 * 在今天与它一致，于是没有任何测试能分辨两者——直到有一天文件名改了，而这条发现能力还在报旧的。
 *
 * **不连接**。daemon 没起也照样作答：外部客户端正是要在连接之前知道往哪连。所以这里不报"活着吗"
 * ——那是 `doctor` 的事，而且把两件事混在一起会让"现在没人监听"看起来像"没有这个端点"。
 */
async function endpointCommand(args: readonly string[]): Promise<number> {
  if (args.length > 0) throw cliError('endpoint takes no arguments.')
  printSuccess('endpoint', {
    control: { transport: 'unix-socket', framing: 'ndjson', path: defaultAgentMuxControlSocketPath() },
    schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION
  })
  return 0
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') { process.stdout.write(`${AGENTMUX_CLI_HELP}\n`); return 0 }
  if (args.length === 1 && args[0] === '--skill') { process.stdout.write(`${AGENTMUX_CLI_SKILL}\n`); return 0 }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) { process.stdout.write(`agentmux ${VERSION}\n`); return 0 }
  if (requestsHelp(args)) {
    const help = agentMuxCommandHelp(operationPath(args) ?? '')
    if (!help) throw cliError('Unknown command. Run agentmux --help.')
    process.stdout.write(`${help}\n`); return 0
  }
  if (args[0] === AGENTMUX_SELF_CONTEXT_VERB) return await whoamiCommand(args.slice(1))
  if (args[0] === 'doctor') return await doctorCommand(args.slice(1))
  if (args[0] === 'endpoint') return await endpointCommand(args.slice(1))
  if (args[0] === 'inspect') return await inspectCommand(args.slice(1))
  if (args[0] === 'list') return await listCommand(args.slice(1))
  if (args[0] === 'diagnostics') {
    if (args[1] !== 'crash-log' || (args.length !== 2 && !(args.length === 3 && args[2] === 'reveal'))) {
      throw cliError('Run agentmux diagnostics --help for fixed crash-log diagnostics.')
    }
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: args[2] === 'reveal' ? 'diagnostics.crash-log.reveal' : 'diagnostics.crash-log.get' })
    printSuccess(receipt.operation, receipt.result); return 0
  }
  if (args[0] === 'settings') {
    const request = { ...requestBase(), ...await parseSettingsCommand(args.slice(1)) }
    settingsResourceBudget(request, 'INVALID_CLI_ARGUMENT')
    const receipt = await requestAgentMuxControl(request)
    printSuccess(receipt.operation, receipt.result); return 0
  }
  if (args[0] === 'pmo') return await pmoCommand(args.slice(1))
  if (args[0] === 'demand') return await demandCommand(args.slice(1))
  if (args[0] === 'roles') return await roleCommand(args.slice(1))
  if (args[0] === 'agent') return await agentCommand(args.slice(1))
  if (args[0] === 'space') return await spaceCommand(args.slice(1))
  if (args[0] === 'open') return await openCommand(args.slice(1))
  if (args[0] === 'browser') return await browserCommand(args.slice(1))
  if (args[0] === 'send') return await sendCommand(args.slice(1))
  if (args[0] === 'deliveries') return await deliveriesCommand(args.slice(1))
  if (args[0] === 'dispatch') return await dispatchCommand(args.slice(1))
  if (args[0] === 'discuss') return await discussCommand(args.slice(1))
  if (args[0] === 'handoff') return await handoffCommand(args.slice(1))
  if (args[0] === 'focus') return await focusCommand(args.slice(1))
  if (args[0] === 'promote') return await promoteCommand(args.slice(1))
  if (args[0] === 'arrange') return await arrangeCommand(args.slice(1))
  if (args[0] === 'output') return await outputCommand(args.slice(1))
  if (args[0] === 'interrupt') return await sessionMutation('interrupt', args.slice(1))
  if (args[0] === 'resume') return await sessionMutation('resume', args.slice(1))
  if (args[0] === 'stop') return await sessionMutation('stop', args.slice(1))
  throw cliError('Unknown command. Run agentmux --help.')
}

const attemptedOperation = operationPath(process.argv.slice(2))
void main().then((exitCode) => { process.exitCode = exitCode }, (error) => {
  const source = typeof error === 'object' && error !== null ? error as Record<string, unknown> : null
  const code = cliErrorCode(source?.code)
  const candidates = typeof error === 'object' && error !== null && 'candidates' in error ? error.candidates : undefined
  writeJson({
    schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: typeof source?.requestId === 'string' ? source.requestId : CLI_REQUEST_ID,
    ok: false,
    operation: typeof source?.operation === 'string' ? source.operation : attemptedOperation,
    error: { code, message: error instanceof Error ? error.message : String(error), ...(candidates ? { candidates } : {}) }
  }, process.stderr)
  process.exitCode = 1
})
