import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
  AGENTMUX_CONTROL_ERROR_CODES,
  AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS,
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  agentMuxControlTimeoutMs,
  isAgentMuxControlOperation,
  isAgentMuxExecutorAvailability,
  type AgentMuxAgentRegion,
  type AgentMuxArrangeMode,
  type AgentMuxBrowserRegion,
  type AgentMuxControlHost,
  type AgentMuxControlErrorReceipt,
  type AgentMuxControlErrorCode,
  type AgentMuxControlExecutor,
  type AgentMuxControlReceipt,
  type AgentMuxControlRequest,
  type AgentMuxControlResult,
  type AgentMuxControlSuccessReceipt,
  type AgentMuxInspectedRegion,
  type AgentMuxMessageTarget,
  type AgentMuxOpenDestination,
  type AgentMuxRegion,
  type AgentMuxRegionAnchor,
  type AgentMuxRegionNeighbor,
  type AgentMuxRegionNeighbors,
  type AgentMuxTabAnchor,
  type AgentMuxTerminalRegion
} from './control.js'
import { AgentMuxError } from './errors.js'
import { defaultAgentMuxControlSocketPath } from './runtime-paths.js'
import { probeSocketLiveness } from './socket-liveness.js'
import { isWorkbenchLayoutPreset } from './workbench-layout-preset.js'
import { isSplitDirection } from './split-direction-ssot.js'

const MAX_MESSAGE_BYTES = 256 * 1024
const MAX_ID_BYTES = 512
const MAX_TAB_REGIONS = 64
const MAX_EXECUTORS = 128

function object(value: unknown, message: string, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError(message, code)
  return value as Record<string, unknown>
}

function id(value: unknown, message: string, code: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_ID_BYTES || /[\0\r\n]/u.test(value)) {
    throw new AgentMuxError(message, code)
  }
  return value
}

function identity(value: unknown, message: string, code: string): string {
  const result = id(value, message, code)
  if (result === 'self') throw new AgentMuxError(message, code)
  return result
}

function text(value: unknown, label: string, code = 'INVALID_CONTROL_REQUEST'): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_MESSAGE_BYTES) {
    throw new AgentMuxError(`${label} is invalid.`, code)
  }
  return value
}

function caller(value: unknown): { agentSessionId: string } {
  const source = object(value, 'Control caller is invalid.', 'INVALID_CONTROL_REQUEST')
  return { agentSessionId: identity(source.agentSessionId, 'Control caller is invalid.', 'INVALID_CONTROL_REQUEST') }
}

function optionalCaller(value: unknown): { agentSessionId: string } | undefined {
  return value === undefined ? undefined : caller(value)
}

function regionAnchor(value: unknown): AgentMuxRegionAnchor {
  const source = object(value, 'Region anchor is invalid.', 'INVALID_CONTROL_REQUEST')
  if (source.kind === 'self') return { kind: 'self' }
  if (source.kind === 'region') return { kind: source.kind, regionId: identity(source.regionId, 'Region anchor is invalid.', 'INVALID_CONTROL_REQUEST') }
  throw new AgentMuxError('Region anchor is invalid.', 'INVALID_CONTROL_REQUEST')
}

function tabAnchor(value: unknown): AgentMuxTabAnchor {
  const source = object(value, 'Tab anchor is invalid.', 'INVALID_CONTROL_REQUEST')
  if (source.kind === 'self') return { kind: 'self' }
  if (source.kind === 'tab') return { kind: source.kind, tabId: identity(source.tabId, 'Tab anchor is invalid.', 'INVALID_CONTROL_REQUEST') }
  throw new AgentMuxError('Tab anchor is invalid.', 'INVALID_CONTROL_REQUEST')
}

function messageTarget(value: unknown): AgentMuxMessageTarget {
  const source = object(value, 'Message target is invalid.', 'INVALID_CONTROL_REQUEST')
  if (source.kind === 'self') return { kind: source.kind }
  if (source.kind === 'agent-session') return { kind: source.kind, agentSessionId: identity(source.agentSessionId, 'Message target is invalid.', 'INVALID_CONTROL_REQUEST') }
  if (source.kind === 'tab') return { kind: source.kind, tabId: identity(source.tabId, 'Message target is invalid.', 'INVALID_CONTROL_REQUEST') }
  if (source.kind === 'region') return { kind: source.kind, regionId: identity(source.regionId, 'Message target is invalid.', 'INVALID_CONTROL_REQUEST') }
  throw new AgentMuxError('Message target is invalid.', 'INVALID_CONTROL_REQUEST')
}

