#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import packageManifest from '../package.json' with { type: 'json' }
import type { AgentMuxAgentSessionLookup } from './agent-session-registry.js'
import { classifySelfViewFailure, SELF_CONTEXT_TOPIC_HINT, type SelfViewOutcome } from './agent-self-context.js'
import { AGENTMUX_CLI_HELP, AGENTMUX_CLI_SKILL, AGENTMUX_SELF_CONTEXT_VERB, agentMuxCommandHelp } from './agentmux-cli-help.js'
import { AgentMuxClient } from './client.js'
import {
  AGENTMUX_CONTROL_ERROR_CODES,
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlCaller,
  type AgentMuxOpenDestination
} from './control.js'
import { requestAgentMuxControl } from './control-host.js'
import { diagnoseAgentMux } from './doctor.js'
import { AgentMuxError } from './errors.js'
import { connectLocalAgentMux } from './runtime-client.js'
import { OrderedSessionOutputFollow } from './session-output-follow.js'
import { isWorkbenchLayoutPreset } from './workbench-layout-preset.js'

// 版本号的唯一真相是 package.json 的 `version`——那是 npm 发布、也是用户 `--version` 应当与之一致的
// 那个字段。这里用 `with { type: 'json' }` 直接引用它，而不是手抄一份常量：tsc 在 NodeNext 下把
// package.json 拉进程序（`resolveJsonModule`），JSON import 原样出到 dist，运行时由 Node 解析同一份
// 文件。所以这不是「构建图之外的手抄常量」——改 package.json 的 version，编译产物与 `--version` 一起变。
const VERSION = packageManifest.version
const CLI_REQUEST_ID = randomUUID()
const CLI_ERROR_CODES = [
  ...AGENTMUX_CONTROL_ERROR_CODES,
  'INVALID_CLI_ARGUMENT',
  'MANAGED_AGENT_CONTEXT_REQUIRED',
  'AGENTMUX_FAILED'
] as const
type CliErrorCode = typeof CLI_ERROR_CODES[number]
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
function requestBase() { return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: CLI_REQUEST_ID } as const }
function writeJson(value: unknown, stream: NodeJS.WritableStream = process.stdout): void { stream.write(`${JSON.stringify(value)}\n`) }
function printSuccess(operation: string, result: unknown): void {
  writeJson({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: CLI_REQUEST_ID, ok: true, operation, result })
}
function printStream(operation: string, event: string, result: unknown): void {
  writeJson({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: CLI_REQUEST_ID, ok: true, operation, event, result })
}

async function withClient<T>(operation: (client: AgentMuxClient) => Promise<T>): Promise<T> {
  const client = await connectLocalAgentMux()
  try { return await operation(client) } finally { await client.dispose() }
}

async function inspectCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, {
    '--session': 'value', '--run': 'value', '--tab': 'value', '--region': 'value',
    '--provider-native': 'value', '--provider': 'value', '--acp-native': 'value', '--adapter': 'value'
  })
  const selector = exactlyOne(flags, ['--session', '--run', '--tab', '--region', '--provider-native', '--acp-native'], 'inspect')
  if ((selector === '--provider-native') !== flags.values.has('--provider')) {
    throw cliError('--provider-native and --provider must be used together.')
  }
  if ((selector === '--acp-native') !== flags.values.has('--adapter')) {
    throw cliError('--acp-native and --adapter must be used together.')
  }
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

async function listCommand(args: readonly string[]): Promise<number> {
  if (args[0] !== 'agents' && args[0] !== 'sessions') throw cliError('list requires agents or sessions.')
  parseFlags(args.slice(1), {})
  if (args[0] === 'agents') {
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'list.agents' })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  return await withClient(async (client) => {
    const sessions = await Promise.all(client.agentSessions().map(async (session) => await client.statusAgent(session.agentSessionId)))
    printSuccess('list.sessions', { sessions }); return 0
  })
}

