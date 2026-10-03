import { parseGoalContinuationLoop } from './continuous-progress-scheduler.js'
import { normalizeMessageChannel } from './message-origin.js'
import { isPendingMessageOperation, parsePendingMessage } from './pending-message-control.js'
import { parseAlignment, parseAlignmentProposal, parseGrounding, parseGroundingProposal } from '@agentmux/demand/goals'
import { validateAgentPromptCondition } from './agent-prompt-condition.js'
import { BROWSER_COMPLETION_UNAVAILABLE_WARNING, parseBrowserCompletionFacts } from './browser-completion-facts.js'
import {
  AGENTMUX_CONTROL_ERROR_CODES,
  AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS,
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  agentMuxControlTimeoutMs,
  isAgentMuxControlOperation,
  isAgentMuxExecutorAvailability,
  type AgentMuxArrangeMode,
  type AgentMuxBrowserRegion,
  type AgentMuxControlBrowserRunOutcome,
  type AgentMuxControlBrowserOperation,
  type AgentMuxControlBrowserReplayPlan,
  type AgentMuxControlBrowserEvent,
  type AgentMuxControlBrowserSubscribeRequest,
  type AgentMuxControlBrowserSubscription,
  type AgentMuxControlMetricsRequest,
  type AgentMuxControlHost,
  type AgentMuxControlErrorReceipt,
  type AgentMuxControlErrorCode,
  type AgentMuxControlExecutor,
  type AgentMuxControlProject,
  type AgentMuxControlActiveAgent,
  type AgentMuxControlReceipt,
  type AgentMuxControlRequest,
  type AgentMuxControlResult,
  type AgentMuxControlSettingEntry,
  type AgentMuxControlSettingsResourceRequest,
  type AgentMuxControlSettingsResourceKind,
  type AgentMuxControlSettingsResourceItem,
  AGENTMUX_CONTROL_MAX_MESSAGE_BYTES,
  type AgentMuxControlDemandUpdateRequest,
  AGENTMUX_DEMAND_PRIORITIES,
  AGENTMUX_DEMAND_STATUSES,
  type AgentMuxDemandDecision,
  type AgentMuxDemand,
  type AgentMuxDemandPriority,
  type AgentMuxDemandStatus,
  type AgentMuxControlSuccessReceipt,
  type AgentMuxInspectedRegion,
  type AgentMuxMessageTarget,
  type AgentMuxOpenDestination,
  type AgentMuxRegion,
  type AgentMuxRegionAnchor,
  type AgentMuxRegionNeighbor,
  type AgentMuxRegionNeighbors,
  type AgentMuxTabAnchor,
  type AgentMuxTerminalRegion,
  type AgentMuxTerminalViewObservation
} from './control.js'
import { AgentMuxError } from './errors.js'
import { parseMetricsObservation, type MetricsObservation, type MetricsSubscription } from './metrics.js'
import { assertToolkitResultTarget, isToolkitOperation, parseToolkitRequest, parseToolkitResult } from './toolkit.js'
import { parseDesktopFocusRequest, parseDesktopFocusSuccessReceipt } from './desktop-focus-parser.js'
import { isBrowserTaskControlOperation, parseBrowserTaskControlPayload, parseBrowserTaskControlResult } from './browser-task-control.js'
import { parseBrowserTargetsResult } from './control-browser-targets.js'
import { isSpaceControlOperation, parseSpaceControlRequest, parseSpaceControlSuccessReceipt, spaceControlId } from './space-control-parser.js'
import { settingsResourceBudget, settingsResourceEnvelope, settingsResourceRecord } from './settings-resource-json.js'
import { parseRemoteCoreUpgradeCheck, parseRemoteCoreUpgradeExpected, parseRemoteCoreUpgradeReceipt } from './remote-core-upgrade-codec.js'
import { isWorkbenchLayoutPreset } from './workbench-layout-preset.js'
import { isSplitDirection } from './split-direction-ssot.js'
import { validateAgentMuxMessageEnvelope, type AgentMuxMessageEnvelope } from './agent-global-message-queue.js'

const MAX_MESSAGE_BYTES = AGENTMUX_CONTROL_MAX_MESSAGE_BYTES
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

function caller(value: unknown): { agentSessionId: string; capability?: string } {
  const source = object(value, 'Control caller is invalid.', 'INVALID_CONTROL_REQUEST')
  const agentSessionId = identity(source.agentSessionId, 'Control caller is invalid.', 'INVALID_CONTROL_REQUEST')
  if (source.capability !== undefined && (typeof source.capability !== 'string' || !source.capability.trim())) {
    throw new AgentMuxError('Control caller capability is invalid.', 'INVALID_CONTROL_REQUEST')
  }
  return { agentSessionId, ...(source.capability === undefined ? {} : { capability: source.capability }) }
}

function optionalCaller(value: unknown): { agentSessionId: string; capability?: string } | undefined {
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

function demandStatus(value: unknown): AgentMuxDemandStatus {
  if ((AGENTMUX_DEMAND_STATUSES as readonly unknown[]).includes(value)) return value as AgentMuxDemandStatus
  throw new AgentMuxError('Demand status is invalid.', 'INVALID_CONTROL_REQUEST')
}
function demandPriority(value: unknown): AgentMuxDemandPriority {
  if ((AGENTMUX_DEMAND_PRIORITIES as readonly unknown[]).includes(value)) return value as AgentMuxDemandPriority
  throw new AgentMuxError('Demand priority is invalid.', 'INVALID_CONTROL_REQUEST')
}
function arrayOfIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new AgentMuxError(`${label} are invalid.`, 'INVALID_CONTROL_REQUEST')
  return value.map((item) => id(item, `${label} are invalid.`, 'INVALID_CONTROL_REQUEST'))
}

function parseControlProjects(value: unknown): AgentMuxControlProject[] {
  if (!Array.isArray(value)) throw new AgentMuxError('Control projects are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value.map((item) => {
    const source = object(item, 'Control project is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return {
      projectId: spaceControlId(source.projectId, 'Control project id is invalid.', 'CONTROL_PROTOCOL_ERROR', true),
      name: text(source.name, 'Control project name', 'CONTROL_PROTOCOL_ERROR'),
      hostId: id(source.hostId, 'Control project host is invalid.', 'CONTROL_PROTOCOL_ERROR'),
      path: text(source.path, 'Control project path', 'CONTROL_PROTOCOL_ERROR'),
      kind: text(source.kind, 'Control project kind', 'CONTROL_PROTOCOL_ERROR'),
      repoPath: source.repoPath === null ? null : text(source.repoPath, 'Control project repo path', 'CONTROL_PROTOCOL_ERROR'),
      branch: source.branch === null ? null : text(source.branch, 'Control project branch', 'CONTROL_PROTOCOL_ERROR'),
      activeAgentSessionIds: arrayOfIds(source.activeAgentSessionIds, 'Control project Agent Session ids')
    }
  })
}