function sessionSelector(value: unknown): { kind: 'self' } | { kind: 'agent-session'; agentSessionId: string } {
  const source = object(value, 'Agent Session target is invalid.', 'INVALID_CONTROL_REQUEST')
  if (source.kind === 'self') return { kind: source.kind }
  if (source.kind === 'agent-session') {
    return {
      kind: source.kind,
      agentSessionId: identity(source.agentSessionId, 'Agent Session target is invalid.', 'INVALID_CONTROL_REQUEST')
    }
  }
  throw new AgentMuxError('Agent Session target is invalid.', 'INVALID_CONTROL_REQUEST')
}

function openDestination(value: unknown): AgentMuxOpenDestination {
  const source = object(value, 'Open destination is invalid.', 'INVALID_CONTROL_REQUEST')
  // 方向的合法性从 SPLIT_DIRECTIONS 派生（isSplitDirection），不再内联 `['left','right','up','down']`——
  // 那份手抄删一档不报错、无红测试（审计实测删 'up' 后 1203 条全绿）。谓词一并把 direction 收窄成
  // SplitDirection，省掉下面的 `as`。
  if (source.kind === 'split' && typeof source.direction === 'string' && isSplitDirection(source.direction)) {
    return { kind: source.kind, region: regionAnchor(source.region), direction: source.direction }
  }
  if (source.kind === 'new-tab') return { kind: source.kind, after: tabAnchor(source.after) }
  if (source.kind === 'launcher') return { kind: source.kind, regionId: identity(source.regionId, 'Open destination is invalid.', 'INVALID_CONTROL_REQUEST') }
  throw new AgentMuxError('Open destination is invalid.', 'INVALID_CONTROL_REQUEST')
}

function destinationUsesSelf(value: AgentMuxOpenDestination): boolean {
  return (value.kind === 'split' && value.region.kind === 'self') || (value.kind === 'new-tab' && value.after.kind === 'self')
}

function arrangeMode(value: unknown): AgentMuxArrangeMode {
  const source = object(value, 'Arrange mode is invalid.', 'INVALID_CONTROL_REQUEST')
  const preset = String(source.preset)
  if (source.kind === 'preset' && isWorkbenchLayoutPreset(preset)) {
    return { kind: source.kind, preset }
  }
  if (source.kind === 'balance' || source.kind === 'active-first') return { kind: source.kind }
  throw new AgentMuxError('Arrange mode is invalid.', 'INVALID_CONTROL_REQUEST')
}

