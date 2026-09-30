import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, type AgentMuxControlSuccessReceipt } from './control.js'
import { AgentMuxError } from './errors.js'
import { settingsResourceEnvelope } from './settings-resource-json.js'
import type {
  AgentMuxSpaceAddress, AgentMuxSpaceCatalog, AgentMuxSpaceControlRequest, AgentMuxSpaceControlResult,
  AgentMuxSpaceDestination, AgentMuxSpaceMutationReport, AgentMuxSpaceSelector, AgentMuxSpatialSave, AgentMuxSpaceBindingTarget, AgentMuxSpaceBindingReport
} from './space-control.js'

const MAX_SPATIAL_ID_BYTES = 16 * 1024
const MAX_ITEMS = 4096
type Code = 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR' | 'INVALID_CLI_ARGUMENT'
const fail = (message: string, code: Code): never => { throw new AgentMuxError(message, code) }
const fields = (value: unknown, allowed: readonly string[], code: Code) => settingsResourceEnvelope(value, allowed, code)

function string(value: unknown, name: string, code: Code, max = AGENTMUX_CONTROL_MAX_MESSAGE_BYTES): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) return fail(`${name} is invalid.`, code)
  return value
}
/** Space/Zone keys contain JSON-encoded absolute directories, including an escaped parent key. */
export function spaceControlId(value: unknown, name: string, code: Code, spatial = false): string {
  const result = string(value, name, code, spatial ? MAX_SPATIAL_ID_BYTES : 512)
  if (!result.trim() || result === 'self' || /[\0\r\n]/u.test(result)) return fail(`${name} requires an exact ID.`, code)
  return result
}
function bool(value: unknown, name: string, code: Code): boolean {
  if (typeof value !== 'boolean') return fail(`${name} must be boolean.`, code)
  return value
}
function member<T extends string>(value: unknown, members: readonly T[], name: string, code: Code): T {
  if (members.includes(value as T)) return value as T
  return fail(`${name} is invalid.`, code)
}
function list<T>(value: unknown, parse: (item: unknown) => T, name: string, code: Code): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ITEMS ||
    Reflect.ownKeys(value).length !== value.length + 1) return fail(`${name} is invalid.`, code)
  return Array.from({ length: value.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(value, String(index))
    if (!entry?.enumerable || !('value' in entry)) return fail(`${name} is invalid.`, code)
    return parse(entry.value)
  })
}
function unique<T>(values: T[], key: (item: T) => string, name: string, code: Code): T[] {
  if (new Set(values.map(key)).size !== values.length) return fail(`${name} contains duplicate IDs.`, code)
  return values
}
function budget(value: unknown, code: Code): void {
  if (Buffer.byteLength(JSON.stringify(value)) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) fail('Space Control envelope exceeds its byte budget.', code)
}
function nullableString(value: unknown, name: string, code: Code): string | null {
  return value === null ? null : string(value, name, code)
}
function nullableId(value: unknown, name: string, code: Code, spatial = false): string | null {
  return value === null ? null : spaceControlId(value, name, code, spatial)
}