function parseControlActiveAgents(value: unknown): AgentMuxControlActiveAgent[] {
  if (!Array.isArray(value)) throw new AgentMuxError('Control active Agents are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value.map((item) => {
    const source = object(item, 'Control active Agent is invalid.', 'CONTROL_PROTOCOL_ERROR')
    const processState = source.processState
    if (processState !== 'running' && processState !== 'exited' && processState !== 'interrupted') throw new AgentMuxError('Control Agent process state is invalid.', 'CONTROL_PROTOCOL_ERROR')
    const status = source.status
    if (status !== 'active' && status !== 'idle' && status !== 'unknown') throw new AgentMuxError('Control Agent status is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return {
      agentSessionId: id(source.agentSessionId, 'Control Agent Session id is invalid.', 'CONTROL_PROTOCOL_ERROR'),
      ...(source.promptCondition === undefined ? {} : { promptCondition: validateAgentPromptCondition(source.promptCondition) }),
      projectId: source.projectId === null ? null : spaceControlId(source.projectId, 'Control Agent project id is invalid.', 'CONTROL_PROTOCOL_ERROR', true),
      projectName: source.projectName === null ? null : text(source.projectName, 'Control Agent project name', 'CONTROL_PROTOCOL_ERROR'),
      workspacePath: text(source.workspacePath, 'Control Agent workspace path', 'CONTROL_PROTOCOL_ERROR'),
      providerId: id(source.providerId, 'Control Agent provider id is invalid.', 'CONTROL_PROTOCOL_ERROR'),
      executorId: id(source.executorId, 'Control Agent executor id is invalid.', 'CONTROL_PROTOCOL_ERROR'),
      processState,
      status,
      updatedAt: finiteNumber(source.updatedAt, 'Control Agent timestamp is invalid.')
    }
  })
}
function demandDecision(value: unknown): AgentMuxDemandDecision {
  const source = object(value, 'Demand decision is invalid.', 'INVALID_CONTROL_REQUEST')
  const candidates = Array.isArray(source.candidates) ? source.candidates.map((item) => {
    const candidate = object(item, 'Demand decision candidate is invalid.', 'INVALID_CONTROL_REQUEST')
    return { projectId: spaceControlId(candidate.projectId, 'Demand decision project is invalid.', 'INVALID_CONTROL_REQUEST', true), reason: text(candidate.reason, 'Demand decision reason') }
  }) : []
  const risk = source.risk
  if (risk !== 'low' && risk !== 'medium' && risk !== 'high' && risk !== 'unknown') throw new AgentMuxError('Demand decision risk is invalid.', 'INVALID_CONTROL_REQUEST')
  const confirmation = source.confirmation
  if (confirmation !== 'automatic' && confirmation !== 'user' && confirmation !== 'pending') throw new AgentMuxError('Demand decision confirmation is invalid.', 'INVALID_CONTROL_REQUEST')
  return {
    input: text(source.input, 'Demand decision input'), candidates,
    selectedProjectId: source.selectedProjectId === null ? null : spaceControlId(source.selectedProjectId, 'Demand decision project is invalid.', 'INVALID_CONTROL_REQUEST', true),
    risk, confirmation,
    wikiVersion: source.wikiVersion === null || source.wikiVersion === undefined ? null : id(source.wikiVersion, 'Demand decision Wiki version is invalid.', 'INVALID_CONTROL_REQUEST'),
    recordedAt: finiteNumber(source.recordedAt, 'Demand decision timestamp is invalid.'),
    sourceSessionId: source.sourceSessionId === null || source.sourceSessionId === undefined ? null : id(source.sourceSessionId, 'Demand decision Session is invalid.', 'INVALID_CONTROL_REQUEST')
  }
}