export function parseAgentMuxControlRequest(value: unknown): AgentMuxControlRequest {
  const source = object(value, 'Control request is invalid.', 'INVALID_CONTROL_REQUEST')
  if (source.schemaVersion !== AGENTMUX_CONTROL_SCHEMA_VERSION) throw new AgentMuxError('Control request version is invalid.', 'INVALID_CONTROL_REQUEST')
  const requestId = id(source.requestId, 'Control request ID is invalid.', 'INVALID_CONTROL_REQUEST')
  if (!isAgentMuxControlOperation(source.operation)) throw new AgentMuxError('Control operation is invalid.', 'INVALID_CONTROL_REQUEST')
  if (source.operation === 'inspect.tab') {
    const target = tabAnchor(source.target)
    const owner = optionalCaller(source.caller)
    if (target.kind === 'self' && !owner) throw new AgentMuxError('A self target requires a managed caller.', 'INVALID_CONTROL_REQUEST')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, target, ...(owner ? { caller: owner } : {}) }
  }
  if (source.operation === 'inspect.region') {
    const target = regionAnchor(source.target)
    const owner = optionalCaller(source.caller)
    if (target.kind === 'self' && !owner) throw new AgentMuxError('A self target requires a managed caller.', 'INVALID_CONTROL_REQUEST')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, target, ...(owner ? { caller: owner } : {}) }
  }
  if (source.operation === 'promote.region') {
    const target = regionAnchor(source.target)
    const owner = optionalCaller(source.caller)
    if (target.kind === 'self' && !owner) throw new AgentMuxError('A self target requires a managed caller.', 'INVALID_CONTROL_REQUEST')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, target, ...(owner ? { caller: owner } : {}) }
  }
  if (source.operation === 'open.agent') {
    const contentSource = object(source.content, 'Agent open content is invalid.', 'INVALID_CONTROL_REQUEST')
    const content = contentSource.kind === 'new-agent'
      ? {
          kind: contentSource.kind,
          executorId: id(contentSource.executorId, 'Agent Executor is invalid.', 'INVALID_CONTROL_REQUEST'),
          ...(contentSource.prompt === undefined ? {} : { prompt: text(contentSource.prompt, 'Agent prompt') })
        } as const
      : contentSource.kind === 'agent-session'
        ? { kind: contentSource.kind, agentSessionId: identity(contentSource.agentSessionId, 'Agent Session target is invalid.', 'INVALID_CONTROL_REQUEST') } as const
        : (() => { throw new AgentMuxError('Agent open content is invalid.', 'INVALID_CONTROL_REQUEST') })()
    const destination = openDestination(source.destination)
    const owner = optionalCaller(source.caller)
    if (destinationUsesSelf(destination) && !owner) throw new AgentMuxError('A self destination requires a managed caller.', 'INVALID_CONTROL_REQUEST')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, content, destination, ...(owner ? { caller: owner } : {}) }
  }
  if (source.operation === 'open.terminal' || source.operation === 'open.browser') {
    const destination = openDestination(source.destination)
    const owner = optionalCaller(source.caller)
    if (destinationUsesSelf(destination) && !owner) throw new AgentMuxError('A self destination requires a managed caller.', 'INVALID_CONTROL_REQUEST')
    return source.operation === 'open.terminal'
      ? {
          schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
          requestId,
          operation: source.operation,
          ...(source.shellCommand === undefined ? {} : { shellCommand: text(source.shellCommand, 'Terminal shell command') }),
          destination,
          ...(owner ? { caller: owner } : {})
        }
      : {
          schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
          requestId,
          operation: source.operation,
          url: text(source.url, 'Browser URL'),
          destination,
          ...(owner ? { caller: owner } : {})
        }
  }
  if (source.operation === 'send') {
    const target = messageTarget(source.target)
    const owner = optionalCaller(source.caller)
    if (target.kind === 'self' && !owner) throw new AgentMuxError('A self target requires a managed caller.', 'INVALID_CONTROL_REQUEST')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, target, text: text(source.text, 'Message text'), ...(owner ? { caller: owner } : {}) }
  }
  if (source.operation === 'list.agents') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation }
  }
  if (source.operation === 'arrange') {
    const target = tabAnchor(source.target)
    const owner = optionalCaller(source.caller)
    if (target.kind === 'self' && !owner) throw new AgentMuxError('A self target requires a managed caller.', 'INVALID_CONTROL_REQUEST')
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      operation: source.operation,
      target,
      mode: arrangeMode(source.mode),
      ...(owner ? { caller: owner } : {})
    }
  }
  if (source.operation === 'interrupt' || source.operation === 'resume' || source.operation === 'stop') {
    const target = sessionSelector(source.target)
    const owner = optionalCaller(source.caller)
    if (target.kind === 'self' && !owner) throw new AgentMuxError('A self target requires a managed caller.', 'INVALID_CONTROL_REQUEST')
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      operation: source.operation,
      target,
      ...(source.operation === 'resume' ? { text: text(source.text, 'Resume text') } : {}),
      ...(owner ? { caller: owner } : {})
    } as AgentMuxControlRequest
  }
  if (source.operation === 'focus') {
    const targetSource = object(source.target, 'Focus target is invalid.', 'INVALID_CONTROL_REQUEST')
    const target = targetSource.kind === 'tab'
      ? { kind: targetSource.kind, tabId: identity(targetSource.tabId, 'Focus target is invalid.', 'INVALID_CONTROL_REQUEST') } as const
      : targetSource.kind === 'region'
        ? { kind: targetSource.kind, regionId: identity(targetSource.regionId, 'Focus target is invalid.', 'INVALID_CONTROL_REQUEST') } as const
        : (() => { throw new AgentMuxError('Focus target is invalid.', 'INVALID_CONTROL_REQUEST') })()
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: 'focus', target }
  }
  // 穷尽出口。此前 focus 是这条 if 链**没有条件的尾巴**，于是第 14 个操作（已过 membership 闸，因为它
  // 在联合里）会一路落到这里，被当成 focus 解析——回执里的 operation 被静默改写成 'focus'，调用方收到
  // 一份它没请求过的操作的回执。实测过：临时加一个 `probe.fake`（类型 + 联合臂 + 预算键，不加解析臂），
  // core tsc 只在两处**测试锚点**报 TS2741，生产代码一行不报，而
  // `parseAgentMuxControlRequest({operation:'probe.fake', target:{kind:'tab',tabId:'tab-1'}})`
  // 返回 `{"operation":"focus","target":{"kind":"tab","tabId":"tab-1"}}`。
  // 换成 `never` 参数后，同样的遗漏在**生产代码**里就是 TS2345，作者当场就得处理。
  return assertUnhandledOperation(source.operation)
}