function openDestination(flags: ParsedFlags): { destination: AgentMuxOpenDestination; caller?: AgentMuxControlCaller } {
  const selected = exactlyOne(flags, ['--left-of', '--right-of', '--above', '--below', '--new-tab-after', '--in-region'], 'open')
  const value = flags.values.get(selected)!
  const owner = callerForSelf(value)
  if (selected === '--new-tab-after') return { destination: { kind: 'new-tab', after: value === 'self' ? { kind: 'self' } : { kind: 'tab', tabId: explicitSelectorId(value, 'Tab id') } }, ...(owner ? { caller: owner } : {}) }
  if (selected === '--in-region') return { destination: { kind: 'launcher', regionId: explicitSelectorId(value, 'Launcher Region id') } }
  const direction = selected === '--left-of' ? 'left' : selected === '--right-of' ? 'right' : selected === '--above' ? 'up' : 'down'
  return { destination: { kind: 'split', direction, region: value === 'self' ? { kind: 'self' } : { kind: 'region', regionId: explicitSelectorId(value, 'Region id') } }, ...(owner ? { caller: owner } : {}) }
}

async function openCommand(args: readonly string[]): Promise<number> {
  if (args[0] !== 'agent' && args[0] !== 'terminal' && args[0] !== 'browser') {
    throw cliError('open requires agent, terminal, or browser.')
  }
  const flags = parseFlags(args.slice(1), {
    '--agent': 'value', '--session': 'value', '--prompt': 'data',
    '--command': 'data', '--url': 'value',
    '--left-of': 'value', '--right-of': 'value', '--above': 'value', '--below': 'value',
    '--new-tab-after': 'value', '--in-region': 'value'
  })
  const placement = openDestination(flags)
  if (args[0] === 'terminal') {
    if (flags.values.has('--agent') || flags.values.has('--session') || flags.values.has('--prompt') || flags.values.has('--url')) {
      throw cliError('open terminal accepts only --command and one destination.')
    }
    const receipt = await requestAgentMuxControl({
      ...requestBase(),
      operation: 'open.terminal',
      ...(flags.values.has('--command') ? { shellCommand: flags.values.get('--command')! } : {}),
      ...placement
    })
    printSuccess(receipt.operation, receipt.result); return 0
  }
  if (args[0] === 'browser') {
    if (flags.values.has('--agent') || flags.values.has('--session') || flags.values.has('--prompt') || flags.values.has('--command')) {
      throw cliError('open browser accepts only --url and one destination.')
    }
    const receipt = await requestAgentMuxControl({
      ...requestBase(),
      operation: 'open.browser',
      url: identifier(flags.values.get('--url'), 'Browser URL'),
      ...placement
    })
    printSuccess(receipt.operation, receipt.result); return 0
  }
  if (flags.values.has('--command') || flags.values.has('--url')) {
    throw cliError('open agent accepts only --agent/--session, --prompt, and one destination.')
  }
  const contentFlag = exactlyOne(flags, ['--agent', '--session'], 'open agent')
  if (contentFlag === '--session' && flags.values.has('--prompt')) throw cliError('--prompt is valid only with --agent.')
  const receipt = await requestAgentMuxControl({
    ...requestBase(), operation: 'open.agent',
    content: contentFlag === '--agent'
      ? { kind: 'new-agent', executorId: identifier(flags.values.get(contentFlag), 'Agent Executor id'), ...(flags.values.has('--prompt') ? { prompt: flags.values.get('--prompt')! } : {}) }
      : { kind: 'agent-session', agentSessionId: explicitSelectorId(flags.values.get(contentFlag), 'Agent Session id') },
    ...placement
  })
  printSuccess(receipt.operation, receipt.result); return 0
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

/**
 * 交出去（Handoff）：把一个任务连同所有权原子地交给另一个 Agent Session。
 *
 * 走 Core（`withClient`）而非 Control socket——所有权转移是通信事实，归 Core；它也因此不依赖
 * Desktop Host 活着。CLI 只把既有的 `client.handOff` 接上，不在这一侧重实现所有权转移：Handoff
 * 与 Dispatch 的唯一分界（`originAwaits`）留在 Core，CLI 连这个值都不复述，如实回显 Core 给的。
 *
 * 身份同 discuss：raw 凭证从环境取出交回 Core 验证，`AGENTMUX_AGENT_SESSION_ID` 只是上下文提示。
 * 目标用 `--to-session <session-id>`（复用 CLI 既有寻址词汇），必须是显式 id——交给"自己"没有意义，
 * 故不接受 self。handoff 只转移所有权，不投递消息、不开 Session：要送文本走 send/discuss。
 */
async function handoffCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--to-session': 'value', '--task': 'value' })
  const caller = managedCaller()
  const capability = process.env.AGENTMUX_AGENT_CAPABILITY?.trim()
  if (!capability) {
    throw new AgentMuxError(
      'This command requires an AgentMux-managed Agent caller.',
      'MANAGED_AGENT_CONTEXT_REQUIRED'
    )
  }
  const toAgentSessionId = explicitSelectorId(flags.values.get('--to-session'), 'Handoff target Agent Session id')
  const taskId = identifier(flags.values.get('--task'), 'Task id')
  const result = await withClient(async (client) => client.handOff({
    capability,
    callerAgentSessionId: caller.agentSessionId,
    toAgentSessionId,
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

async function sendCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--to-session': 'value', '--to-region': 'value', '--to-tab': 'value', '--text': 'data' })
  const selected = exactlyOne(flags, ['--to-session', '--to-region', '--to-tab'], 'send')
  const value = flags.values.get(selected)!
  const owner = selected === '--to-session' ? callerForSelf(value) : undefined
  const target = selected === '--to-session'
    ? value === 'self' ? { kind: 'self' } as const : { kind: 'agent-session', agentSessionId: identifier(value, 'Agent Session id') } as const
    : selected === '--to-region'
      ? { kind: 'region', regionId: explicitSelectorId(value, 'Region id') } as const
      : { kind: 'tab', tabId: explicitSelectorId(value, 'Tab id') } as const
  const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'send', target, text: requiredData(flags, '--text', 'Message text'), ...(owner ? { caller: owner } : {}) })
  printSuccess(receipt.operation, receipt.result); return 0
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

function afterByte(value: string | undefined): number {
  if (value === undefined) return 0
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw cliError('--after-byte must be a non-negative safe integer.')
  return parsed
}

async function outputCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--session': 'value', '--after-byte': 'value', '--follow': 'boolean' })
  const agentSessionId = sessionId(identifier(flags.values.get('--session'), 'Agent Session id'))
  const follow = flags.booleans.has('--follow')
  const requestedAfterByte = afterByte(flags.values.get('--after-byte'))
  return await withClient(async (client) => {
    const runId = client.agentSession(agentSessionId).run.runId
    let finish: ((value: { state: string; exitCode?: number; exitSignal?: string }) => void) | null = null
    const completed = new Promise<{ state: string; exitCode?: number; exitSignal?: string }>((resolve) => { finish = resolve })
    const ordered = new OrderedSessionOutputFollow(runId, requestedAfterByte, (event) => printStream('output', 'output', { runId: event.runId, replay: event.replay, startByte: event.startByte, endByte: event.endByte, data: event.data }), (event) => finish?.(event))
    const unsubscribe = follow ? client.onEvent((event) => ordered.accept(event)) : () => {}
    let attached: Awaited<ReturnType<AgentMuxClient['reattachAgent']>> | null = null
    try {
      attached = await client.reattachAgent(agentSessionId, requestedAfterByte)
      if (!follow) { printSuccess('output', { session: attached.session, run: attached.attachment.run, replay: attached.attachment.replay, gap: attached.attachment.gap }); return 0 }
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
  const flags = parseFlags(args, operation === 'resume' ? { '--session': 'value', '--text': 'data' } : { '--session': 'value' })
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

function operationPath(args: readonly string[]): string | null {
  if (args[0] === 'open' && ['agent', 'terminal', 'browser'].includes(args[1] ?? '')) {
    return `${args[0]}.${args[1]}`
  }
  return args[0] ?? null
}
function requestsHelp(args: readonly string[]): boolean {
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
  const client = await connectLocalAgentMux()
  try {
    printSuccess('doctor', await diagnoseAgentMux({ client }))
  } finally {
    await client.dispose()
  }
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
  if (args[0] === 'inspect') return await inspectCommand(args.slice(1))
  if (args[0] === 'list') return await listCommand(args.slice(1))
  if (args[0] === 'open') return await openCommand(args.slice(1))
  if (args[0] === 'send') return await sendCommand(args.slice(1))
  if (args[0] === 'discuss') return await discussCommand(args.slice(1))
  if (args[0] === 'handoff') return await handoffCommand(args.slice(1))
  if (args[0] === 'focus') return await focusCommand(args.slice(1))
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