export function parseAgentMuxControlRequest(value: unknown): AgentMuxControlRequest {
  const source = object(value, 'Control request is invalid.', 'INVALID_CONTROL_REQUEST')
  const operation = Object.getOwnPropertyDescriptor(source, 'operation')
  if (operation && !('value' in operation)) throw new AgentMuxError('Control operation must be data.', 'INVALID_CONTROL_REQUEST')
  if (isSpaceControlOperation(operation?.value)) return parseSpaceControlRequest(source)
  if (isToolkitOperation(operation?.value)) return parseToolkitRequest(source)
  if (source.schemaVersion !== AGENTMUX_CONTROL_SCHEMA_VERSION) throw new AgentMuxError('Control request version is invalid.', 'INVALID_CONTROL_REQUEST')
  const requestId = id(source.requestId, 'Control request ID is invalid.', 'INVALID_CONTROL_REQUEST')
  if (!isAgentMuxControlOperation(source.operation)) throw new AgentMuxError('Control operation is invalid.', 'INVALID_CONTROL_REQUEST')
  // Toolkit was handled from its own data descriptor above. Reject inherited
  // or inconsistent operation facts and keep the shared parser's exhaustive narrowing.
  if (isToolkitOperation(source.operation)) throw new AgentMuxError('Toolkit operation must be declared as data.', 'INVALID_CONTROL_REQUEST')
  if (isPendingMessageOperation(source.operation)) {
    const code = 'INVALID_CONTROL_REQUEST'
    const fields = ['schemaVersion', 'requestId', 'operation', 'agentSessionId',
      ...(source.operation === 'message.pending.ls' ? [] : ['pendingId']),
      ...(source.operation === 'message.pending.edit' ? ['expectedText', 'text'] :
        source.operation === 'message.pending.archive' || source.operation === 'message.pending.restore' ? ['expectedText'] : [])]
    settingsFields(source, fields, code)
    const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId,
      agentSessionId: identity(source.agentSessionId, 'Pending message Session ID is invalid.', code) }
    if (source.operation === 'message.pending.ls') return { ...base, operation: source.operation }
    const pendingId = identity(source.pendingId, 'Pending message ID is invalid.', code)
    if (source.operation === 'message.pending.send') return { ...base, operation: source.operation, pendingId }
    if (source.operation === 'message.pending.archive' || source.operation === 'message.pending.restore') {
      return { ...base, operation: source.operation, pendingId, expectedText: text(source.expectedText, 'Original message', code) }
    }
    const edited = text(source.text, 'Edited message', code)
    if (!edited.trim() || edited.includes('\0')) throw new AgentMuxError('Edited message is invalid.', code)
    return { ...base, operation: source.operation, pendingId, expectedText: text(source.expectedText, 'Original message', code), text: edited }
  }
  if (source.operation === 'metrics.get' || source.operation === 'metrics.watch') {
    if (Object.keys(source).some(key => !['schemaVersion', 'requestId', 'operation'].includes(key))) {
      throw new AgentMuxError('Metrics queries take no data parameters.', 'INVALID_CONTROL_REQUEST')
    }
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation }
  }
  if (source.operation === 'diagnostics.crash-log.get' || source.operation === 'diagnostics.crash-log.reveal') {
    if (Object.keys(source).some(key => !['schemaVersion', 'requestId', 'operation'].includes(key))) {
      throw new AgentMuxError('Crash log diagnostics take no data parameters.', 'INVALID_CONTROL_REQUEST')
    }
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation }
  }
  if (isSettingsResourceOperation(source.operation)) return settingsResourceRequest(source)
  if (source.operation === 'settings.executors.refresh') {
    const code = 'INVALID_CONTROL_REQUEST'
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'operation', 'executorId', 'hostId'], code)
    const executorId = text(source.executorId, 'Executor ID', code), hostId = text(source.hostId, 'Host ID', code)
    if (!executorId.length || !hostId.length) throw new AgentMuxError('Executor Refresh requires exact Executor and Host IDs.', code)
    const request = {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId,
      operation: source.operation,
      executorId,
      hostId
    }
    settingsResourceBudget(request, code)
    return request
  }
  if (source.operation === 'settings.workspaces.add') {
    const code = 'INVALID_CONTROL_REQUEST'
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'operation', 'input'], code)
    if (!Object.hasOwn(source, 'input')) throw new AgentMuxError('Workspace add input is required.', code)
    const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation,
      input: settingsResourceRecord(source.input, code) }
    settingsResourceBudget(request, code)
    return request
  }
  if (source.operation === 'settings.hosts.upgrade' || source.operation === 'settings.hosts.upgrade-inspect') {
    const code = 'INVALID_CONTROL_REQUEST'
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'operation', 'id', ...(source.operation === 'settings.hosts.upgrade' ? ['expected'] : [])], code)
    const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, id: text(source.id, 'Host ID', code) }
    return source.operation === 'settings.hosts.upgrade' ? { ...base, operation: source.operation, expected: parseRemoteCoreUpgradeExpected(source.expected) }
      : { ...base, operation: source.operation }
  }
  if (source.operation === 'settings.hosts.list' || source.operation === 'settings.hosts.test' || source.operation === 'settings.hosts.upgrade-check') {
    const code = 'INVALID_CONTROL_REQUEST'
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'operation', ...(source.operation !== 'settings.hosts.list' ? ['id', 'input'] : [])], code)
    const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId }
    if (source.operation === 'settings.hosts.list') return { ...base, operation: source.operation }
    if (Object.hasOwn(source, 'id') === Object.hasOwn(source, 'input')) throw new AgentMuxError('Host Test requires exactly one ID or input.', code)
    const request = Object.hasOwn(source, 'id')
      ? { ...base, operation: source.operation, id: text(source.id, 'Host ID', code) }
      : { ...base, operation: source.operation, input: settingsResourceRecord(source.input, code) }
    settingsResourceBudget(request, code)
    return request
  }
  if (source.operation === 'settings.browser.links.list' || source.operation === 'settings.browser.links.forget') {
    const code = 'INVALID_CONTROL_REQUEST'
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'operation', ...(source.operation === 'settings.browser.links.forget' ? ['scheme'] : [])], code)
    if (source.operation === 'settings.browser.links.forget' && !Object.hasOwn(source, 'scheme')) throw new AgentMuxError('Browser link scheme is required.', code)
    const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId }
    const request = source.operation === 'settings.browser.links.list' ? { ...base, operation: source.operation }
      : { ...base, operation: source.operation, scheme: text(source.scheme, 'Browser link scheme', code) }
    settingsResourceBudget(request, code)
    return request
  }
  if (source.operation === 'inspect.client') {
    settingsFields(source, ['schemaVersion', 'requestId', 'operation'], 'INVALID_CONTROL_REQUEST')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation }
  }
  if (source.operation === 'settings.get') {
    settingsFields(source, ['schemaVersion', 'requestId', 'operation', 'target'], 'INVALID_CONTROL_REQUEST')
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation,
      ...(source.target === undefined ? {} : { target: text(source.target, 'Settings target') })
    }
  }
  if (source.operation === 'settings.set') {
    settingsFields(source, ['schemaVersion', 'requestId', 'operation', 'key', 'value'], 'INVALID_CONTROL_REQUEST')
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation,
      key: text(source.key, 'Setting key'), value: text(source.value, 'Setting value')
    }
  }
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
  if (isSpaceControlOperation(source.operation)) return parseSpaceControlRequest(source)
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
    settingsFields(source, ['schemaVersion','requestId','operation','target','text','promptCondition','execution','sourceChannel','caller','message'], 'INVALID_CONTROL_REQUEST')
    if (source.execution !== undefined && source.execution !== 'default' && source.execution !== 'immediate') {
      throw new AgentMuxError('Prompt execution is invalid.', 'INVALID_CONTROL_REQUEST')
    }
    const target = messageTarget(source.target)
    const owner = optionalCaller(source.caller)
    if (target.kind === 'self' && !owner) throw new AgentMuxError('A self target requires a managed caller.', 'INVALID_CONTROL_REQUEST')
    const message = validateAgentMuxMessageEnvelope(source.message)
    if (message.body !== source.text) throw new AgentMuxError('Message body must equal Control text.', 'MESSAGE_ENVELOPE_INVALID')
    if (owner && message.sender.kind !== 'agent-session') throw new AgentMuxError('Managed send requires an Agent envelope.', 'MESSAGE_SENDER_MISMATCH')
    if (message.sender.kind === 'agent-session' && (!owner || !owner.capability || message.sender.agentSessionId !== owner.agentSessionId || message.senderSessionId !== owner.agentSessionId)) {
      throw new AgentMuxError('Message sender does not match the managed caller.', 'MESSAGE_SENDER_MISMATCH')
    }
    if (message.recipient.kind === 'agent-session' && target.kind === 'agent-session' && message.recipient.agentSessionId !== target.agentSessionId) {
      throw new AgentMuxError('Message recipient does not match the Control target.', 'MESSAGE_RECIPIENT_MISMATCH')
    }
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, target,
      text: text(source.text, 'Message text'), promptCondition: validateAgentPromptCondition(source.promptCondition),
      ...(source.execution === undefined ? {} : { execution: source.execution }),
      ...(source.sourceChannel === undefined ? {} : { sourceChannel: normalizeMessageChannel(source.sourceChannel) }),
      ...(owner ? { caller: owner } : {}), message }
  }
  if (source.operation === 'list.agents') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation }
  }
  if (source.operation === 'list.projects' || source.operation === 'list.active-agents') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation,
      ...(source.operation === 'list.active-agents' && source.agentSessionId !== undefined
        ? { agentSessionId: id(source.agentSessionId, 'Agent Session id is invalid.', 'INVALID_CONTROL_REQUEST') } : {}) }
  }
  if (source.operation === 'demand.list') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation }
  }
  if (source.operation === 'demand.show' || source.operation === 'demand.decision-log') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, demandId: id(source.demandId, 'Demand id is invalid.', 'INVALID_CONTROL_REQUEST') }
  }
  if (source.operation === 'demand.link-session') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, demandId: id(source.demandId, 'Demand id is invalid.', 'INVALID_CONTROL_REQUEST'), sessionId: id(source.sessionId, 'Agent Session id is invalid.', 'INVALID_CONTROL_REQUEST') }
  }
  if (source.operation === 'demand.link-project') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, demandId: id(source.demandId, 'Demand id is invalid.', 'INVALID_CONTROL_REQUEST'), projectId: spaceControlId(source.projectId, 'Project id is invalid.', 'INVALID_CONTROL_REQUEST', true) }
  }
  if (source.operation === 'demand.create') {
    const title = text(source.title, 'Demand title')
    const sessionIds = source.sessionIds === undefined ? undefined : arrayOfIds(source.sessionIds, 'Demand Session ids')
    return {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, title,
      ...(source.demandId === undefined ? {} : { demandId: id(source.demandId, 'Goal id is invalid.', 'INVALID_CONTROL_REQUEST') }),
      ...(source.description === undefined ? {} : { description: text(source.description, 'Demand description') }),
      ...(source.projectId === undefined ? {} : { projectId: spaceControlId(source.projectId, 'Project id is invalid.', 'INVALID_CONTROL_REQUEST', true) }),
      ...(source.priority === undefined ? {} : { priority: demandPriority(source.priority) }),
      ...(source.status === undefined ? {} : { status: demandStatus(source.status) }),
      ...(sessionIds ? { sessionIds } : {}),
      ...(source.decision === undefined ? {} : { decision: demandDecision(source.decision) })
    }
  }
  if (source.operation === 'demand.update') {
    const patchSource = object(source.patch, 'Demand patch is invalid.', 'INVALID_CONTROL_REQUEST')
    const patch: AgentMuxControlDemandUpdateRequest['patch'] = {}
    for (const key of ['revision', 'submissionId', 'confirmedAt', 'acceptedAt']) {
      if (key in patchSource) throw new AgentMuxError('Agent updates cannot supply acknowledgement fields.', 'INVALID_CONTROL_REQUEST')
    }
    try {
      if (patchSource.alignment !== undefined) patch.alignment = parseAlignmentProposal(patchSource.alignment)
      if (patchSource.grounding !== undefined) patch.grounding = parseGroundingProposal(patchSource.grounding)
    } catch (error) {
      throw new AgentMuxError(error instanceof Error ? error.message : String(error), 'INVALID_CONTROL_REQUEST')
    }
    if (patchSource.title !== undefined) patch.title = text(patchSource.title, 'Demand title')
    if (patchSource.description !== undefined) patch.description = text(patchSource.description, 'Demand description')
    if (patchSource.status !== undefined) patch.status = demandStatus(patchSource.status)
    if (patchSource.priority !== undefined) patch.priority = demandPriority(patchSource.priority)
    if (patchSource.projectId !== undefined) patch.projectId = patchSource.projectId === null ? null : spaceControlId(patchSource.projectId, 'Project id is invalid.', 'INVALID_CONTROL_REQUEST', true)
    if (patchSource.projectName !== undefined) patch.projectName = patchSource.projectName === null ? null : text(patchSource.projectName, 'Project name')
    if (patchSource.assigneeExecutorId !== undefined) patch.assigneeExecutorId = patchSource.assigneeExecutorId === null ? null : id(patchSource.assigneeExecutorId, 'Demand assignee is invalid.', 'INVALID_CONTROL_REQUEST')
    if (patchSource.tags !== undefined) patch.tags = Array.isArray(patchSource.tags) ? patchSource.tags.map((tag) => text(tag, 'Demand tag')) : (() => { throw new AgentMuxError('Demand tags are invalid.', 'INVALID_CONTROL_REQUEST') })()
    if (patchSource.plannedStartAt !== undefined) patch.plannedStartAt = patchSource.plannedStartAt === null ? null : finiteNumber(patchSource.plannedStartAt, 'Demand planned start timestamp is invalid.')
    if (patchSource.targetAt !== undefined) patch.targetAt = patchSource.targetAt === null ? null : finiteNumber(patchSource.targetAt, 'Demand target timestamp is invalid.')
    if (patchSource.parentDemandId !== undefined) patch.parentDemandId = patchSource.parentDemandId === null ? null : id(patchSource.parentDemandId, 'Parent Demand id is invalid.', 'INVALID_CONTROL_REQUEST')
    if (patchSource.phaseIndex !== undefined) patch.phaseIndex = patchSource.phaseIndex === null ? null : finiteNumber(patchSource.phaseIndex, 'Demand phase index is invalid.')
    if (patchSource.sessionIds !== undefined) patch.sessionIds = arrayOfIds(patchSource.sessionIds, 'Demand Session ids')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, demandId: id(source.demandId, 'Demand id is invalid.', 'INVALID_CONTROL_REQUEST'), patch, ...(source.decision === undefined ? {} : { decision: demandDecision(source.decision) }) }
  }
  if (source.operation === 'demand.discuss' || source.operation === 'demand.confirm' || source.operation === 'demand.accept') {
    const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, demandId: id(source.demandId, 'Goal id is invalid.', 'INVALID_CONTROL_REQUEST') }
    if (source.operation === 'demand.discuss') {
      if (!['open', 'grill', 'grounding'].includes(source.mode as string)) throw new AgentMuxError('Goal discussion mode is invalid.', 'INVALID_CONTROL_REQUEST')
      return { ...base, operation: source.operation, mode: source.mode as 'open' | 'grill' | 'grounding' }
    }
    const revision = source.operation === 'demand.confirm' ? source.expectedRevision : source.expectedAlignmentRevision
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new AgentMuxError('The exact positive Goal alignment revision is required.', 'INVALID_CONTROL_REQUEST')
    if (source.operation === 'demand.confirm') return { ...base, operation: source.operation, expectedRevision: revision as number }
    if (typeof source.acceptGaps !== 'boolean') throw new AgentMuxError('Result gaps require an explicit acceptance choice.', 'INVALID_CONTROL_REQUEST')
    return { ...base, operation: source.operation, expectedAlignmentRevision: revision as number, expectedSubmissionId: id(source.expectedSubmissionId, 'Goal submission id is invalid.', 'INVALID_CONTROL_REQUEST'), acceptGaps: source.acceptGaps }
  }
  if (source.operation === 'demand.assign') {
    if (typeof source.start !== 'boolean') throw new AgentMuxError('Demand assignment start flag is invalid.', 'INVALID_CONTROL_REQUEST')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, demandId: id(source.demandId, 'Demand id is invalid.', 'INVALID_CONTROL_REQUEST'), ...(source.projectId === undefined ? {} : { projectId: source.projectId === null ? null : spaceControlId(source.projectId, 'Project id is invalid.', 'INVALID_CONTROL_REQUEST', true) }), ...(source.assigneeExecutorId === undefined ? {} : { assigneeExecutorId: source.assigneeExecutorId === null ? null : id(source.assigneeExecutorId, 'Demand assignee is invalid.', 'INVALID_CONTROL_REQUEST') }), start: source.start }
  }
  if (source.operation === 'demand.start') {
    let continuation: { intervalMs: number; alignmentRevision: number } | undefined
    if (source.continuation !== undefined) {
      const c = object(source.continuation, 'Goal continuation is invalid.', 'INVALID_CONTROL_REQUEST')
      if (Object.keys(c).some(key => !['intervalMs', 'alignmentRevision'].includes(key)) || typeof c.intervalMs !== 'number' || !Number.isFinite(c.intervalMs) || c.intervalMs <= 0 || !Number.isSafeInteger(c.alignmentRevision) || (c.alignmentRevision as number) < 1 || source.sessionId === undefined) throw new AgentMuxError('Goal continuation needs an explicit Session, positive interval and confirmed alignment revision.', 'INVALID_CONTROL_REQUEST')
      continuation = { intervalMs: c.intervalMs, alignmentRevision: c.alignmentRevision as number }
    }
    const owner = optionalCaller(source.caller)
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, demandId: id(source.demandId, 'Demand id is invalid.', 'INVALID_CONTROL_REQUEST'), ...(source.sessionId === undefined ? {} : { sessionId: id(source.sessionId, 'Agent Session id is invalid.', 'INVALID_CONTROL_REQUEST') }), ...(continuation ? { continuation } : {}), ...(owner ? { caller: owner } : {}) }
  }
  if (source.operation === 'demand.continuation-action') {
    if (!['pause', 'resume', 'stop', 'check'].includes(source.action as string) || !Number.isSafeInteger(source.expectedRevision) || (source.expectedRevision as number) < 1) throw new AgentMuxError('Goal continuation action or revision is invalid.', 'INVALID_CONTROL_REQUEST')
    const owner = optionalCaller(source.caller)
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, demandId: id(source.demandId, 'Goal id is invalid.', 'INVALID_CONTROL_REQUEST'), loopId: id(source.loopId, 'Loop id is invalid.', 'INVALID_CONTROL_REQUEST'), action: source.action as 'pause' | 'resume' | 'stop' | 'check', expectedRevision: source.expectedRevision as number, ...(owner ? { caller: owner } : {}) }
  }
  if (source.operation === 'demand.handoff') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, demandId: id(source.demandId, 'Demand id is invalid.', 'INVALID_CONTROL_REQUEST'), ...(source.assigneeExecutorId === undefined ? {} : { assigneeExecutorId: source.assigneeExecutorId === null ? null : id(source.assigneeExecutorId, 'Demand assignee is invalid.', 'INVALID_CONTROL_REQUEST') }), ...(source.sessionId === undefined ? {} : { sessionId: id(source.sessionId, 'Agent Session id is invalid.', 'INVALID_CONTROL_REQUEST') }) }
  }
  if (source.operation === 'demand.delete') {
    if (source.confirmation !== 'delete') throw new AgentMuxError('Demand deletion requires explicit confirmation.', 'INVALID_CONTROL_REQUEST')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: source.operation, demandId: id(source.demandId, 'Demand id is invalid.', 'INVALID_CONTROL_REQUEST'), confirmation: 'delete' }
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
  if (source.operation === 'focus') return parseDesktopFocusRequest(source)
  if (source.operation === 'browser.targets') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId,
    operation: source.operation, ...(source.workspaceId === undefined ? {} : { workspaceId: id(source.workspaceId, 'Browser Workspace is invalid.', 'INVALID_CONTROL_REQUEST') }) }
  if (isBrowserTaskControlOperation(source.operation)) return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ...parseBrowserTaskControlPayload(source) }
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