/**
 * 控制请求解析的穷尽出口。参数是 `never`：上面的 if 链收窄完所有操作后，能走到这里的只剩空集；
 * 一旦联合多出一个没被处理的成员，它就不是 `never` 了，调用点 TS2345。
 * 运行时的 throw 是兜底——今天不可达，但线上收到一份类型之外的请求时，响亮失败好过静默当成别的操作。
 */
function assertUnhandledOperation(operation: never): never {
  throw new AgentMuxError(`Control operation is not handled: ${String(operation)}`, 'INVALID_CONTROL_REQUEST')
}

function normalized(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new AgentMuxError('Control Region bounds are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value
}

/**
 * 方向邻居的线上解析。
 *
 * 三种 kind 各自只带自己那一个地址字段，多余的字段一律不透传——邻居答案会被 Agent 直接当作
 * 地址喂回 focus/send，放行未经校验的字段等于放行一个没人验证过的寻址目标。
 */
function parseNeighbor(value: unknown): AgentMuxRegionNeighbor {
  const source = object(value, 'Control Region neighbors are invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (source.kind === 'none') return { kind: 'none' }
  if (source.kind === 'region') return { kind: 'region', regionId: identity(source.regionId, 'Control Region neighbors are invalid.', 'CONTROL_PROTOCOL_ERROR') }
  if (source.kind === 'tab') return { kind: 'tab', tabId: identity(source.tabId, 'Control Region neighbors are invalid.', 'CONTROL_PROTOCOL_ERROR') }
  throw new AgentMuxError('Control Region neighbors are invalid.', 'CONTROL_PROTOCOL_ERROR')
}

function parseNeighbors(value: unknown): AgentMuxRegionNeighbors {
  const source = object(value, 'Control Region neighbors are invalid.', 'CONTROL_PROTOCOL_ERROR')
  const neighbors = {
    left: parseNeighbor(source.left),
    right: parseNeighbor(source.right),
    up: parseNeighbor(source.up),
    down: parseNeighbor(source.down)
  }
  // up/down 落到 Tab 是**语义错误**而不是取值错误：Tab 条没有上下。放行它，Agent 会以为
  // 自己拿到了上方的东西，实际拿到的是左邻那张，且无从发现自己被骗。
  if (neighbors.up.kind === 'tab' || neighbors.down.kind === 'tab') throw new AgentMuxError('Control Region neighbors are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return neighbors
}

function parseRegion(value: unknown, inspected: true): AgentMuxInspectedRegion
function parseRegion(value: unknown, inspected?: false): AgentMuxRegion
function parseRegion(value: unknown, inspected = false): AgentMuxRegion | AgentMuxInspectedRegion {
  const source = object(value, 'Control Region result is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const base = {
    tabId: identity(source.tabId, 'Control Region result is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    regionId: identity(source.regionId, 'Control Region result is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    workspaceId: id(source.workspaceId, 'Control Region result is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  const region: AgentMuxRegion = source.kind === 'agent'
    ? { ...base, kind: source.kind, agentSessionId: identity(source.agentSessionId, 'Control Region result is invalid.', 'CONTROL_PROTOCOL_ERROR'), providerId: id(source.providerId, 'Control Region result is invalid.', 'CONTROL_PROTOCOL_ERROR'), executorId: id(source.executorId, 'Control Region result is invalid.', 'CONTROL_PROTOCOL_ERROR') }
    : source.kind === 'terminal'
      ? { ...base, kind: source.kind, runId: id(source.runId, 'Control Region result is invalid.', 'CONTROL_PROTOCOL_ERROR') }
      : source.kind === 'browser'
        ? { ...base, kind: source.kind, browserId: id(source.browserId, 'Control Region result is invalid.', 'CONTROL_PROTOCOL_ERROR') }
        : source.kind === 'file'
          ? { ...base, kind: source.kind, path: text(source.path, 'File path', 'CONTROL_PROTOCOL_ERROR') }
          : source.kind === 'launcher'
            ? { ...base, kind: source.kind }
            : (() => { throw new AgentMuxError('Control Region result is invalid.', 'CONTROL_PROTOCOL_ERROR') })()
  if (!inspected) return region
  const rawBounds = object(source.bounds, 'Control Region bounds are invalid.', 'CONTROL_PROTOCOL_ERROR')
  const bounds = { x: normalized(rawBounds.x), y: normalized(rawBounds.y), width: normalized(rawBounds.width), height: normalized(rawBounds.height) }
  if (bounds.width === 0 || bounds.height === 0 || bounds.x + bounds.width > 1 + Number.EPSILON || bounds.y + bounds.height > 1 + Number.EPSILON) throw new AgentMuxError('Control Region bounds are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return { ...region, bounds, neighbors: parseNeighbors(source.neighbors) }
}

function parseAgentRegion(value: unknown): AgentMuxAgentRegion {
  const region = parseRegion(value)
  if (region.kind !== 'agent') throw new AgentMuxError('Control Agent Region result is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return region
}

function parseTerminalRegion(value: unknown): AgentMuxTerminalRegion {
  const region = parseRegion(value)
  if (region.kind !== 'terminal') throw new AgentMuxError('Control Terminal Region result is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return region
}

function parseBrowserRegion(value: unknown): AgentMuxBrowserRegion {
  const region = parseRegion(value)
  if (region.kind !== 'browser') throw new AgentMuxError('Control Browser Region result is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return region
}

function parseTab(value: unknown) {
  const tab = object(value, 'Control Tab result is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(tab.regions) || tab.regions.length === 0 || tab.regions.length > MAX_TAB_REGIONS) throw new AgentMuxError('Control Tab Regions are invalid.', 'CONTROL_PROTOCOL_ERROR')
  const regions = tab.regions.map((region) => parseRegion(region, true))
  const tabId = identity(tab.tabId, 'Control Tab result is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (regions.some((region) => region.tabId !== tabId) || new Set(regions.map(({ regionId }) => regionId)).size !== regions.length) throw new AgentMuxError('Control Tab Regions are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return { tabId, workspaceId: id(tab.workspaceId, 'Control Tab result is invalid.', 'CONTROL_PROTOCOL_ERROR'), regions }
}

function parseExecutors(value: unknown): AgentMuxControlExecutor[] {
  if (!Array.isArray(value) || value.length > MAX_EXECUTORS) throw new AgentMuxError('Control Executors are invalid.', 'CONTROL_PROTOCOL_ERROR')
  const result = value.map((item) => {
    const source = object(item, 'Control Executor is invalid.', 'CONTROL_PROTOCOL_ERROR')
    if (typeof source.label !== 'string' || !source.label.trim() || !isAgentMuxExecutorAvailability(source.availability)) throw new AgentMuxError('Control Executor is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return { executorId: id(source.executorId, 'Control Executor is invalid.', 'CONTROL_PROTOCOL_ERROR'), label: source.label, providerId: id(source.providerId, 'Control Executor is invalid.', 'CONTROL_PROTOCOL_ERROR'), availability: source.availability }
  })
  if (new Set(result.map(({ executorId }) => executorId)).size !== result.length) throw new AgentMuxError('Control Executor identity is ambiguous.', 'CONTROL_PROTOCOL_ERROR')
  return result
}

function successReceipt(request: AgentMuxControlRequest, result: AgentMuxControlResult): AgentMuxControlSuccessReceipt {
  if (request.operation !== result.operation) throw new AgentMuxError('Control result operation does not match its request.', 'CONTROL_PROTOCOL_ERROR')
  const { operation, ...body } = result
  return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: request.requestId, ok: true, operation, result: body } as AgentMuxControlSuccessReceipt
}

function parseSuccessReceipt(source: Record<string, unknown>): AgentMuxControlSuccessReceipt {
  const requestId = id(source.requestId, 'Control receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const result = object(source.result, 'Control receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (source.operation === 'inspect.tab') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { tab: parseTab(result.tab) } }
  }
  if (source.operation === 'inspect.region') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { region: parseRegion(result.region, true) } }
  if (source.operation === 'open.agent') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { region: parseAgentRegion(result.region) } }
  if (source.operation === 'open.terminal') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { region: parseTerminalRegion(result.region) } }
  if (source.operation === 'open.browser') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { region: parseBrowserRegion(result.region) } }
  if (source.operation === 'send') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { agentSessionId: identity(result.agentSessionId, 'Control send result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (source.operation === 'focus') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { tabId: identity(result.tabId, 'Control focus result is invalid.', 'CONTROL_PROTOCOL_ERROR'), ...(result.regionId === undefined ? {} : { regionId: identity(result.regionId, 'Control focus result is invalid.', 'CONTROL_PROTOCOL_ERROR') }) } }
  if (source.operation === 'arrange') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { tab: parseTab(result.tab) } }
  if (source.operation === 'promote.region') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { tabId: identity(result.tabId, 'Control promote result is invalid.', 'CONTROL_PROTOCOL_ERROR'), regionId: identity(result.regionId, 'Control promote result is invalid.', 'CONTROL_PROTOCOL_ERROR'), workspaceId: id(result.workspaceId, 'Control promote result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (source.operation === 'list.agents') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { agents: parseExecutors(result.agents) } }
  if (source.operation === 'interrupt') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { agentSessionId: identity(result.agentSessionId, 'Control interrupt result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (source.operation === 'resume') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { agentSessionId: identity(result.agentSessionId, 'Control resume result is invalid.', 'CONTROL_PROTOCOL_ERROR'), runId: id(result.runId, 'Control resume result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (source.operation === 'stop') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: source.operation, result: { agentSessionId: identity(result.agentSessionId, 'Control stop result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  throw new AgentMuxError('Control receipt operation is invalid.', 'CONTROL_PROTOCOL_ERROR')
}

function candidates(value: unknown): Array<{ agentSessionId: string; regionIds: string[] }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_TAB_REGIONS) throw new AgentMuxError('Control error candidates are invalid.', 'CONTROL_PROTOCOL_ERROR')
  const result = value.map((item) => {
    const source = object(item, 'Control error candidates are invalid.', 'CONTROL_PROTOCOL_ERROR')
    if (!Array.isArray(source.regionIds) || source.regionIds.length > MAX_TAB_REGIONS) throw new AgentMuxError('Control error candidates are invalid.', 'CONTROL_PROTOCOL_ERROR')
    return { agentSessionId: identity(source.agentSessionId, 'Control error candidates are invalid.', 'CONTROL_PROTOCOL_ERROR'), regionIds: source.regionIds.map((regionId) => identity(regionId, 'Control error candidates are invalid.', 'CONTROL_PROTOCOL_ERROR')) }
  })
  if (new Set(result.map(({ agentSessionId }) => agentSessionId)).size !== result.length) throw new AgentMuxError('Control error candidates are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return result
}

function controlErrorCode(value: unknown): AgentMuxControlErrorCode {
  return (AGENTMUX_CONTROL_ERROR_CODES as readonly unknown[]).includes(value)
    ? value as AgentMuxControlErrorCode
    : 'CONTROL_FAILED'
}

export function parseAgentMuxControlReceipt(value: unknown): AgentMuxControlReceipt {
  const source = object(value, 'Control receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (source.schemaVersion !== AGENTMUX_CONTROL_SCHEMA_VERSION) throw new AgentMuxError('Control receipt version is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (source.ok === true) {
    if (source.error !== undefined) throw new AgentMuxError('Control receipt must contain exactly one result or error.', 'CONTROL_PROTOCOL_ERROR')
    return parseSuccessReceipt(source)
  }
  if (source.ok !== false) throw new AgentMuxError('Control receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (source.result !== undefined) throw new AgentMuxError('Control receipt must contain exactly one result or error.', 'CONTROL_PROTOCOL_ERROR')
  const error = object(source.error, 'Control error receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const code = controlErrorCode(error.code)
  if (code === 'CONTROL_FAILED' && error.code !== 'CONTROL_FAILED') throw new AgentMuxError('Control error receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const message = text(error.message, 'Control error message', 'CONTROL_PROTOCOL_ERROR')
  const parsedError = code === 'MESSAGE_TARGET_NOT_UNIQUE'
    ? { code, message, candidates: candidates(error.candidates) ?? (() => { throw new AgentMuxError('Control error candidates are required.', 'CONTROL_PROTOCOL_ERROR') })() }
    : error.candidates === undefined
      ? { code, message }
      : (() => { throw new AgentMuxError('Control error candidates are invalid.', 'CONTROL_PROTOCOL_ERROR') })()
  return {
    schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: source.requestId === null ? null : id(source.requestId, 'Control error receipt is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    ok: false,
    operation: source.operation === null ? null : isAgentMuxControlOperation(source.operation) ? source.operation : (() => { throw new AgentMuxError('Control error receipt is invalid.', 'CONTROL_PROTOCOL_ERROR') })(),
    error: parsedError
  }
}

async function readMessage(socket: Socket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let byteLength = 0
    let settled = false
    const cleanup = (): void => { socket.off('data', onData); socket.off('end', onEnd); socket.off('close', onClose); socket.off('error', onError) }
    const parse = (content: Buffer): void => { if (settled) return; settled = true; cleanup(); try { resolve(JSON.parse(content.toString('utf8')) as unknown) } catch { reject(new AgentMuxError('Control message is invalid JSON.', 'CONTROL_PROTOCOL_ERROR')) } }
    const onData = (chunk: Buffer): void => {
      if (settled) return
      chunks.push(chunk); byteLength += chunk.length
      if (byteLength > MAX_MESSAGE_BYTES) { settled = true; cleanup(); reject(new AgentMuxError('Control message is too large.', 'CONTROL_PROTOCOL_ERROR')); return }
      if (chunk.indexOf(0x0a) < 0) return
      const content = Buffer.concat(chunks, byteLength); const newline = content.indexOf(0x0a)
      if (content.subarray(newline + 1).toString('utf8').trim()) { settled = true; cleanup(); reject(new AgentMuxError('Control message has trailing data.', 'CONTROL_PROTOCOL_ERROR')); return }
      parse(content.subarray(0, newline))
    }
    const onEnd = (): void => parse(Buffer.concat(chunks, byteLength))
    const onClose = (): void => parse(Buffer.concat(chunks, byteLength))
    const onError = (error: Error): void => { if (!settled) { settled = true; cleanup(); reject(error) } }
    socket.on('data', onData); socket.once('end', onEnd); socket.once('close', onClose); socket.once('error', onError)
  })
}

function requestIdentity(value: unknown): { requestId: string | null; operation: AgentMuxControlRequest['operation'] | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { requestId: null, operation: null }
  const source = value as Record<string, unknown>
  return { requestId: typeof source.requestId === 'string' ? source.requestId : null, operation: isAgentMuxControlOperation(source.operation) ? source.operation : null }
}

/**
 * 这条 Control socket 上是不是已经有活着的 owner。
 *
 * 三态判定与 endpoint 回收共用同一份实现（{@link probeSocketLiveness}）——原先两处各手抄一遍
 * errno 清单，而「哪些错误算死」漂移一次的代价在两侧都不可逆。
 *
 * 本侧对 `unknown` 的取舍是**抛 `CONTROL_UNAVAILABLE`**，不是返回 false：探不准（权限、超时、
 * 路径上不是 socket）之后若按「没人占用」继续，下一步就会 unlink 掉那条 socket 并自己 listen 上去，
 * 而它可能正被一个活着的 owner 持有——两个进程同时认为自己拥有同一条 socket。所以判不准就明说
 * 判不准，把决定交给调用方，而不是替它猜一个方向。
 */
async function socketIsActive(path: string): Promise<boolean> {
  const liveness = await probeSocketLiveness(path)
  if (liveness === 'unknown') throw new AgentMuxError('Control endpoint probe was inconclusive.', 'CONTROL_UNAVAILABLE')
  return liveness === 'alive'
}

export class AgentMuxControlServer {
  private server: Server | null = null
  constructor(private readonly control: AgentMuxControlHost, readonly path = defaultAgentMuxControlSocketPath()) {}

  async start(): Promise<void> {
    if (this.server) return
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); await chmod(dirname(this.path), 0o700)
    try {
      const metadata = await lstat(this.path); const uid = typeof process.getuid === 'function' ? process.getuid() : metadata.uid
      if (!metadata.isSocket() || metadata.uid !== uid || await socketIsActive(this.path)) throw new AgentMuxError('Another Control owner occupies the endpoint.', 'CONTROL_OWNER_BUSY')
      await rm(this.path)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const server = createServer({ allowHalfOpen: true }, (socket) => void this.handle(socket))
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.path, resolve) }); await chmod(this.path, 0o600); this.server = server } catch (error) { server.close(); throw error }
  }

  async stop(): Promise<void> {
    const server = this.server; this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve())); await rm(this.path, { force: true })
  }

  private async handle(socket: Socket): Promise<void> {
    // 还没读到请求，不知道是哪个操作：先按短预算等第一条消息，读出来之后（下面）再按操作重排。
    socket.setTimeout(AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS, () => socket.destroy())
    let raw: unknown
    let receipt: AgentMuxControlReceipt
    try {
      raw = await readMessage(socket)
      const request = parseAgentMuxControlRequest(raw)
      socket.setTimeout(agentMuxControlTimeoutMs(request.operation))
      receipt = successReceipt(request, await this.control.execute(request))
    } catch (error) {
      const identity = requestIdentity(raw)
      const code = controlErrorCode(typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined)
      const message = error instanceof Error ? error.message : String(error)
      if (code === 'MESSAGE_TARGET_NOT_UNIQUE') {
        let errorCandidates: Array<{ agentSessionId: string; regionIds: string[] }> | undefined
        try {
          errorCandidates = candidates(typeof error === 'object' && error !== null && 'candidates' in error ? error.candidates : undefined)
        } catch {
          errorCandidates = undefined
        }
        receipt = errorCandidates
          ? { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: identity.requestId, ok: false, operation: identity.operation, error: { code, message, candidates: errorCandidates } }
          : { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: identity.requestId, ok: false, operation: identity.operation, error: { code: 'CONTROL_FAILED', message: 'Control owner returned invalid message target candidates.' } }
      } else {
        receipt = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: identity.requestId, ok: false, operation: identity.operation, error: { code, message } }
      }
    }
    if (!socket.destroyed) socket.end(`${JSON.stringify(receipt)}\n`)
  }
}

export async function requestAgentMuxControl(value: AgentMuxControlRequest, path = defaultAgentMuxControlSocketPath()): Promise<AgentMuxControlSuccessReceipt> {
  const request = parseAgentMuxControlRequest(value)
  const response = await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(path)
    socket.setTimeout(agentMuxControlTimeoutMs(request.operation), () => socket.destroy(new AgentMuxError('Control request timed out.', 'CONTROL_TIMEOUT')))
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error instanceof AgentMuxError) reject(error)
      else if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') reject(new AgentMuxError('Control owner is unavailable.', 'CONTROL_UNAVAILABLE'))
      else if (error.code === 'EPIPE' || error.code === 'ECONNRESET') reject(new AgentMuxError('Control connection closed prematurely.', 'CONTROL_PROTOCOL_ERROR'))
      else reject(error)
    })
    void readMessage(socket).then(
      (value) => { socket.destroy(); resolve(value) },
      (error) => { socket.destroy(); reject(error) }
    )
  })
  const receipt = parseAgentMuxControlReceipt(response)
  if (receipt.requestId !== request.requestId || receipt.operation !== request.operation) {
    throw new AgentMuxError('Control receipt does not match its request.', 'CONTROL_PROTOCOL_ERROR')
  }
  if (!receipt.ok) throw Object.assign(
    new AgentMuxError(receipt.error.message, receipt.error.code),
    {
      requestId: receipt.requestId,
      operation: receipt.operation,
      ...(receipt.error.code === 'MESSAGE_TARGET_NOT_UNIQUE' ? { candidates: receipt.error.candidates } : {})
    }
  )
  return receipt
}
