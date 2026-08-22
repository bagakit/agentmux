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
  type AgentMuxControlBrowserRunOutcome,
  type AgentMuxControlBrowserOperation,
  type AgentMuxControlBrowserReplayPlan,
  type AgentMuxControlBrowserEvent,
  type AgentMuxControlBrowserSubscribeRequest,
  type AgentMuxControlBrowserSubscription,
  type AgentMuxControlHost,
  type AgentMuxControlErrorReceipt,
  type AgentMuxControlErrorCode,
  type AgentMuxControlExecutor,
  type AgentMuxControlReceipt,
  type AgentMuxControlRequest,
  type AgentMuxControlResult,
  type AgentMuxControlTaskUpdateRequest,
  AGENTMUX_TASK_PRIORITIES,
  AGENTMUX_TASK_STATUSES,
  type AgentMuxTaskDecision,
  type AgentMuxTask,
  type AgentMuxTaskPriority,
  type AgentMuxTaskStatus,
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
  // 纯空白与空串同罪，且判在**这一处**而不是某一条解析臂里：这个 helper 是全部 id 的必经之路
  // （requestId、regionId、browserId、operationId……），在一条臂上补判等于给别的臂留同一个洞。
  //
  // 为什么空白不是"看起来不好看"而是真缺陷：下游按 `input.id?.trim() || mint()` 消费一个 id 时，
  // `'  '` 会 trim 成空串从而落回铸造——调用方手上的 id 与记录里的那个不是同一个，而两边各自
  // 看起来都正常（MEMORY：读的 key 与写的 key 必须只判一次）。
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > MAX_ID_BYTES || /[\0\r\n]/u.test(value)) {
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

function finiteNumber(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AgentMuxError(message, 'CONTROL_PROTOCOL_ERROR')
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

function taskStatus(value: unknown): AgentMuxTaskStatus {
  if ((AGENTMUX_TASK_STATUSES as readonly unknown[]).includes(value)) return value as AgentMuxTaskStatus
  throw new AgentMuxError('Task status is invalid.', 'INVALID_CONTROL_REQUEST')
}
function taskPriority(value: unknown): AgentMuxTaskPriority {
  if ((AGENTMUX_TASK_PRIORITIES as readonly unknown[]).includes(value)) return value as AgentMuxTaskPriority
  throw new AgentMuxError('Task priority is invalid.', 'INVALID_CONTROL_REQUEST')
}
function arrayOfIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new AgentMuxError(`${label} are invalid.`, 'INVALID_CONTROL_REQUEST')
  return value.map((item) => id(item, `${label} are invalid.`, 'INVALID_CONTROL_REQUEST'))
}
function taskDecision(value: unknown): AgentMuxTaskDecision {
  const source = object(value, 'Task decision is invalid.', 'INVALID_CONTROL_REQUEST')
  const candidates = Array.isArray(source.candidates) ? source.candidates.map((item) => {
    const candidate = object(item, 'Task decision candidate is invalid.', 'INVALID_CONTROL_REQUEST')
    return { projectId: id(candidate.projectId, 'Task decision project is invalid.', 'INVALID_CONTROL_REQUEST'), reason: text(candidate.reason, 'Task decision reason') }
  }) : []
  const risk = source.risk
  if (risk !== 'low' && risk !== 'medium' && risk !== 'high' && risk !== 'unknown') throw new AgentMuxError('Task decision risk is invalid.', 'INVALID_CONTROL_REQUEST')
  const confirmation = source.confirmation
  if (confirmation !== 'automatic' && confirmation !== 'user' && confirmation !== 'pending') throw new AgentMuxError('Task decision confirmation is invalid.', 'INVALID_CONTROL_REQUEST')
  return {
    input: text(source.input, 'Task decision input'), candidates,
    selectedProjectId: source.selectedProjectId === null ? null : id(source.selectedProjectId, 'Task decision project is invalid.', 'INVALID_CONTROL_REQUEST'),
    risk, confirmation,
    wikiVersion: source.wikiVersion === null || source.wikiVersion === undefined ? null : id(source.wikiVersion, 'Task decision Wiki version is invalid.', 'INVALID_CONTROL_REQUEST'),
    recordedAt: finiteNumber(source.recordedAt, 'Task decision timestamp is invalid.'),
    sourceSessionId: source.sourceSessionId === null || source.sourceSessionId === undefined ? null : id(source.sourceSessionId, 'Task decision Session is invalid.', 'INVALID_CONTROL_REQUEST')
  }
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
  if (source.operation === 'task.list') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation }
  }
  if (source.operation === 'task.show' || source.operation === 'task.decision-log') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, taskId: id(source.taskId, 'Task id is invalid.', 'INVALID_CONTROL_REQUEST') }
  }
  if (source.operation === 'task.link-session') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, taskId: id(source.taskId, 'Task id is invalid.', 'INVALID_CONTROL_REQUEST'), sessionId: id(source.sessionId, 'Agent Session id is invalid.', 'INVALID_CONTROL_REQUEST') }
  }
  if (source.operation === 'task.link-project') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, taskId: id(source.taskId, 'Task id is invalid.', 'INVALID_CONTROL_REQUEST'), projectId: id(source.projectId, 'Project id is invalid.', 'INVALID_CONTROL_REQUEST') }
  }
  if (source.operation === 'task.create') {
    const title = text(source.title, 'Task title')
    const sessionIds = source.sessionIds === undefined ? undefined : arrayOfIds(source.sessionIds, 'Task Session ids')
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, title,
      ...(source.description === undefined ? {} : { description: text(source.description, 'Task description') }),
      ...(source.projectId === undefined ? {} : { projectId: id(source.projectId, 'Project id is invalid.', 'INVALID_CONTROL_REQUEST') }),
      ...(source.priority === undefined ? {} : { priority: taskPriority(source.priority) }),
      ...(source.status === undefined ? {} : { status: taskStatus(source.status) }),
      ...(sessionIds ? { sessionIds } : {}),
      ...(source.decision === undefined ? {} : { decision: taskDecision(source.decision) })
    }
  }
  if (source.operation === 'task.update') {
    const patchSource = object(source.patch, 'Task patch is invalid.', 'INVALID_CONTROL_REQUEST')
    const patch: AgentMuxControlTaskUpdateRequest['patch'] = {}
    if (patchSource.title !== undefined) patch.title = text(patchSource.title, 'Task title')
    if (patchSource.description !== undefined) patch.description = text(patchSource.description, 'Task description')
    if (patchSource.status !== undefined) patch.status = taskStatus(patchSource.status)
    if (patchSource.priority !== undefined) patch.priority = taskPriority(patchSource.priority)
    if (patchSource.projectId !== undefined) patch.projectId = patchSource.projectId === null ? null : id(patchSource.projectId, 'Project id is invalid.', 'INVALID_CONTROL_REQUEST')
    if (patchSource.projectName !== undefined) patch.projectName = patchSource.projectName === null ? null : text(patchSource.projectName, 'Project name')
    if (patchSource.sessionIds !== undefined) patch.sessionIds = arrayOfIds(patchSource.sessionIds, 'Task Session ids')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, taskId: id(source.taskId, 'Task id is invalid.', 'INVALID_CONTROL_REQUEST'), patch, ...(source.decision === undefined ? {} : { decision: taskDecision(source.decision) }) }
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
  if (source.operation === 'browser.run') {
    // caller 是可选的：CLI 直接发一条也合法（那时没有 managed caller）。没有 self 语义，所以不像别的
    // 操作那样需要"self 必须配 caller"那道闸——browserId 永远是显式的。
    const owner = optionalCaller(source.caller)
    // 走 text 而不是 id：程序是多行的，`id` 会因为换行直接拒掉。上限同样是 MAX_MESSAGE_BYTES——
    // 一段 256KB 的调试程序已经远超任何合理规模，再大应该写成文件。
    const code = text(source.code, 'Browser script')
    // **空程序在协议层就拒，不在 CLI 里。** 放它过去的话，回执是一份「跑完了、什么都没发生」的成功，
    // 与真的跑完一段什么都不做的程序在回执上完全无法区分（AGENTS.md:32-52 明令不许发这种结局）。
    // 规则住在这一层，CLI、编辑器、将来任何直连客户端就都经同一条；写在 CLI 里的话，只有走 CLI
    // 那一条路被拦住，别的客户端照旧拿到那次不确定的成功。空白不算内容，所以判的是 trim 之后。
    if (code.trim() === '') {
      // 文案要对**两种调用方**都可执行，因为这一层两种都服务：走 CLI 的人忘了接管道，直连协议的
      // 客户端把 `code` 设成了空串。给一种人看得懂的话，另一种人就只能猜——所以一句话点两条路。
      throw new AgentMuxError(
        'Browser script is empty. Pipe it in, for example: agentmux browser run --browser <id> < script.js — or set `code` to the program text.',
        'INVALID_CONTROL_REQUEST'
      )
    }
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      operation: source.operation,
      browserId: identity(source.browserId, 'Browser target is invalid.', 'INVALID_CONTROL_REQUEST'),
      code,
      // 调用方给的 identity（可选）。给了就用它，因为「在飞期间凭 id 查询/取消」要求调用方在请求发出去
      // 之前就知道这个 id——一问一答的 framing 下，主进程铸的 id 只能随终局回执露出，那时已无可取消。
      // 走 identity() 与 browser.stop / browser.operation 那两条同一条判据：三处读同一个 id，
      // 校验必须只有一份，否则「发得进去但查不出来」这种分岔会静默存在。
      ...(source.operationId === undefined
        ? {}
        : { operationId: identity(source.operationId, 'Browser operation id is invalid.', 'INVALID_CONTROL_REQUEST') }),
      ...(owner ? { caller: owner } : {})
    }
  }
  if (source.operation === 'browser.history') {
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      operation: source.operation,
      ...(source.browserId === undefined ? {} : { browserId: identity(source.browserId, 'Browser target is invalid.', 'INVALID_CONTROL_REQUEST') })
    }
  }
  if (source.operation === 'browser.replay') {
    const owner = optionalCaller(source.caller)
    const mode = source.mode === undefined ? 'run' : source.mode
    if (mode !== 'preview' && mode !== 'step' && mode !== 'run') {
      throw new AgentMuxError('Browser replay mode is invalid.', 'INVALID_CONTROL_REQUEST')
    }
    // step 的校验**只在这一处**。此前 CLI（agentmux.ts）也用正则各判一遍、拿自己的
    // `INVALID_CLI_ARGUMENT` 拒同一个输入，于是同一个非法 step 经两条路得到两个错误码——机读侧
    // 分不出「这是我给错了」还是「命令打错了」。CLI 现在只做 flag 形状解析（字符串转数字），
    // 取值合法性归这里。
    //
    // 一次判完，不先过 `finiteNumber`：`Number.isInteger` 对 NaN / Infinity 同样为 false，
    // 分两步只会让「非数字」落到 CONTROL_PROTOCOL_ERROR 而「0」落到 INVALID_CONTROL_REQUEST——
    // 同一件事（你给的 step 不能用）长出两个码。
    const step = source.step === undefined ? undefined : source.step
    if (step !== undefined && (typeof step !== 'number' || !Number.isInteger(step) || step < 1)) {
      throw new AgentMuxError('Browser replay step is invalid. It must be a whole number, 1 or greater.', 'INVALID_CONTROL_REQUEST')
    }
    if (mode === 'step' && step === undefined) {
      throw new AgentMuxError('Browser replay step is required for step mode.', 'INVALID_CONTROL_REQUEST')
    }
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      operation: source.operation,
      browserId: identity(source.browserId, 'Browser target is invalid.', 'INVALID_CONTROL_REQUEST'),
      operationId: identity(source.operationId, 'Browser operation id is invalid.', 'INVALID_CONTROL_REQUEST'),
      mode,
      ...(step === undefined ? {} : { step }),
      ...(owner ? { caller: owner } : {})
    }
  }
  if (source.operation === 'browser.stop') {
    const owner = optionalCaller(source.caller)
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      operation: source.operation,
      // 没有 browserId：id 本身定位到那一个操作。走 identity() 而不是 text()：id 是一个标识符，
      // 换行和空白在里面没有意义，而 `self` 这类保留选择器同样要被拒——没有哪个操作叫 self。
      operationId: identity(source.operationId, 'Browser operation id is invalid.', 'INVALID_CONTROL_REQUEST'),
      ...(owner ? { caller: owner } : {})
    }
  }
  if (source.operation === 'browser.operation') {
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      operation: source.operation,
      operationId: identity(source.operationId, 'Browser operation id is invalid.', 'INVALID_CONTROL_REQUEST')
    }
  }
  if (source.operation === 'browser.subscribe') {
    // 游标判在这一层，不在承载方：一个负数或小数序号根本不可能对应任何一条事件，让它穿过去的结果是
    // 承载方拿它做比较，于是「从头开始发」和「什么都不发」取决于那边碰巧怎么写比较符——同一个非法
    // 输入在两个实现上给出两种行为。`0` 是合法的（等于"从第一条开始"），所以判的是负与非整数。
    const cursor = source.afterSequence
    if (cursor !== undefined && (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0)) {
      throw new AgentMuxError('Browser subscribe cursor is invalid.', 'INVALID_CONTROL_REQUEST')
    }
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      operation: source.operation,
      operationId: identity(source.operationId, 'Browser operation id is invalid.', 'INVALID_CONTROL_REQUEST'),
      ...(cursor === undefined ? {} : { afterSequence: cursor })
    }
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