export function parseSpaceControlSelector(value: unknown, code: Code): AgentMuxSpaceSelector {
  const source = fields(value, ['spaceId', 'zoneId', 'tabId', 'regionId', 'displayWorkspaceId', 'groupId'], code)
  const target: AgentMuxSpaceSelector = {}
  for (const key of ['spaceId', 'zoneId', 'tabId', 'regionId', 'displayWorkspaceId', 'groupId'] as const) {
    if (Object.hasOwn(source, key)) target[key] = spaceControlId(source[key], key, code, key === 'spaceId' || key === 'zoneId')
  }
  return target
}
const selector = parseSpaceControlSelector
function destination(value: unknown, code: Code): AgentMuxSpaceDestination {
  const source = fields(value, ['spaceId', 'zoneId', 'tabId', 'regionId', 'displayWorkspaceId', 'groupId', 'newTab', 'split', 'newZone'], code)
  const selected = Object.fromEntries(['spaceId', 'zoneId', 'tabId', 'regionId', 'displayWorkspaceId', 'groupId'].filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]))
  const result: AgentMuxSpaceDestination = selector(selected, code)
  if (Object.hasOwn(source, 'newTab') && bool(source.newTab, 'newTab', code)) result.newTab = true
  if (Object.hasOwn(source, 'split')) result.split = member(source.split, ['left', 'right', 'above', 'below'], 'split', code)
  if (result.split && !result.regionId) fail('Split requires an exact Region; discover it with agentmux space ls --zone <zone-id>.', code)
  if (result.newTab && (result.tabId || result.regionId || result.split)) fail('New Tab cannot also target a Tab or Region.', code)
  if (Object.hasOwn(source, 'newZone')) {
    const resource = fields(source.newZone, ['kind', 'path', 'branch', 'createBranch'], code)
    const path = string(resource.path, 'Zone directory', code, MAX_SPATIAL_ID_BYTES)
    if (!path.length || path.includes('\0')) fail('Zone directory is invalid.', code)
    if (resource.kind === 'directory') {
      fields(resource, ['kind', 'path'], code)
      result.newZone = { kind: 'directory', path }
    } else if (resource.kind === 'worktree') {
      const branch = string(resource.branch, 'Worktree branch', code, MAX_SPATIAL_ID_BYTES)
      if (!branch.length || branch.includes('\0')) fail('Worktree branch is invalid.', code)
      result.newZone = { kind: 'worktree', path, branch, createBranch: bool(resource.createBranch, 'createBranch', code) }
    } else fail('New Zone resource is invalid.', code)
    if (!result.spaceId || result.zoneId || result.tabId || result.regionId || result.split) fail('New Zone requires only an exact parent Space; discover it with agentmux space ls.', code)
    // Every new Zone opens its first Tab, whether the caller spells out --new-tab or not.
    result.newTab = true
  }
  if (!result.spaceId && !result.zoneId && !result.tabId && !result.regionId) {
    fail('A spatial target is required before opening or moving. Run agentmux space ls, then agentmux space ls --space <space-id>.', code)
  }
  if (!result.tabId && !result.regionId) result.newTab = true
  return result
}

export function isSpaceControlOperation(value: unknown): value is AgentMuxSpaceControlRequest['operation'] {
  return value === 'agent.open' || value === 'space.ls' || value === 'space.inspect' || value === 'space.mv' ||
    value === 'agent.rename' || value === 'agent.inspect' || value === 'space.rename' ||
    value === 'space.bind' || value === 'space.unbind'
}