function parseTerminalView(value: unknown): AgentMuxTerminalViewObservation {
  const message = 'Control terminal view observation is invalid.'
  const source = object(value, message, 'CONTROL_PROTOCOL_ERROR')
  const grid = object(source.viewGrid, message, 'CONTROL_PROTOCOL_ERROR')
  const rawBuffer = object(source.buffer, message, 'CONTROL_PROTOCOL_ERROR')
  const sampledAt = finiteNumber(source.sampledAt, message)
  const viewGrid = { cols: finiteNumber(grid.cols, message), rows: finiteNumber(grid.rows, message) }
  const bufferType = rawBuffer.type
  const mouseTrackingMode = source.mouseTrackingMode
  const buffer = { baseY: finiteNumber(rawBuffer.baseY, message), viewportY: finiteNumber(rawBuffer.viewportY, message), length: finiteNumber(rawBuffer.length, message) }
  if (sampledAt < 0 ||
    !Number.isSafeInteger(viewGrid.cols) || viewGrid.cols <= 0 ||
    !Number.isSafeInteger(viewGrid.rows) || viewGrid.rows <= 0 ||
    !Number.isSafeInteger(buffer.baseY) || buffer.baseY < 0 ||
    !Number.isSafeInteger(buffer.viewportY) || buffer.viewportY < 0 ||
    !Number.isSafeInteger(buffer.length) || buffer.length <= 0 ||
    buffer.viewportY > buffer.baseY || buffer.baseY >= buffer.length ||
    (bufferType !== 'normal' && bufferType !== 'alternate') ||
    (mouseTrackingMode !== 'none' && mouseTrackingMode !== 'x10' && mouseTrackingMode !== 'vt200' && mouseTrackingMode !== 'drag' && mouseTrackingMode !== 'any') ||
    typeof source.visible !== 'boolean' || typeof source.readOnly !== 'boolean' ||
    typeof source.liveReady !== 'boolean' || typeof source.acceptsInput !== 'boolean') {
    throw new AgentMuxError(message, 'CONTROL_PROTOCOL_ERROR')
  }
  return { runId: id(source.runId, message, 'CONTROL_PROTOCOL_ERROR'), sampledAt,
    visible: source.visible, readOnly: source.readOnly, liveReady: source.liveReady,
    acceptsInput: source.acceptsInput, viewGrid, buffer: { type: bufferType, ...buffer }, mouseTrackingMode }
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
          : source.kind === 'launcher' || source.kind === 'view'
            ? { ...base, kind: source.kind }
            : (() => { throw new AgentMuxError('Control Region result is invalid.', 'CONTROL_PROTOCOL_ERROR') })()
  if (!inspected) return region
  let terminalView: AgentMuxTerminalViewObservation | undefined
  if (source.terminalView !== undefined) {
    if (region.kind !== 'agent' && region.kind !== 'terminal') throw new AgentMuxError('Only Agent or Terminal Regions can carry a terminal view.', 'CONTROL_PROTOCOL_ERROR')
    terminalView = parseTerminalView(source.terminalView)
    if (region.kind === 'terminal' && terminalView.runId !== region.runId) throw new AgentMuxError('Terminal view Run does not match the Region.', 'CONTROL_PROTOCOL_ERROR')
  }
  const rawBounds = object(source.bounds, 'Control Region bounds are invalid.', 'CONTROL_PROTOCOL_ERROR')
  const bounds = { x: normalized(rawBounds.x), y: normalized(rawBounds.y), width: normalized(rawBounds.width), height: normalized(rawBounds.height) }
  if (bounds.width === 0 || bounds.height === 0 || bounds.x + bounds.width > 1 + Number.EPSILON || bounds.y + bounds.height > 1 + Number.EPSILON) throw new AgentMuxError('Control Region bounds are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return { ...region, bounds, neighbors: parseNeighbors(source.neighbors), ...(terminalView === undefined ? {} : { terminalView }) }
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

function parseDemand(value: unknown): AgentMuxDemand {
  const source = object(value, 'Control demand is invalid.', 'CONTROL_PROTOCOL_ERROR')
  let goalFacts: Pick<AgentMuxDemand, 'alignment' | 'grounding'> = {}
  try {
    goalFacts = {
      ...(source.alignment === undefined ? {} : { alignment: parseAlignment(source.alignment) }),
      ...(source.grounding === undefined ? {} : { grounding: parseGrounding(source.grounding) })
    }
  } catch (error) {
    throw new AgentMuxError(error instanceof Error ? error.message : 'Control Goal facts are invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  return {
    ...goalFacts,
    id: id(source.id, 'Control demand id is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    title: text(source.title, 'Control demand title', 'CONTROL_PROTOCOL_ERROR'),
    description: text(source.description, 'Control demand description', 'CONTROL_PROTOCOL_ERROR'),
    status: demandStatus(source.status) as AgentMuxDemand['status'],
    priority: demandPriority(source.priority) as AgentMuxDemand['priority'],
    projectId: source.projectId === null ? null : spaceControlId(source.projectId, 'Control demand project is invalid.', 'CONTROL_PROTOCOL_ERROR', true),
    projectName: source.projectName === null ? null : text(source.projectName, 'Control demand project name', 'CONTROL_PROTOCOL_ERROR'),
    ...(source.assigneeExecutorId === undefined ? {} : { assigneeExecutorId: source.assigneeExecutorId === null ? null : id(source.assigneeExecutorId, 'Control demand assignee is invalid.', 'CONTROL_PROTOCOL_ERROR') }),
    ...(source.tags === undefined ? {} : { tags: Array.isArray(source.tags) ? source.tags.map((tag) => text(tag, 'Control demand tag', 'CONTROL_PROTOCOL_ERROR')) : (() => { throw new AgentMuxError('Control demand tags are invalid.', 'CONTROL_PROTOCOL_ERROR') })() }),
    ...(source.activityLog === undefined ? {} : { activityLog: Array.isArray(source.activityLog)
      ? source.activityLog.map(item => text(item, 'Control Goal activity', 'CONTROL_PROTOCOL_ERROR'))
      : (() => { throw new AgentMuxError('Control Goal activity is invalid.', 'CONTROL_PROTOCOL_ERROR') })() }),
    ...(source.plannedStartAt === undefined ? {} : { plannedStartAt: source.plannedStartAt === null ? null : finiteNumber(source.plannedStartAt, 'Control demand planned start timestamp is invalid.') }),
    ...(source.targetAt === undefined ? {} : { targetAt: source.targetAt === null ? null : finiteNumber(source.targetAt, 'Control demand target timestamp is invalid.') }),
    ...(source.parentDemandId === undefined ? {} : { parentDemandId: source.parentDemandId === null ? null : id(source.parentDemandId, 'Control parent Demand is invalid.', 'CONTROL_PROTOCOL_ERROR') }),
    ...(source.phaseIndex === undefined ? {} : { phaseIndex: source.phaseIndex === null ? null : finiteNumber(source.phaseIndex, 'Control demand phase index is invalid.') }),
    sessionIds: arrayOfIds(source.sessionIds, 'Control demand Session ids'),
    createdAt: finiteNumber(source.createdAt, 'Control demand created timestamp is invalid.'),
    updatedAt: finiteNumber(source.updatedAt, 'Control demand updated timestamp is invalid.'),
    source: source.source === 'default-topic' || source.source === 'session' ? source.source : (() => { throw new AgentMuxError('Control demand source is invalid.', 'CONTROL_PROTOCOL_ERROR') })()
  }
}
function parseDemandDecisions(value: unknown): AgentMuxDemandDecision[] {
  if (!Array.isArray(value)) throw new AgentMuxError('Control demand decisions are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value.map((item) => demandDecision(item))
}

function successReceipt(request: AgentMuxControlRequest, result: AgentMuxControlResult): AgentMuxControlSuccessReceipt {
  if (request.operation !== result.operation) throw new AgentMuxError('Control result operation does not match its request.', 'CONTROL_PROTOCOL_ERROR')
  const { operation, ...body } = result
  return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: request.requestId, ok: true, operation, result: body } as AgentMuxControlSuccessReceipt
}

function settingsFields(source: Record<string, unknown>, allowed: readonly string[], code: string): void {
  if (Object.keys(source).some((key) => !allowed.includes(key))) {
    throw new AgentMuxError('Settings fields are invalid.', code)
  }
}

function resourceKind(value: unknown, code: string): AgentMuxControlSettingsResourceKind {
  if (value !== 'executors' && value !== 'prompts') throw new AgentMuxError('Settings resource is invalid.', code)
  return value
}

function isSettingsResourceOperation(operation: AgentMuxControlRequest['operation']): operation is AgentMuxControlSettingsResourceRequest['operation'] {
  return operation.startsWith('settings.resource.')
}

function settingsResourceRequest(source: Record<string, unknown>): AgentMuxControlSettingsResourceRequest {
  const code = 'INVALID_CONTROL_REQUEST', operation = source.operation
  const common = ['schemaVersion', 'requestId', 'operation', 'resource']
  const fields = operation === 'settings.resource.list' ? common : operation === 'settings.resource.add'
    ? [...common, 'id', 'value'] : operation === 'settings.resource.update'
      ? [...common, 'id', 'changes', 'expected'] : operation === 'settings.resource.remove'
        ? [...common, 'id', 'expected'] : [...common, 'id', 'keyword']
  settingsResourceEnvelope(source, fields, code)
  const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: id(source.requestId, 'Control request ID is invalid.', code), resource: resourceKind(source.resource, code) }
  let request: AgentMuxControlSettingsResourceRequest
  if (operation === 'settings.resource.list') request = { ...base, operation }
  else if (operation === 'settings.resource.get' && Object.hasOwn(source, 'keyword')) {
    if (base.resource !== 'prompts' || Object.hasOwn(source, 'id')) throw new AgentMuxError(
      'A Prompt lookup requires either its exact ID or its keyword, never both.', code)
    request = { ...base, resource: 'prompts', operation, keyword: id(source.keyword, 'Prompt keyword is invalid.', code) }
  } else {
    const resourceId = id(source.id, 'Settings resource ID is invalid.', code)
    if (operation === 'settings.resource.get') request = { ...base, operation, id: resourceId }
    else if (operation === 'settings.resource.add') {
      const value = settingsResourceRecord(source.value, code)
      if (Object.hasOwn(value, 'id')) throw new AgentMuxError('Resource ID must occur only in the envelope.', code)
      request = { ...base, operation, id: resourceId, value }
    } else {
      const expected = Object.hasOwn(source, 'expected') ? { expected: settingsResourceRecord(source.expected, code) } : {}
      if (operation === 'settings.resource.remove') request = { ...base, operation, id: resourceId, ...expected }
      else {
        const changes = settingsResourceRecord(source.changes, code)
        if (Object.keys(changes).length === 0) throw new AgentMuxError('Resource changes are empty.', code)
        request = { ...base, operation: 'settings.resource.update', id: resourceId, changes, ...expected }
      }
    }
  }
  settingsResourceBudget(request, code)
  return request
}

function resourceItem(value: unknown): AgentMuxControlSettingsResourceItem {
  const code = 'CONTROL_PROTOCOL_ERROR', source = settingsResourceEnvelope(value, ['id', 'value'], code)
  const fields = settingsResourceRecord(source.value, code)
  if (Object.hasOwn(fields, 'id')) throw new AgentMuxError('Resource ID must occur only in the item envelope.', code)
  return { id: id(source.id, 'Settings resource item ID is invalid.', code), value: fields }
}

function resourceReceipt(receipt: AgentMuxControlSuccessReceipt): AgentMuxControlSuccessReceipt {
  settingsResourceBudget(receipt, 'CONTROL_PROTOCOL_ERROR')
  return receipt
}

function settingEntry(value: unknown): AgentMuxControlSettingEntry {
  const source = object(value, 'Setting entry is invalid.', 'CONTROL_PROTOCOL_ERROR')
  settingsFields(source, ['key', 'kind', 'value', 'default', 'enum'], 'CONTROL_PROTOCOL_ERROR')
  const key = id(source.key, 'Setting key is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const kind = source.kind
  if (kind !== 'string' && kind !== 'boolean' && kind !== 'number') {
    throw new AgentMuxError('Setting kind is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  const scalar = (item: unknown): item is AgentMuxControlSettingEntry['value'] => (
    typeof item === kind && (typeof item !== 'number' || Number.isFinite(item))
  )
  if (!scalar(source.value) || !scalar(source.default)) {
    throw new AgentMuxError('Setting scalar is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  const choices = source.enum
  if (choices !== undefined && (!Array.isArray(choices) || choices.length === 0 ||
    !choices.every(scalar) || !choices.includes(source.value) || !choices.includes(source.default))) {
    throw new AgentMuxError('Setting enum is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  // The discriminator and all scalar members were checked together above.
  return { key, kind, value: source.value, default: source.default,
    ...(choices === undefined ? {} : { enum: choices }) } as AgentMuxControlSettingEntry
}

function parseSuccessReceipt(source: Record<string, unknown>): AgentMuxControlSuccessReceipt {
  const requestId = id(source.requestId, 'Control receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const result = object(source.result, 'Control receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (!isAgentMuxControlOperation(source.operation)) {
    throw new AgentMuxError('Control receipt operation is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  const operation: AgentMuxControlRequest['operation'] = source.operation
  if (isToolkitOperation(operation)) {
    const parsed = parseToolkitResult(operation, result)
    settingsResourceBudget(source, 'CONTROL_PROTOCOL_ERROR')
    const { operation: _operation, ...payload } = parsed
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: payload } as AgentMuxControlSuccessReceipt
  }
  if (isPendingMessageOperation(operation)) {
    const code = 'CONTROL_PROTOCOL_ERROR'
    settingsFields(result, operation === 'message.pending.ls' ? ['agentSessionId', 'messages']
      : operation !== 'message.pending.send' ? ['agentSessionId', 'message', 'changed']
      : ['agentSessionId', 'pendingId', 'disposition', 'message'], code)
    const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true as const }
    const agentSessionId = identity(result.agentSessionId, 'Pending message Session ID is invalid.', code)
    if (operation === 'message.pending.ls') {
      if (!Array.isArray(result.messages)) throw new AgentMuxError('Pending message list is invalid.', code)
      const messages = result.messages.map(parsePendingMessage)
      if (messages.filter(item => !item.archived).length > 100) throw new AgentMuxError('Active pending message list is invalid.', code)
      if (new Set(messages.map(item => item.pendingId)).size !== messages.length) throw new AgentMuxError('Pending message identities repeat.', code)
      return { ...base, operation, result: { agentSessionId, messages } }
    }
    if (operation !== 'message.pending.send') {
      if (typeof result.changed !== 'boolean') throw new AgentMuxError('Pending message edit result is invalid.', code)
      const message = parsePendingMessage(result.message)
      if (operation === 'message.pending.archive' && !message.archived || operation === 'message.pending.restore' && message.archived) {
        throw new AgentMuxError('Pending message archive result does not match the action.', code)
      }
      return { ...base, operation, result: { agentSessionId, message, changed: result.changed } }
    }
    const pendingId = identity(result.pendingId, 'Pending message ID is invalid.', code)
    if (result.disposition !== 'submitted' && result.disposition !== 'unconfirmed') throw new AgentMuxError('Pending message send result is invalid.', code)
    const message = result.message === null ? null : parsePendingMessage(result.message)
    if (message && message.pendingId !== pendingId) throw new AgentMuxError('Pending message send result belongs to another input.', code)
    return { ...base, operation, result: { agentSessionId, pendingId, disposition: result.disposition, message } }
  }
  if (operation === 'metrics.get') {
    settingsFields(result, ['observation'], 'CONTROL_PROTOCOL_ERROR')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation,
      result: { observation: parseMetricsObservation(result.observation) } }
  }
  if (operation === 'metrics.watch') {
    settingsFields(result, [], 'CONTROL_PROTOCOL_ERROR')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: {} }
  }
  if (operation === 'settings.executors.refresh') {
    const code = 'CONTROL_PROTOCOL_ERROR'
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'ok', 'operation', 'result'], code)
    const fields = settingsResourceRecord(result, code)
    settingsResourceEnvelope(fields, ['input', 'availability', 'executable', 'cause'], code)
    const captured = settingsResourceEnvelope(fields.input, ['executorId', 'providerId', 'command', 'host'], code)
    const input = {
      executorId: text(captured.executorId, 'Executor ID', code),
      providerId: text(captured.providerId, 'Provider ID', code),
      command: text(captured.command, 'Authored command', code),
      host: settingsResourceRecord(captured.host, code)
    }
    const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true as const, operation }
    settingsResourceBudget(source, code)
    const executable = Object.hasOwn(fields, 'executable') ? text(fields.executable, 'Resolved executable', code) : undefined
    if (fields.availability !== 'available' && fields.availability !== 'missing' && fields.availability !== 'check-failed') {
      throw new AgentMuxError('Executor Refresh outcome is invalid.', code)
    }
    if (fields.availability === 'available') {
      if (executable === undefined || Object.hasOwn(fields, 'cause')) throw new AgentMuxError('Available executable fact is invalid.', code)
      return { ...base, result: { input, executable, availability: fields.availability } }
    }
    const cause = Object.hasOwn(fields, 'cause') ? (() => {
      const value = settingsResourceEnvelope(fields.cause, ['code', 'message'], code)
      return { code: text(value.code, 'Check cause code', code), message: text(value.message, 'Check cause message', code) }
    })() : undefined
    if (fields.availability === 'check-failed') {
      if (!cause) throw new AgentMuxError('A failed executable check requires its cause.', code)
      return { ...base, result: { input, availability: fields.availability, cause, ...(executable === undefined ? {} : { executable }) } }
    }
    if (executable === undefined) throw new AgentMuxError('Missing executable fact is invalid.', code)
    return { ...base, result: { input, executable, availability: fields.availability, ...(cause ? { cause } : {}) } }
  }
  if (operation === 'diagnostics.crash-log.get' || operation === 'diagnostics.crash-log.reveal') {
    const code = 'CONTROL_PROTOCOL_ERROR'
    if (Object.keys(source).some(key => !['schemaVersion', 'requestId', 'ok', 'operation', 'result'].includes(key))) throw new AgentMuxError('Crash log receipt fields are invalid.', code)
    const path = text(result.path, 'Crash log path', code)
    if (operation === 'diagnostics.crash-log.reveal') {
      if (result.requested !== true || Object.keys(result).some(key => !['path', 'requested'].includes(key))) throw new AgentMuxError('Crash log request receipt is invalid.', code)
      return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { path, requested: true } }
    }
    if (result.outcome === 'present' || result.outcome === 'absent') {
      if (Object.keys(result).some(key => !['path', 'outcome'].includes(key))) throw new AgentMuxError('Crash log fact fields are invalid.', code)
      return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { path, outcome: result.outcome } }
    }
    if (result.outcome !== 'check-failed' || Object.keys(result).some(key => !['path', 'outcome', 'cause'].includes(key))) throw new AgentMuxError('Crash log fact is invalid.', code)
    const original = object(result.cause, 'Crash log cause is invalid.', code)
    if (Object.keys(original).some(key => !['code', 'message'].includes(key))) throw new AgentMuxError('Crash log cause fields are invalid.', code)
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { path, outcome: 'check-failed', cause: {
      code: text(original.code, 'Crash log cause code', code), message: text(original.message, 'Crash log cause message', code)
    } } }
  }
  if (operation === 'settings.workspaces.add') {
    const code = 'CONTROL_PROTOCOL_ERROR'
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'ok', 'operation', 'result'], code)
    settingsResourceEnvelope(result, ['item', 'changed'], code)
    if (!Object.hasOwn(result, 'item') || !Object.hasOwn(result, 'changed') || typeof result.changed !== 'boolean') {
      throw new AgentMuxError('Workspace add commit is invalid.', code)
    }
    return resourceReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation,
      result: { item: resourceItem(result.item), changed: result.changed } })
  }
  if (operation === 'settings.hosts.upgrade-check' || operation === 'settings.hosts.upgrade' || operation === 'settings.hosts.upgrade-inspect') {
    const code = 'CONTROL_PROTOCOL_ERROR'
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'ok', 'operation', 'result'], code)
    settingsResourceBudget(source, code)
    const fields = settingsResourceRecord(result, code)
    if (operation === 'settings.hosts.upgrade-check') {
      settingsResourceEnvelope(fields, ['check'], code)
      return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { check: parseRemoteCoreUpgradeCheck(fields.check) } }
    }
    settingsResourceEnvelope(fields, ['receipt'], code)
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { receipt: fields.receipt === null ? null : parseRemoteCoreUpgradeReceipt(fields.receipt) } }
  }
  if (operation === 'settings.hosts.list' || operation === 'settings.hosts.test') {
    const code = 'CONTROL_PROTOCOL_ERROR'
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'ok', 'operation', 'result'], code)
    settingsResourceBudget(source, code)
    const fields = settingsResourceRecord(result, code)
    if (operation === 'settings.hosts.list') {
      settingsResourceEnvelope(fields, ['hosts'], code)
      if (!Array.isArray(fields.hosts)) throw new AgentMuxError('Host list is invalid.', code)
      const hosts = fields.hosts.map(host => settingsResourceRecord(host, code))
      return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { hosts } }
    }
    settingsResourceEnvelope(fields, ['input', 'outcome', 'detail'], code)
    if (fields.outcome !== 'ready' && fields.outcome !== 'unsupported' && fields.outcome !== 'check-failed') throw new AgentMuxError('Host check outcome is invalid.', code)
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation,
      result: { input: settingsResourceRecord(fields.input, code), outcome: fields.outcome, detail: text(fields.detail, 'Host check detail', code) } }
  }
  if (operation === 'settings.browser.links.list' || operation === 'settings.browser.links.forget') {
    const code = 'CONTROL_PROTOCOL_ERROR'
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'ok', 'operation', 'result'], code)
    const fields = settingsResourceRecord(result, code)
    settingsResourceBudget(source, code)
    if (operation === 'settings.browser.links.list') {
      settingsResourceEnvelope(fields, ['entries'], code)
      if (!Object.hasOwn(fields, 'entries') || !Array.isArray(fields.entries)) throw new AgentMuxError('Browser link entries are invalid.', code)
      const entries = fields.entries.map(value => {
        const entry = settingsResourceEnvelope(value, ['scheme', 'choice'], code)
        if (!Object.hasOwn(entry, 'scheme') || !Object.hasOwn(entry, 'choice')) throw new AgentMuxError('Browser link entry fields are required.', code)
        return { scheme: text(entry.scheme, 'Browser link scheme', code), choice: text(entry.choice, 'Browser link choice', code) }
      })
      if (new Set(entries.map(entry => entry.scheme)).size !== entries.length) throw new AgentMuxError('Browser link schemes are duplicated.', code)
      return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { entries } }
    }
    settingsResourceEnvelope(fields, ['scheme', 'changed'], code)
    if (!Object.hasOwn(fields, 'scheme') || !Object.hasOwn(fields, 'changed') || typeof fields.changed !== 'boolean') throw new AgentMuxError('Browser link change is invalid.', code)
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation,
      result: { scheme: text(fields.scheme, 'Browser link scheme', code), changed: fields.changed } }
  }
  if (isSettingsResourceOperation(operation)) {
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'ok', 'operation', 'result'], 'CONTROL_PROTOCOL_ERROR')
    const code = 'CONTROL_PROTOCOL_ERROR', resource = resourceKind(result.resource, code)
    if (operation === 'settings.resource.list') {
      settingsResourceEnvelope(result, ['resource', 'items', 'partial'], code)
      if (result.partial !== true || !Array.isArray(result.items) || Object.getPrototypeOf(result.items) !== Array.prototype ||
        Reflect.ownKeys(result.items).length !== result.items.length + 1) throw new AgentMuxError('Resource list is invalid.', code)
      const items = Array.from({ length: result.items.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(result.items, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new AgentMuxError('Resource list is invalid.', code)
        return resourceItem(descriptor.value)
      })
      if (new Set(items.map(item => item.id)).size !== items.length) throw new AgentMuxError('Resource item IDs are not unique.', code)
      return resourceReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { resource, items, partial: true } })
    }
    if (operation === 'settings.resource.remove') {
      settingsResourceEnvelope(result, ['resource', 'id', 'removed'], code)
      if (result.removed !== true) throw new AgentMuxError('Resource removal is invalid.', code)
      return resourceReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation,
        result: { resource, id: id(result.id, 'Resource ID is invalid.', code), removed: true } })
    }
    if (operation === 'settings.resource.get') {
      settingsResourceEnvelope(result, ['resource', 'item'], code)
      return resourceReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { resource, item: resourceItem(result.item) } })
    }
    settingsResourceEnvelope(result, ['resource', 'item', 'changed'], code)
    if (typeof result.changed !== 'boolean') throw new AgentMuxError('Resource commit is invalid.', code)
    const body = { resource, item: resourceItem(result.item), changed: result.changed }
    if (operation === 'settings.resource.add') return resourceReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: body })
    return resourceReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation: 'settings.resource.update', result: body })
  }
  if (operation === 'inspect.client') {
    settingsFields(result, ['observation'], 'CONTROL_PROTOCOL_ERROR')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation,
      result: { observation: object(result.observation, 'Client observation is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  }
  if (operation === 'settings.get') {
    settingsFields(result, ['entries', 'partial'], 'CONTROL_PROTOCOL_ERROR')
    if (result.partial !== true || !Array.isArray(result.entries) || result.entries.length === 0) {
      throw new AgentMuxError('Settings result is invalid.', 'CONTROL_PROTOCOL_ERROR')
    }
    const entries = result.entries.map(settingEntry)
    if (new Set(entries.map(({ key }) => key)).size !== entries.length) {
      throw new AgentMuxError('Setting keys are not unique.', 'CONTROL_PROTOCOL_ERROR')
    }
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation,
      result: { entries, partial: true } }
  }
  if (operation === 'settings.set') {
    settingsFields(result, ['entry'], 'CONTROL_PROTOCOL_ERROR')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation,
      result: { entry: settingEntry(result.entry) } }
  }
  if (operation === 'inspect.tab') {
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { tab: parseTab(result.tab) } }
  }
  if (operation === 'inspect.region') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { region: parseRegion(result.region, true) } }
  if (isSpaceControlOperation(operation)) return parseSpaceControlSuccessReceipt(source)
  if (operation === 'open.terminal') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { region: parseTerminalRegion(result.region) } }
  if (operation === 'open.browser') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { region: parseBrowserRegion(result.region) } }
  if (operation === 'send') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { agentSessionId: identity(result.agentSessionId, 'Control send result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (operation === 'focus') return parseDesktopFocusSuccessReceipt(source)
  if (operation === 'arrange') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { tab: parseTab(result.tab) } }
  if (operation === 'promote.region') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { tabId: identity(result.tabId, 'Control promote result is invalid.', 'CONTROL_PROTOCOL_ERROR'), regionId: identity(result.regionId, 'Control promote result is invalid.', 'CONTROL_PROTOCOL_ERROR'), workspaceId: id(result.workspaceId, 'Control promote result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (operation === 'list.agents') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { agents: parseExecutors(result.agents) } }
  if (operation === 'list.projects') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { projects: parseControlProjects(result.projects) } }
  if (operation === 'list.active-agents') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { agents: parseControlActiveAgents(result.agents) } }
  if (operation === 'interrupt') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { agentSessionId: identity(result.agentSessionId, 'Control interrupt result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (operation === 'resume') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { agentSessionId: identity(result.agentSessionId, 'Control resume result is invalid.', 'CONTROL_PROTOCOL_ERROR'), runId: id(result.runId, 'Control resume result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (operation === 'stop') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { agentSessionId: identity(result.agentSessionId, 'Control stop result is invalid.', 'CONTROL_PROTOCOL_ERROR') } }
  if (operation === 'demand.list') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { demands: Array.isArray(result.demands) ? result.demands.map(parseDemand) : (() => { throw new AgentMuxError('Control demand list is invalid.', 'CONTROL_PROTOCOL_ERROR') })() } }
  if (operation === 'demand.show') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { demand: result.demand === null ? null : parseDemand(result.demand), goalContinuations: Array.isArray(result.goalContinuations) ? result.goalContinuations.map(parseGoalContinuationLoop) : (() => { throw new AgentMuxError('Goal continuations are unconfirmed.', 'CONTROL_PROTOCOL_ERROR') })() } }
  if (operation === 'demand.create' || operation === 'demand.update' || operation === 'demand.assign' || operation === 'demand.start' || operation === 'demand.handoff' || operation === 'demand.delete' || operation === 'demand.link-session' || operation === 'demand.link-project') {
    const demand = parseDemand(result.demand)
    const receipt = object(result.receipt, 'Control demand receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { demand, ...(operation === 'demand.start' && result.continuation !== undefined ? { continuation: parseGoalContinuationLoop(result.continuation) } : {}), receipt: { demandId: id(receipt.demandId, 'Control demand receipt id is invalid.', 'CONTROL_PROTOCOL_ERROR'), ...(operation === 'demand.link-session' ? { sessionId: id(receipt.sessionId, 'Control demand Session id is invalid.', 'CONTROL_PROTOCOL_ERROR') } : {}), ...(operation === 'demand.link-project' ? { projectId: spaceControlId(receipt.projectId, 'Control demand project id is invalid.', 'CONTROL_PROTOCOL_ERROR', true) } : {}), ...(operation === 'demand.create' ? { createdAt: finiteNumber(receipt.createdAt, 'Control demand receipt timestamp is invalid.') } : {}), ...(operation === 'demand.update' ? { updatedAt: finiteNumber(receipt.updatedAt, 'Control demand receipt timestamp is invalid.') } : {}), ...(operation === 'demand.assign' ? { assignedAt: finiteNumber(receipt.assignedAt, 'Control demand receipt timestamp is invalid.'), startRequested: receipt.startRequested === true } : {}), ...(operation === 'demand.start' ? { startedAt: finiteNumber(receipt.startedAt, 'Control demand receipt timestamp is invalid.'), sessionId: receipt.sessionId === null ? null : id(receipt.sessionId, 'Control demand Session id is invalid.', 'CONTROL_PROTOCOL_ERROR') } : {}), ...(operation === 'demand.handoff' ? { handedOffAt: finiteNumber(receipt.handedOffAt, 'Control demand receipt timestamp is invalid.'), sessionId: receipt.sessionId === null ? null : id(receipt.sessionId, 'Control demand Session id is invalid.', 'CONTROL_PROTOCOL_ERROR') } : {}), ...(operation === 'demand.delete' ? { deletedAt: finiteNumber(receipt.deletedAt, 'Control demand receipt timestamp is invalid.') } : {}) } } } as AgentMuxControlSuccessReceipt
  }
  if (operation === 'demand.discuss' || operation === 'demand.confirm' || operation === 'demand.accept') {
    const demand = parseDemand(result.demand), r = object(result.receipt, 'Goal receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
    const demandId = id(r.demandId, 'Goal id is invalid.', 'CONTROL_PROTOCOL_ERROR')
    if (operation === 'demand.discuss') {
      if (!['open', 'grill', 'grounding'].includes(r.mode as string)) throw new AgentMuxError('Goal discussion receipt mode is invalid.', 'CONTROL_PROTOCOL_ERROR')
      return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { demand, receipt: { demandId, requestId: id(r.requestId, 'Goal operation id is invalid.', 'CONTROL_PROTOCOL_ERROR'), mode: r.mode as 'open' | 'grill' | 'grounding', tabId: id(r.tabId, 'Goal Tab is invalid.', 'CONTROL_PROTOCOL_ERROR'), agentSessionId: r.agentSessionId === null ? null : id(r.agentSessionId, 'Goal Session is invalid.', 'CONTROL_PROTOCOL_ERROR') } } }
    }
    const revision = operation === 'demand.confirm' ? r.confirmedRevision : r.alignmentRevision
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new AgentMuxError('Goal receipt revision is invalid.', 'CONTROL_PROTOCOL_ERROR')
    if (operation === 'demand.confirm') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { demand, receipt: { demandId, confirmedRevision: revision as number, confirmedAt: finiteNumber(r.confirmedAt, 'Goal confirmation time is invalid.') } } }
    if (typeof r.acceptedWithGaps !== 'boolean') throw new AgentMuxError('Goal gap receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { demand, receipt: { demandId, alignmentRevision: revision as number, submissionId: id(r.submissionId, 'Goal submission is invalid.', 'CONTROL_PROTOCOL_ERROR'), acceptedAt: finiteNumber(r.acceptedAt, 'Goal acceptance time is invalid.'), acceptedWithGaps: r.acceptedWithGaps } } }
  }
  if (operation === 'demand.continuation-action') {
    if (result.diskDurability !== 'confirmed') throw new AgentMuxError('Continuation mutation durability is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { demandId: id(result.demandId, 'Goal id is invalid.', 'CONTROL_PROTOCOL_ERROR'), continuation: parseGoalContinuationLoop(result.continuation), diskDurability: 'confirmed' } }
  }
  if (operation === 'demand.decision-log') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: { demandId: id(result.demandId, 'Control demand id is invalid.', 'CONTROL_PROTOCOL_ERROR'), decisions: parseDemandDecisions(result.decisions) } }
  if (operation === 'browser.targets') return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: parseBrowserTargetsResult(result) }
  if (isBrowserTaskControlOperation(operation)) {
    const { operation: _, ...body } = parseBrowserTaskControlResult(operation, result)
    return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, ok: true, operation, result: body } as AgentMuxControlSuccessReceipt
  }
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
  const operationId = identity(source.id, 'Control browser operation id is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const browserId = identity(source.browserId, 'Control browser operation browser id is invalid.', 'CONTROL_PROTOCOL_ERROR')
  let completion: AgentMuxControlBrowserOperation['completion'], completionWarning: string | undefined
  if (source.completion !== undefined) {
    try { completion = parseBrowserCompletionFacts(source.completion, { operationId, browserId }) }
    catch { completionWarning = BROWSER_COMPLETION_UNAVAILABLE_WARNING }
  }
  const warning = [source.warning === undefined ? undefined : text(source.warning, 'Control browser operation warning is invalid.', 'CONTROL_PROTOCOL_ERROR'),
    completionWarning].filter(Boolean).join(' ')
  return {
    id: operationId,
    browserId,
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
    ...(completion ? { completion } : {}),
    ...(warning ? { warning } : {})
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
  const operation = Object.getOwnPropertyDescriptor(source, 'operation')
  if (operation && !('value' in operation)) throw new AgentMuxError('Control receipt operation must be data.', 'CONTROL_PROTOCOL_ERROR')
  if (isToolkitOperation(operation?.value)) {
    // Validate header descriptors before reads; the original typed result codec
    // owns nested retained executions, independently of the generic JSON depth.
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'ok', 'operation', 'result', 'error'], 'CONTROL_PROTOCOL_ERROR')
    settingsResourceEnvelope(source, ['schemaVersion', 'requestId', 'ok', 'operation', source.ok === true ? 'result' : 'error'], 'CONTROL_PROTOCOL_ERROR')
    const { result: _result, ...header } = source
    settingsResourceRecord(header, 'CONTROL_PROTOCOL_ERROR')
  }
  if (isSpaceControlOperation(operation?.value)) {
    const ok = Object.getOwnPropertyDescriptor(source, 'ok')
    if (ok && !('value' in ok)) throw new AgentMuxError('Control receipt status must be data.', 'CONTROL_PROTOCOL_ERROR')
    if (ok?.value === true) return parseSpaceControlSuccessReceipt(source)
  }
  if (operation?.value === 'focus' && Object.getOwnPropertyDescriptor(source, 'ok')?.value === true) return parseDesktopFocusSuccessReceipt(source)
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