function parseTask(value: unknown): AgentMuxTask {
  const source = object(value, 'Control task is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return {
    id: id(source.id, 'Control task id is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    title: text(source.title, 'Control task title', 'CONTROL_PROTOCOL_ERROR'),
    description: text(source.description, 'Control task description', 'CONTROL_PROTOCOL_ERROR'),
    status: taskStatus(source.status) as AgentMuxTask['status'],
    priority: taskPriority(source.priority) as AgentMuxTask['priority'],
    projectId: source.projectId === null ? null : id(source.projectId, 'Control task project is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    projectName: source.projectName === null ? null : text(source.projectName, 'Control task project name', 'CONTROL_PROTOCOL_ERROR'),
    sessionIds: arrayOfIds(source.sessionIds, 'Control task Session ids'),
    createdAt: finiteNumber(source.createdAt, 'Control task created timestamp is invalid.'),
    updatedAt: finiteNumber(source.updatedAt, 'Control task updated timestamp is invalid.'),
    source: source.source === 'default-topic' || source.source === 'session' ? source.source : (() => { throw new AgentMuxError('Control task source is invalid.', 'CONTROL_PROTOCOL_ERROR') })()
  }
}
function parseTaskDecisions(value: unknown): AgentMuxTaskDecision[] {
  if (!Array.isArray(value)) throw new AgentMuxError('Control task decisions are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value.map((item) => taskDecision(item))
}

function successReceipt(request: AgentMuxControlRequest, result: AgentMuxControlResult): AgentMuxControlSuccessReceipt {
  if (request.operation !== result.operation) throw new AgentMuxError('Control result operation does not match its request.', 'CONTROL_PROTOCOL_ERROR')
  const { operation, ...body } = result
  return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: request.requestId, ok: true, operation, result: body } as AgentMuxControlSuccessReceipt
}

function parseSuccessReceipt(source: Record<string, unknown>): AgentMuxControlSuccessReceipt {
  const requestId = id(source.requestId, 'Control receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const result = object(source.result, 'Control receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (!isAgentMuxControlOperation(source.operation)) {
    throw new AgentMuxError('Control receipt operation is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  const operation: AgentMuxControlRequest['operation'] = source.operation
  if (operation === 'inspect.tab') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { tab: parseTab(result.tab) } }
  }
  if (operation === 'inspect.region') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { region: parseRegion(result.region, true) } }
  if (operation === 'open.agent') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { region: parseAgentRegion(result.region) } }
  if (operation === 'open.terminal') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { region: parseTerminalRegion(result.region) } }
  if (operation === 'open.browser') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { region: parseBrowserRegion(result.region) } }
  if (operation === 'send') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { agentSessionId: identity(result.agentSessionId, 'Control send result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (operation === 'focus') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { tabId: identity(result.tabId, 'Control focus result is invalid.', 'CONTROL_PROTOCOL_ERROR'), ...(result.regionId === undefined ? {} : { regionId: identity(result.regionId, 'Control focus result is invalid.', 'CONTROL_PROTOCOL_ERROR') }) } }
  if (operation === 'arrange') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { tab: parseTab(result.tab) } }
  if (operation === 'promote.region') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { tabId: identity(result.tabId, 'Control promote result is invalid.', 'CONTROL_PROTOCOL_ERROR'), regionId: identity(result.regionId, 'Control promote result is invalid.', 'CONTROL_PROTOCOL_ERROR'), workspaceId: id(result.workspaceId, 'Control promote result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (operation === 'list.agents') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { agents: parseExecutors(result.agents) } }
  if (operation === 'interrupt') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { agentSessionId: identity(result.agentSessionId, 'Control interrupt result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (operation === 'resume') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { agentSessionId: identity(result.agentSessionId, 'Control resume result is invalid.', 'CONTROL_PROTOCOL_ERROR'), runId: id(result.runId, 'Control resume result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (operation === 'stop') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { agentSessionId: identity(result.agentSessionId, 'Control stop result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (operation === 'task.list') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { tasks: Array.isArray(result.tasks) ? result.tasks.map(parseTask) : (() => { throw new AgentMuxError('Control task list is invalid.', 'CONTROL_PROTOCOL_ERROR') })() } }
  if (operation === 'task.show') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { task: result.task === null ? null : parseTask(result.task) } }
  if (operation === 'task.create' || operation === 'task.update' || operation === 'task.link-session' || operation === 'task.link-project') {
    const task = parseTask(result.task)
    const receipt = object(result.receipt, 'Control task receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { task, receipt: { taskId: id(receipt.taskId, 'Control task receipt id is invalid.', 'CONTROL_PROTOCOL_ERROR'), ...(operation === 'task.link-session' ? { sessionId: id(receipt.sessionId, 'Control task Session id is invalid.', 'CONTROL_PROTOCOL_ERROR') } : {}), ...(operation === 'task.link-project' ? { projectId: id(receipt.projectId, 'Control task project id is invalid.', 'CONTROL_PROTOCOL_ERROR') } : {}), ...(operation === 'task.create' ? { createdAt: finiteNumber(receipt.createdAt, 'Control task receipt timestamp is invalid.') } : {}), ...(operation === 'task.update' ? { updatedAt: finiteNumber(receipt.updatedAt, 'Control task receipt timestamp is invalid.') } : {}) } } } as AgentMuxControlSuccessReceipt
  }
  if (operation === 'task.decision-log') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { taskId: id(result.taskId, 'Control task id is invalid.', 'CONTROL_PROTOCOL_ERROR'), decisions: parseTaskDecisions(result.decisions) } }
  if (operation === 'browser.run') {
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      ok: true,
      operation,
      // result 是程序的返回值，**故意不校验形状**——它是 Agent 自己那段程序 return 的东西，我们没有
      // 立场说它该长什么样。缺席（程序什么都没 return）是合法的，收成 undefined。
      result: {
        result: result.result,
        logs: scriptLogs(result.logs),
        outcome: browserRunOutcome(result.outcome),
        runOperation: browserOperation(result.runOperation)
      }
    }
  }
  if (operation === 'browser.history') {
    if (!Array.isArray(result.operations) || result.operations.length > 10_000) throw new AgentMuxError('Control browser history is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { operations: result.operations.map(browserOperation) } }
  }
  if (operation === 'browser.replay') {
    if (result.mode === 'preview') {
      return {
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId,
        ok: true,
        operation,
        result: { mode: 'preview', plan: browserReplayPlan(result.plan) }
      }
    }
    const mode = result.mode === 'step' ? 'step' : 'run'
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      ok: true,
      operation,
      result: { mode, result: result.result, logs: scriptLogs(result.logs), outcome: browserRunOutcome(result.outcome), runOperation: browserOperation(result.runOperation) }
    }
  }
  if (operation === 'browser.stop' || operation === 'browser.operation') {
    // 两条的回执形状相同（一个可为 null 的 operation），所以合成一条臂：分开写两遍同样的解析是
    // 第二份事实，改一处忘另一处时两条会对同一份 wire 数据给出不同答案。
    //
    // `null` 必须是**合法答案**而不是解析失败：查不到那条 id 是一次成功的回答（id 可能来自另一台机器、
    // 或早被日志轮转掉了）。把它读成协议错误会让调用方以为 Browser 坏了——RED-LINES 第 2 类。
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      ok: true,
      operation,
      result: {
        runOperation: result.runOperation === null || result.runOperation === undefined
          ? null
          : browserOperation(result.runOperation)
      }
    }
  }
  if (operation === 'browser.subscribe') {
    // 不并进上面那条合成臂，尽管 `runOperation` 的读法一模一样：这一支多一个 `gap`，而 `gap` 的取舍
    // 与 `runOperation` 的相反——缺席的 `runOperation` 是合法的「查不到」，缺席的 `gap` 必须读成
    // `null`（没有缺口）**且不许缺省成一个假的缺口**。合到一起写的话，`gap` 只能靠一个可选字段挂在
    // 那条臂上，于是 `browser.stop` 的回执里凭空出现一个 `gap` 字段——那是把两件事写进一个形状。
    const gap = result.gap
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      ok: true,
      operation,
      result: {
        runOperation: result.runOperation === null || result.runOperation === undefined
          ? null
          : browserOperation(result.runOperation),
        // 缺席 = 没有缺口。有值时 `droppedThrough` 必须真的读出来并校验：这个数字是客户端判断
        // 「我手上这份时间线不完整」的唯一依据，读不出来时**抛**而不是折成 null——把一个读不懂的
        // 缺口标记折成"没有缺口"，等于替服务端撒一个它没说的谎。
        gap: gap === null || gap === undefined
          ? null
          : { droppedThrough: sequence(object(gap, 'Control browser subscribe gap is invalid.', 'CONTROL_PROTOCOL_ERROR').droppedThrough) }
      }
    }
  }
  return assertUnhandledReceipt(operation)
}

/** 事件序号的线上读法。非安全整数或负数都抛——游标算错的后果是静默丢事件，不是一次显眼的失败。 */
function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AgentMuxError('Control browser event sequence is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  return value
}

function browserOperation(value: unknown): AgentMuxControlBrowserOperation {
  const source = object(value, 'Control browser operation is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const operator = object(source.operator, 'Control browser operation operator is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(source.steps) || source.steps.length > 10_000) {
    throw new AgentMuxError('Control browser operation steps are invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  return {
    id: identity(source.id, 'Control browser operation id is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    browserId: identity(source.browserId, 'Control browser operation browser id is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    operator: {
      id: identity(operator.id, 'Control browser operation operator id is invalid.', 'CONTROL_PROTOCOL_ERROR'),
      name: text(operator.name, 'Control browser operation operator name is invalid.', 'CONTROL_PROTOCOL_ERROR'),
      ...(operator.providerId === undefined ? {} : { providerId: identity(operator.providerId, 'Control browser operation provider id is invalid.', 'CONTROL_PROTOCOL_ERROR') })
    },
    startedAt: finiteNumber(source.startedAt, 'Control browser operation start is invalid.'),
    ...(source.finishedAt === undefined ? {} : { finishedAt: finiteNumber(source.finishedAt, 'Control browser operation finish is invalid.') }),
    phase: text(source.phase, 'Control browser operation phase is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    summary: text(source.summary, 'Control browser operation summary is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    url: text(source.url, 'Control browser operation url is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    steps: source.steps,
    ...(source.replayOf === undefined ? {} : { replayOf: identity(source.replayOf, 'Control browser operation replay id is invalid.', 'CONTROL_PROTOCOL_ERROR') }),
    ...(source.warning === undefined ? {} : { warning: text(source.warning, 'Control browser operation warning is invalid.', 'CONTROL_PROTOCOL_ERROR') })
  }
}

function browserReplayPlan(value: unknown): AgentMuxControlBrowserReplayPlan {
  const source = object(value, 'Control browser replay plan is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (source.schema !== 'agentmux.browser-replay.v1') throw new AgentMuxError('Control browser replay plan schema is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(source.steps) || source.steps.length > 10_000) throw new AgentMuxError('Control browser replay plan steps are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return {
    schema: 'agentmux.browser-replay.v1',
    operationId: identity(source.operationId, 'Control browser replay plan operation id is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    url: text(source.url, 'Control browser replay plan url is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    steps: source.steps
  }
}

const MAX_SCRIPT_LOG_LINES = 10_000

function scriptLogs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SCRIPT_LOG_LINES) throw new AgentMuxError('Control browser run logs are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value.map((line) => text(line, 'Browser script log', 'CONTROL_PROTOCOL_ERROR'))
}

/**
 * 四分类结局的线上解析。
 *
 * 这里**不给任何缺省值**：`kind` 认不出来就抛，不折成 `indeterminate`，也不折成 `completed`。
 * 折成 `completed` 显然是在撒谎；折成 `indeterminate` 看起来"保守"，其实是把一个协议缺陷
 * （两侧版本不一致）伪装成一次正常的不确定结局，于是没有人会去修它。
 */
function browserRunOutcome(value: unknown): AgentMuxControlBrowserRunOutcome {
  const source = object(value, 'Control browser run outcome is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (source.kind === 'completed') return { kind: source.kind }
  if (source.kind === 'script-failed' || source.kind === 'stopped' || source.kind === 'indeterminate') {
    return { kind: source.kind, message: text(source.message, 'Browser run outcome message', 'CONTROL_PROTOCOL_ERROR') }
  }
  throw new AgentMuxError('Control browser run outcome is invalid.', 'CONTROL_PROTOCOL_ERROR')
}

/**
 * 回执解析的穷尽出口。与上面 {@link assertUnhandledOperation} 同形，理由也是同一条：这条 if 链此前
 * 在 `source.operation: unknown` 上比较，永远收窄不到 `never`，尾巴只是一句运行时 throw——往联合里
 * 加一个操作而忘了在这里加解析臂，tsc 全程沉默，要到线上收到那份回执时才炸成 `CONTROL_PROTOCOL_ERROR`，
 * 而且错误信息说的是"回执非法"，不是"我们没实现这一臂"。
 *
 * 修法是先过一次成员判定把 `unknown` 收成联合，后面的比较才真正收窄，遗漏当场就是 TS2345。
 * `browser.run` 是第 14 个操作，正是这条修补想拦住的那类遗漏。
 */
function assertUnhandledReceipt(operation: never): never {
  throw new AgentMuxError(`Control receipt operation is not handled: ${String(operation)}`, 'CONTROL_PROTOCOL_ERROR')
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
  /**
   * 还开着的事件流 socket。
   *
   * 记这一份是因为 `server.close()` 只停止接受新连接，**并等已有连接自己结束**——而一条事件流按定义
   * 不会自己结束（它等的是那个操作有进展）。于是不记这份账的话，`stop()` 永远不返回：应用关不掉，
   * 测试也挂死。实测过（node 直接跑）：开一条订阅之后 `stop()` 一直不 resolve。
   *
   * 一问一答那些连接不进这个集合，它们本来就会立刻结束——把它们也记进来只会多一份要维护的账。
   */
  private readonly streams = new Set<Socket>()
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
    // 先关掉还开着的流，再等 close()。顺序是承重的：`close()` 等的是所有现有连接结束，而事件流
    // 不会自己结束，所以反过来写就是永远等下去。销毁 socket 会触发它的 'close'，那条路上挂着
    // 订阅的退订——所以承载方那侧也一起清掉，不留悬空监听。
    for (const socket of [...this.streams]) socket.destroy()
    this.streams.clear()
    await new Promise<void>((resolve) => server.close(() => resolve())); await rm(this.path, { force: true })
  }

  private async handle(socket: Socket): Promise<void> {
    // readMessage removes its error listener once the request is parsed. Keep a
    // connection-level handler through execution and the final asynchronous write:
    // a peer disconnect must close this socket, not crash the owning application.
    socket.on('error', () => socket.destroy())
    // 还没读到请求，不知道是哪个操作：先按短预算等第一条消息，读出来之后（下面）再按操作重排。
    socket.setTimeout(AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS, () => socket.destroy())
    let raw: unknown
    let receipt: AgentMuxControlReceipt
    try {
      raw = await readMessage(socket)
      const request = parseAgentMuxControlRequest(raw)
      socket.setTimeout(agentMuxControlTimeoutMs(request.operation))
      if (request.operation === 'browser.subscribe') { await this.stream(socket, request); return }
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

  /**
   * 一问多答那条路径。它是**独立的一支**，不是把上面那条改宽：`readMessage` 一个字节都没动，其余
   * 14 个操作的 framing 假设（读到第一个换行就是全部、之后还有字节就是协议错）原样成立。
   *
   * 这里与上面那条的三处差别，每一处都有它非这样不可的理由：
   *
   * 1. **不设操作预算。** 上面每条请求都有超时，因为「等一个答案等太久」确实是故障。这里没有：
   *    一个操作安静十分钟是正常的（页面在等人操作），把它判成超时会把健康的订阅杀掉。socket 的
   *    存活由两端自己管——客户端不想要了就关，操作结束了服务端就关。
   * 2. **开场帧之后不 `end()`。** `end()` 会发 FIN，客户端读到流结束就认为订阅没了。
   * 3. **退订挂在 socket 的三个终止事件上，不只是 `close`。** 少挂一个的后果不是少清理一次：
   *    承载方那边的监听留着，而它持有的是对已死 socket 的写入闭包，于是每条新事件都往一个关掉的
   *    socket 写——EPIPE 会被 `try` 吃掉，看起来一切正常，实际上泄漏一条订阅。
   */
  private async stream(socket: Socket, request: AgentMuxControlBrowserSubscribeRequest): Promise<void> {
    // 预算清零：`setTimeout(0)` 关掉超时（Node 的语义），不是"立刻超时"。
    socket.setTimeout(0)
    const write = (payload: unknown): void => {
      // `destroyed` 判在写之前而不是靠 catch：写一个已销毁的 socket 在 Node 里是**异步**报错
      // （'error' 事件），catch 抓不到它，于是"写失败了"这件事会绕过这里流到进程的未处理错误上。
      if (socket.destroyed || socket.writableEnded) return
      socket.write(`${JSON.stringify(payload)}\n`)
    }
    if (!this.control.subscribeBrowserOperation) {
      // 能力协商的回答，不是故障：这个宿主不提供进度订阅。用一条错误回执答完就关——它是一问一答的
      // 形状，因为这条连接根本没成为一条流。
      const receipt: AgentMuxControlErrorReceipt = {
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: request.requestId,
        ok: false,
        operation: request.operation,
        error: { code: 'BROWSER_SUBSCRIBE_UNSUPPORTED', message: 'Control owner does not provide Browser progress subscriptions.' }
      }
      if (!socket.destroyed) socket.end(`${JSON.stringify(receipt)}\n`)
      return
    }
    let subscription: AgentMuxControlBrowserSubscription
    try {
      subscription = await this.control.subscribeBrowserOperation(request, (event) => {
        write({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: request.requestId, ok: true, operation: request.operation, event: 'progress', result: event })
      })
    } catch (error) {
      // `MESSAGE_TARGET_NOT_UNIQUE` 要带 candidates 才是合法错误，而订阅路径上不可能产生它
      // （它讲的是"哪个 Agent"不唯一，这里根本没有 target）。所以把它折到 CONTROL_FAILED，
      // 而不是编一份空的 candidates 交出去——那会让客户端拿着一个空列表去消歧。
      const raw = controlErrorCode(typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined)
      const code = raw === 'MESSAGE_TARGET_NOT_UNIQUE' ? 'CONTROL_FAILED' : raw
      const receipt: AgentMuxControlErrorReceipt = {
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: request.requestId,
        ok: false,
        operation: request.operation,
        error: { code, message: error instanceof Error ? error.message : String(error) }
      }
      if (!socket.destroyed) socket.end(`${JSON.stringify(receipt)}\n`)
      return
    }
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      this.streams.delete(socket)
      // **必须自己 destroy**，不能指望对方关了这条就没了：server 是 `allowHalfOpen: true` 建的，
      // 所以客户端发来 FIN（'end'）之后这条 socket 仍然是可写的、仍然算一条活着的连接。一问一答那条
      // 路径不受影响——它自己调 `socket.end()`。而流永远不调 end，于是不在这里 destroy 的话，
      // 客户端退订之后服务端这一侧会**半开着挂到进程结束**，`server.close()` 跟着永远不返回。
      if (!socket.destroyed) socket.destroy()
      // 承载方的 dispose 抛出来不许冒泡：这是清理路径，而抛在这里会变成一个没人接的 socket 事件
      // 处理器异常。订阅泄漏是个问题，但把它变成进程级未处理错误是更大的那个。
      try { subscription.dispose() } catch { /* 清理失败不改变「这条连接已经结束」这个事实 */ }
    }
    socket.once('close', dispose); socket.once('end', dispose); socket.once('error', dispose)
    this.streams.add(socket)
    // 开场帧：缺口在这一帧就说出来，早于任何一条事件。客户端读到它才知道自己手上这份时间线完不完整。
    write(successReceipt(request, {
      operation: request.operation,
      runOperation: subscription.runOperation,
      gap: subscription.gap
    }))
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

/**
 * 客户端侧的订阅读法。与 {@link requestAgentMuxControl} 是两个函数而不是一个带 flag 的：那条读**一条**
 * 消息然后销毁 socket（`readMessage` 的语义就是这样），流要读到很多条。合成一个的话，那个 flag 会在
 * 函数体里长出两条几乎不相交的路径，而其中一条会悄悄继承另一条的超时与销毁时机。
 *
 * 返回开场帧（含缺口）与一个退订函数。事件从 `onEvent` 出来。流结束（服务端关闭、操作收尾）走 `onEnd`。
 *
 * **不在这里重连**。断线之后该不该接着订、从哪个序号接着订，是调用方的决定——它手上才有"我还关心这条
 * 操作吗"这个信息。在这一层偷偷重连会让一次网络断开变成一条看起来从未中断的流，而客户端已经错过了
 * 中间那段事件却以为自己什么都没漏。
 */
export async function subscribeAgentMuxControl(
  value: AgentMuxControlBrowserSubscribeRequest,
  handlers: {
    onEvent(event: AgentMuxControlBrowserEvent): void
    onEnd?(reason: 'closed' | 'error', error?: Error): void
  },
  path = defaultAgentMuxControlSocketPath()
): Promise<{ runOperation: AgentMuxControlBrowserOperation | null; gap: { droppedThrough: number } | null; dispose(): void }> {
  const parsed = parseAgentMuxControlRequest(value)
  if (parsed.operation !== 'browser.subscribe') throw new AgentMuxError('Control subscribe request is invalid.', 'INVALID_CONTROL_REQUEST')
  const socket = createConnection(path)
  // 开场帧之前有预算（连不上/对方不答要失败得干脆），拿到之后清零——见 stream() 里同一条理由。
  socket.setTimeout(agentMuxControlTimeoutMs(parsed.operation), () => socket.destroy(new AgentMuxError('Control request timed out.', 'CONTROL_TIMEOUT')))
  const dispose = (): void => { if (!socket.destroyed) socket.destroy() }
  try {
    return await new Promise((resolve, reject) => {
      let opened = false
      let buffer = ''
      const fail = (error: Error): void => { socket.destroy(); if (opened) handlers.onEnd?.('error', error); else reject(error) }
      socket.once('connect', () => socket.write(`${JSON.stringify(parsed)}\n`))
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error instanceof AgentMuxError) fail(error)
        else if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') fail(new AgentMuxError('Control owner is unavailable.', 'CONTROL_UNAVAILABLE'))
        else if (error.code === 'EPIPE' || error.code === 'ECONNRESET') fail(new AgentMuxError('Control connection closed prematurely.', 'CONTROL_PROTOCOL_ERROR'))
        else fail(error)
      })
      // 流结束是正常结局，不是错误：操作跑完了服务端就关。开场帧还没拿到就断掉才是失败。
      socket.once('close', () => { if (opened) handlers.onEnd?.('closed'); else reject(new AgentMuxError('Control connection closed prematurely.', 'CONTROL_PROTOCOL_ERROR')) })
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        // 按换行切，**逐行**处理：一次 TCP 读里可能带着好几条事件，也可能带着半条。把半条留在
        // buffer 里等下一块——这正是 `readMessage` 不能复用的地方（它读到第一个换行就收工，
        // 并且把后面的字节当协议错）。
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (!line.trim()) continue
          let frame: unknown
          try { frame = JSON.parse(line) as unknown } catch { fail(new AgentMuxError('Control message is invalid JSON.', 'CONTROL_PROTOCOL_ERROR')); return }
          const source = frame as Record<string, unknown>
          if (!opened) {
            // 第一帧走完整的回执解析（含错误回执：能力不支持就从这里抛出去）。
            const receipt = parseAgentMuxControlReceipt(frame)
            if (receipt.requestId !== parsed.requestId || receipt.operation !== parsed.operation) {
              reject(new AgentMuxError('Control receipt does not match its request.', 'CONTROL_PROTOCOL_ERROR')); socket.destroy(); return
            }
            if (!receipt.ok) { reject(Object.assign(new AgentMuxError(receipt.error.message, receipt.error.code), { requestId: receipt.requestId, operation: receipt.operation })); socket.destroy(); return }
            // 判在 `receipt.operation` 上而不是 `receipt.result`：`result` 的类型是 `Omit<…, 'operation'>`
            // （判别键在外层），在它上面找 operation 是 TS2551。用字面量比较也顺手把上面那次
            // `!== parsed.operation` 的收窄补齐——两处判的是同一件事，但只有这一处能收窄 result。
            if (receipt.operation !== 'browser.subscribe') { reject(new AgentMuxError('Control receipt does not match its request.', 'CONTROL_PROTOCOL_ERROR')); socket.destroy(); return }
            opened = true
            socket.setTimeout(0)
            resolve({ runOperation: receipt.result.runOperation, gap: receipt.result.gap, dispose })
            continue
          }
          // 之后每一帧是一条事件。序号走同一个校验函数（`sequence`），不在这里另写一遍比较——
          // 游标算错的后果是静默丢事件，而两处各判一遍正是它漂移的来路。
          if (source.event !== 'progress') { fail(new AgentMuxError('Control stream frame is invalid.', 'CONTROL_PROTOCOL_ERROR')); return }
          const result = object(source.result, 'Control stream frame is invalid.', 'CONTROL_PROTOCOL_ERROR')
          handlers.onEvent({ sequence: sequence(result.sequence), event: result.event })
        }
      })
    })
  } catch (error) { dispose(); throw error }
}