export function parseSpaceControlRequest(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): AgentMuxSpaceControlRequest {
  const source = fields(value, ['schemaVersion', 'requestId', 'operation', 'target', 'content', 'destination', 'focus', 'caller', 'fromRegionId', 'expectedAgentSessionId', 'agentSessionId', 'tabId', 'name', 'fromLocation', 'binding'], code)
  if (source.schemaVersion !== 5 || !isSpaceControlOperation(source.operation)) fail('Space Control request is invalid.', code)
  const operation = source.operation as AgentMuxSpaceControlRequest['operation']
  const base = { schemaVersion: 5 as const, requestId: spaceControlId(source.requestId, 'Request ID', code) }
  let request: AgentMuxSpaceControlRequest
  if (operation === 'agent.rename') {
    fields(source, ['schemaVersion', 'requestId', 'operation', 'agentSessionId', 'name'], code)
    request = { ...base, operation, agentSessionId: spaceControlId(source.agentSessionId, 'Agent Session', code), name: nullableString(source.name, 'Display name', code) }
  } else if (operation === 'space.rename') {
    fields(source, ['schemaVersion', 'requestId', 'operation', 'tabId', 'name'], code)
    request = { ...base, operation, tabId: spaceControlId(source.tabId, 'Tab', code), name: nullableString(source.name, 'Display name', code) }
  } else if (operation === 'agent.inspect') {
    fields(source, ['schemaVersion', 'requestId', 'operation', 'agentSessionId'], code)
    request = { ...base, operation, agentSessionId: spaceControlId(source.agentSessionId, 'Agent Session', code) }
  } else if (operation === 'space.ls' || operation === 'space.inspect') {
    fields(source, ['schemaVersion', 'requestId', 'operation', 'target'], code)
    if (operation === 'space.inspect' && source.target && typeof source.target === 'object' && Object.hasOwn(source.target, 'requestId')) {
      const target = fields(source.target, ['requestId'], code)
      request = { ...base, operation, target: { requestId: spaceControlId(target.requestId, 'Inspected Request ID', code) } }
    } else {
      const target = selector(source.target, code)
      if (operation === 'space.inspect' && !['spaceId', 'zoneId', 'tabId', 'regionId'].some(key => Object.hasOwn(target, key))) fail('Space inspect requires one exact Space, Zone, Tab, Region, or Request.', code)
      if (operation === 'space.ls' && (target.tabId || target.regionId || Object.keys(target).length > 1)) fail('Space ls accepts one Space or Zone filter.', code)
      request = { ...base, operation, target }
    }
  } else if (operation === 'space.bind' || operation === 'space.unbind') {
    fields(source, ['schemaVersion', 'requestId', 'operation', 'binding'], code)
    request = { ...base, operation, binding: bindingTarget(source.binding, code) }
  } else if (operation === 'agent.open') {
    fields(source, ['schemaVersion', 'requestId', 'operation', 'content', 'destination', 'focus', 'caller'], code)
    const input = fields(source.content, ['kind', 'executorId', 'prompt', 'agentSessionId'], code)
    const target = destination(source.destination, code)
    let content!: Extract<AgentMuxSpaceControlRequest, { operation: 'agent.open' }>['content']
    if (input.kind === 'new-agent') {
      fields(input, ['kind', 'executorId', 'prompt'], code)
      content = { kind: 'new-agent', executorId: spaceControlId(input.executorId, 'Executor', code),
        ...(Object.hasOwn(input, 'prompt') ? { prompt: string(input.prompt, 'Initial prompt', code) } : {}) }
    } else if (input.kind === 'agent-session') {
      fields(input, ['kind', 'agentSessionId'], code)
      if (target.newZone) fail('Existing Session display cannot create a Zone.', code)
      content = { kind: 'agent-session', agentSessionId: spaceControlId(input.agentSessionId, 'Agent Session', code) }
    } else fail('Agent content is invalid.', code)
    const caller = Object.hasOwn(source, 'caller') ? (() => {
      const owner = fields(source.caller, ['agentSessionId', 'capability'], code)
      return { agentSessionId: spaceControlId(owner.agentSessionId, 'Caller Session', code),
        ...(Object.hasOwn(owner, 'capability') ? { capability: spaceControlId(owner.capability, 'Caller capability', code) } : {}) }
    })() : undefined
    request = { ...base, operation, content, destination: target, focus: bool(source.focus, 'focus', code), ...(caller ? { caller } : {}) }
  } else {
    fields(source, ['schemaVersion', 'requestId', 'operation', 'fromRegionId', 'expectedAgentSessionId', 'destination', 'focus', 'fromLocation'], code)
    const target = destination(source.destination, code)
    if (target.newZone) fail('Space move cannot create a Zone.', code)
    request = { ...base, operation, fromRegionId: spaceControlId(source.fromRegionId, 'Source Region', code),
      expectedAgentSessionId: spaceControlId(source.expectedAgentSessionId, 'Expected Session', code), destination: target, focus: bool(source.focus, 'focus', code),
      ...(Object.hasOwn(source, 'fromLocation') ? { fromLocation: selector(fields(source.fromLocation, ['spaceId', 'displayWorkspaceId', 'groupId'], code), code) } : {}) }
  }
  budget(request, code)
  return request
}

function bindingTarget(value: unknown, code: Code): AgentMuxSpaceBindingTarget {
  const source = fields(value, ['kind', 'zoneId', 'spaceId', 'tabId', 'displayWorkspaceId', 'groupId'], code)
  if (source.kind === 'zone-space') {
    fields(source, ['kind', 'zoneId', 'spaceId'], code)
    return { kind: 'zone-space', zoneId: spaceControlId(source.zoneId, 'Zone', code, true), spaceId: spaceControlId(source.spaceId, 'Space', code, true) }
  }
  if (source.kind === 'tab-group') {
    fields(source, ['kind', 'tabId', 'displayWorkspaceId', 'groupId'], code)
    return { kind: 'tab-group', tabId: spaceControlId(source.tabId, 'Tab', code),
      displayWorkspaceId: spaceControlId(source.displayWorkspaceId, 'Display Workspace', code), groupId: spaceControlId(source.groupId, 'Group', code) }
  }
  return fail('Binding target is invalid.', code)
}
function address(value: unknown, code: Code): AgentMuxSpaceAddress {
  const source = fields(value, ['spaceId', 'zoneId', 'workspaceId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'], code)
  return { spaceId: nullableId(source.spaceId, 'Space', code, true), zoneId: nullableId(source.zoneId, 'Zone', code, true),
    workspaceId: spaceControlId(source.workspaceId, 'Resource Workspace', code),
    displayWorkspaceId: spaceControlId(source.displayWorkspaceId, 'Display Workspace', code), groupId: spaceControlId(source.groupId, 'Group', code),
    tabId: spaceControlId(source.tabId, 'Tab', code), regionId: spaceControlId(source.regionId, 'Region', code) }
}
function catalog(value: unknown, code: Code): AgentMuxSpaceCatalog {
  const source = fields(value, ['spaces', 'zones', 'tabs', 'regions', 'bindings', 'locations'], code)
  const spaces = unique(list(source.spaces, value => {
    const item = fields(value, ['spaceId', 'kind', 'name', 'hostId', 'directoryPath', 'projectId', 'topicId', 'issue'], code)
    return { spaceId: spaceControlId(item.spaceId, 'Space', code, true), kind: member(item.kind, ['folder', 'topic', 'mote', 'container'], 'Space kind', code),
      name: string(item.name, 'Space name', code), hostId: spaceControlId(item.hostId, 'Host', code), directoryPath: string(item.directoryPath, 'Directory', code),
      projectId: nullableId(item.projectId, 'Project', code, true),
      ...(Object.hasOwn(item, 'topicId') ? { topicId: spaceControlId(item.topicId, 'Topic', code) } : {}),
      ...(Object.hasOwn(item, 'issue') ? { issue: string(item.issue, 'Space issue', code) } : {}) }
  }, 'Spaces', code), item => item.spaceId, 'Spaces', code)
  const zones = unique(list(source.zones, value => {
    const item = fields(value, ['zoneId', 'workspaceId', 'kind', 'hostId', 'directoryPath', 'branch', 'issue'], code)
    return { zoneId: spaceControlId(item.zoneId, 'Zone', code, true), workspaceId: spaceControlId(item.workspaceId, 'Workspace', code),
      kind: member(item.kind, ['directory', 'worktree', 'home', 'unknown'], 'Zone kind', code), hostId: nullableId(item.hostId, 'Host', code),
      directoryPath: nullableString(item.directoryPath, 'Directory', code), branch: nullableString(item.branch, 'Branch', code),
      ...(Object.hasOwn(item, 'issue') ? { issue: string(item.issue, 'Zone issue', code) } : {}) }
  }, 'Zones', code), item => item.zoneId, 'Zones', code)
  const tabs = unique(list(source.tabs, value => {
    const item = fields(value, ['zoneId', 'workspaceId', 'tabId', 'name', 'regionIds', 'issue'], code)
    return { zoneId: nullableId(item.zoneId, 'Zone', code, true), workspaceId: spaceControlId(item.workspaceId, 'Workspace', code),
      tabId: spaceControlId(item.tabId, 'Tab', code), name: nullableString(item.name, 'Tab name', code),
      regionIds: unique(list(item.regionIds, value => spaceControlId(value, 'Region', code), 'Region IDs', code), value => value, 'Region IDs', code), ...(Object.hasOwn(item, 'issue') ? { issue: string(item.issue, 'Tab issue', code) } : {}) }
  }, 'Tabs', code), item => item.tabId, 'Tabs', code)
  const regions = unique(list(source.regions, value => {
    const item = fields(value, ['tabId', 'regionId', 'kind', 'agentSessionId', 'runId', 'execution'], code)
    const execution = item.execution === null ? null : (() => {
      const location = fields(item.execution, ['hostId', 'cwd'], code)
      return { hostId: spaceControlId(location.hostId, 'Execution Host', code), cwd: string(location.cwd, 'Execution cwd', code) }
    })()
    return { tabId: spaceControlId(item.tabId, 'Tab', code), regionId: spaceControlId(item.regionId, 'Region', code),
      kind: member(item.kind, ['agent', 'terminal', 'browser', 'file', 'git-diff', 'launcher'], 'Region kind', code),
      agentSessionId: nullableId(item.agentSessionId, 'Agent Session', code), runId: nullableId(item.runId, 'Run', code), execution }
  }, 'Regions', code), item => item.regionId, 'Regions', code)
  const bindings = unique(list(source.bindings, value => {
    const item = fields(value, ['zoneId', 'spaceId'], code)
    return { zoneId: spaceControlId(item.zoneId, 'Zone', code, true), spaceId: spaceControlId(item.spaceId, 'Space', code, true) }
  }, 'Bindings', code), item => JSON.stringify([item.zoneId, item.spaceId]), 'Bindings', code)
  const locations = unique(list(source.locations, value => address(value, code), 'Locations', code), item => JSON.stringify(item), 'Locations', code)
  return { spaces, zones, tabs, regions, bindings, locations }
}
function issues(value: unknown, code: Code): AgentMuxSpaceBindingReport['issues'] {
  return list(value, value => {
    const item = fields(value, ['step', 'code', 'message', 'recovery', 'candidates'], code)
    return { step: string(item.step, 'Issue step', code), code: string(item.code, 'Issue code', code), message: string(item.message, 'Issue message', code), recovery: string(item.recovery, 'Issue recovery', code),
      ...(Object.hasOwn(item, 'candidates') ? { candidates: list(item.candidates, value => selector(value, code), 'Spatial candidates', code) } : {}) }
  }, 'Issues', code)
}

function save(value: unknown, code: Code): AgentMuxSpatialSave {
  const saved = fields(value, ['layoutApplied', 'localStorageWritten', 'storageFlushRequested', 'diskDurability', 'reason'], code)
  return { layoutApplied: bool(saved.layoutApplied, 'layoutApplied', code), localStorageWritten: bool(saved.localStorageWritten, 'localStorageWritten', code),
    storageFlushRequested: bool(saved.storageFlushRequested, 'storageFlushRequested', code), diskDurability: member(saved.diskDurability, ['unconfirmed'], 'Disk durability', code),
    reason: nullableString(saved.reason, 'Save reason', code) }
}
function report(value: unknown, code: Code): AgentMuxSpaceMutationReport {
  const source = fields(value, ['requestId', 'outcome', 'from', 'to', 'agent', 'resource', 'save', 'issues'], code)
  const agent = source.agent === null ? null : (() => {
    const item = fields(source.agent, ['agentSessionId', 'runId', 'providerId', 'executorId', 'hostId', 'cwd', 'createOperationId', 'initialPrompt'], code)
    return { agentSessionId: spaceControlId(item.agentSessionId, 'Agent Session', code), runId: nullableId(item.runId, 'Run', code),
      providerId: nullableId(item.providerId, 'Provider', code), executorId: nullableId(item.executorId, 'Executor', code), hostId: spaceControlId(item.hostId, 'Host', code),
      cwd: string(item.cwd, 'Execution cwd', code), createOperationId: nullableId(item.createOperationId, 'Creation operation', code),
      initialPrompt: member(item.initialPrompt, ['not-requested', 'confirmed', 'unconfirmed', 'unknown'], 'Initial prompt', code) }
  })()
  const resource = source.resource === null ? null : (() => {
    const item = fields(source.resource, ['hostId', 'path', 'workspaceId', 'kind', 'branch'], code)
    return { hostId: spaceControlId(item.hostId, 'Resource Host', code), path: string(item.path, 'Resource directory', code),
      workspaceId: nullableId(item.workspaceId, 'Workspace', code), kind: member(item.kind, ['directory', 'worktree'], 'Resource kind', code), branch: nullableString(item.branch, 'Branch', code) }
  })()
  return { requestId: spaceControlId(source.requestId, 'Mutation Request', code), outcome: member(source.outcome, ['opened', 'moved', 'unchanged', 'partial', 'unknown'], 'Mutation outcome', code),
    from: source.from === null ? null : address(source.from, code), to: source.to === null ? null : address(source.to, code), agent, resource,
    save: save(source.save, code),
    issues: list(source.issues, value => {
      const item = fields(value, ['step', 'code', 'message', 'recovery', 'candidates'], code)
      return { step: string(item.step, 'Issue step', code), code: string(item.code, 'Issue code', code), message: string(item.message, 'Issue message', code), recovery: string(item.recovery, 'Issue recovery', code),
        ...(Object.hasOwn(item, 'candidates') ? { candidates: list(item.candidates, value => selector(value, code), 'Spatial candidates', code) } : {}) }
    }, 'Issues', code) }
}

export function parseSpaceControlSuccessReceipt(value: unknown): AgentMuxControlSuccessReceipt {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const source = fields(value, ['schemaVersion', 'requestId', 'ok', 'operation', 'result'], code)
  if (source.schemaVersion !== 5 || source.ok !== true || !isSpaceControlOperation(source.operation)) fail('Space Control receipt is invalid.', code)
  const operation = source.operation as AgentMuxSpaceControlRequest['operation']
  const requestId = spaceControlId(source.requestId, 'Receipt Request', code)
  let result: AgentMuxSpaceControlResult
  if (operation === 'agent.inspect') {
    const body = fields(source.result, ['agentSessionId', 'override'], code)
    result = { operation, agentSessionId: spaceControlId(body.agentSessionId, 'Agent Session', code), override: nullableString(body.override, 'Display override', code) }
  } else if (operation === 'agent.rename' || operation === 'space.rename') {
    const target = operation === 'agent.rename' ? 'agentSessionId' : 'tabId'
    const body = fields(source.result, [target, 'override', 'changed', 'outcome', 'save'], code)
    const actual = { override: nullableString(body.override, 'Display override', code), changed: bool(body.changed, 'Changed', code),
      outcome: member(body.outcome, ['renamed', 'unchanged', 'partial'], 'Rename outcome', code), save: save(body.save, code) }
    result = operation === 'agent.rename'
      ? { operation, agentSessionId: spaceControlId(body.agentSessionId, 'Agent Session', code), ...actual }
      : { operation, tabId: spaceControlId(body.tabId, 'Tab', code), ...actual }
  } else if (operation === 'space.ls') {
    const body = fields(source.result, ['catalog'], code)
    result = { operation, catalog: catalog(body.catalog, code) }
  } else if (operation === 'space.inspect') {
    const body = fields(source.result, ['catalog', 'request'], code)
    const request = Object.hasOwn(body, 'request') ? (() => {
      const item = fields(body.request, ['requestId', 'known', 'report'], code)
      const id = spaceControlId(item.requestId, 'Inspected Request', code)
      const actual = item.report === null ? null : report(item.report, code)
      const known = bool(item.known, 'Known request', code)
      if ((!known && actual !== null) || (actual && actual.requestId !== id)) fail('Inspected Request report is mismatched.', code)
      return { requestId: id, known, report: actual }
    })() : undefined
    result = { operation, catalog: catalog(body.catalog, code), ...(request ? { request } : {}) }
  } else if (operation === 'space.bind' || operation === 'space.unbind') {
    const body = fields(source.result, ['requestId', 'outcome', 'binding', 'catalog', 'save', 'issues'], code)
    if (body.requestId !== requestId) fail('Binding receipt Request ID is mismatched.', code)
    result = { operation, requestId, outcome: member(body.outcome, ['linked', 'unlinked', 'unchanged', 'unknown'], 'Binding outcome', code),
      binding: bindingTarget(body.binding, code), catalog: catalog(body.catalog, code), save: save(body.save, code), issues: issues(body.issues, code) }
  } else {
    const actual = report(source.result, code)
    if (actual.requestId !== requestId) fail('Mutation receipt Request ID is mismatched.', code)
    result = operation === 'agent.open' ? { operation, ...actual } : { operation, ...actual }
  }
  const { operation: resultOperation, ...body } = result
  const receipt = { schemaVersion: 5 as const, requestId, ok: true as const, operation: resultOperation, result: body }
  budget(receipt, code)
  return receipt as AgentMuxControlSuccessReceipt
}
