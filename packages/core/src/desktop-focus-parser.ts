import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, type AgentMuxControlFocusRequest, type AgentMuxControlSuccessReceipt } from './control.js'
import { AgentMuxError } from './errors.js'
import { settingsResourceEnvelope } from './settings-resource-json.js'
import { parseSpaceControlSelector, spaceControlId } from './space-control-parser.js'
import type {
  AgentMuxDesktopFocusTarget, AgentMuxDesktopFloating, AgentMuxDesktopInput,
  AgentMuxDesktopObservation, AgentMuxDesktopOverlays, AgentMuxDesktopPresentation,
  AgentMuxDesktopSelection, AgentMuxDesktopSpaceSelection, AgentMuxDesktopFocusResult
} from './desktop-focus-control.js'

type Code = 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR' | 'INVALID_CLI_ARGUMENT'
const fail = (message: string, code: Code): never => { throw new AgentMuxError(message, code) }
const fields = settingsResourceEnvelope
const surfaces = ['space', 'focus', 'goals', 'survey'] as const
const mainSurfaces = { space: 'workbench', focus: 'agents', goals: 'board', survey: 'survey' } as const
function member<T extends string>(value: unknown, values: readonly T[], name: string, code: Code): T {
  if (!values.includes(value as T)) fail(`${name} is invalid.`, code)
  return value as T
}
function boolean(value: unknown, name: string, code: Code): boolean {
  if (typeof value !== 'boolean') fail(`${name} must be boolean.`, code)
  return value as boolean
}
const nullableId = (value: unknown, name: string, code: Code, spatial = false) =>
  value === null ? null : spaceControlId(value, name, code, spatial)
const nullableBoolean = (value: unknown, name: string, code: Code) =>
  value === null ? null : boolean(value, name, code)
const provenance = (value: unknown, code: Code) => member(value, ['observed', 'unavailable', 'unknown'], 'Provenance', code)
function list<T>(value: unknown, parse: (item: unknown) => T, code: Code): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 4096 ||
    Reflect.ownKeys(value).length !== value.length + 1) return fail('Desktop fact list is invalid.', code)
  return Array.from({ length: value.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(value, String(index))
    if (!item?.enumerable || !('value' in item)) return fail('Desktop fact list requires data entries.', code)
    return parse(item.value)
  })
}
function text(value: unknown, name: string, code: Code): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) fail(`${name} is invalid.`, code)
  return value as string
}
function budget(value: unknown, code: Code): void {
  if (Buffer.byteLength(JSON.stringify(value)) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) fail('Desktop Control exceeds its byte budget.', code)
}

function parseDesktopFocusTarget(value: unknown, code: Code): AgentMuxDesktopFocusTarget {
  const source = fields(value, ['kind', 'spaceId', 'zoneId', 'tabId', 'regionId', 'displayWorkspaceId', 'groupId', 'goalId', 'surface'], code)
  if (source.kind === 'space') {
    fields(source, ['kind', 'spaceId', 'zoneId', 'tabId', 'regionId', 'displayWorkspaceId', 'groupId'], code)
    const { kind: _, ...raw } = source
    const target = parseSpaceControlSelector(raw, code)
    if (!Object.keys(target).length) fail('Focus requires a Space/Zone/Tab/Region identity.', code)
    return { kind: 'space', ...target }
  }
  if (source.kind === 'goal') {
    fields(source, ['kind', 'goalId'], code)
    return { kind: 'goal', goalId: spaceControlId(source.goalId, 'Goal ID', code) }
  }
  if (source.kind === 'surface') {
    fields(source, ['kind', 'surface'], code)
    return { kind: 'surface', surface: member(source.surface, surfaces, 'Surface', code) }
  }
  return fail('Focus target is invalid.', code)
}

export function parseDesktopFocusRequest(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): AgentMuxControlFocusRequest {
  const source = fields(value, ['schemaVersion', 'requestId', 'operation', 'target', 'inputPolicy'], code)
  if (source.schemaVersion !== 5 || source.operation !== 'focus') fail('Desktop focus request is invalid.', code)
  const target = parseDesktopFocusTarget(source.target, code)
  const inputPolicy = Object.hasOwn(source, 'inputPolicy')
    ? member(source.inputPolicy, ['preserve', 'target'], 'Input policy', code) : 'preserve'
  if (inputPolicy === 'target' && (target.kind !== 'space' || (!target.tabId && !target.regionId))) {
    fail('Input target requires one exact existing Tab or Region.', code)
  }
  const request = { schemaVersion: 5 as const, requestId: spaceControlId(source.requestId, 'Request ID', code), operation: 'focus' as const, target, inputPolicy }
  budget(request, code)
  return request
}

function spaceSelection(value: unknown, code: Code): AgentMuxDesktopSpaceSelection | null {
  if (value === null) return null
  const source = fields(value, ['spaceId', 'zoneId', 'workspaceId', 'tabId', 'groupId', 'regionId', 'topicId'], code)
  const result = { spaceId: nullableId(source.spaceId, 'Space', code, true), zoneId: nullableId(source.zoneId, 'Zone', code, true),
    workspaceId: spaceControlId(source.workspaceId, 'Workspace', code), tabId: nullableId(source.tabId, 'Tab', code),
    groupId: nullableId(source.groupId, 'Tab Group', code), regionId: nullableId(source.regionId, 'Region', code), topicId: nullableId(source.topicId, 'Topic', code) }
  if ((result.tabId === null) !== (result.groupId === null) || (result.regionId !== null && result.tabId === null)) {
    fail('Desktop selection parent identities are incomplete.', code)
  }
  return result
}
function selection(value: unknown, code: Code): AgentMuxDesktopSelection {
  const source = fields(value, ['surface', 'mainSurface', 'space', 'goalId'], code)
  const surface = member(source.surface, surfaces, 'Surface', code)
  if (source.mainSurface !== mainSurfaces[surface]) fail('Public and internal Surface disagree.', code)
  return { surface, mainSurface: mainSurfaces[surface], space: spaceSelection(source.space, code), goalId: nullableId(source.goalId, 'Selected Goal', code) }
}
function input(value: unknown, code: Code): AgentMuxDesktopInput {
  const source = fields(value, ['provenance', 'scope', 'ownerKind', 'tabId', 'regionId', 'sessionId', 'connected', 'visible', 'inert'], code)
  return { provenance: provenance(source.provenance, code), scope: member(source.scope, ['main', 'floating', 'overlay', 'none', 'unknown'], 'Input scope', code),
    ownerKind: source.ownerKind === null ? null : member(source.ownerKind, ['terminal', 'composer', 'editor', 'dialog', 'other'] as const, 'Input owner', code),
    tabId: nullableId(source.tabId, 'Input Tab', code), regionId: nullableId(source.regionId, 'Input Region', code), sessionId: nullableId(source.sessionId, 'Input Session', code),
    connected: nullableBoolean(source.connected, 'Input connected', code), visible: nullableBoolean(source.visible, 'Input visible', code), inert: nullableBoolean(source.inert, 'Input inert', code) }
}
function presentation(value: unknown, code: Code): AgentMuxDesktopPresentation {
  const source = fields(value, ['provenance', 'state', 'tabId', 'regionId', 'blockers'], code)
  const result = { provenance: provenance(source.provenance, code), state: member(source.state, ['main-visible', 'floating', 'covered', 'pending', 'unknown'], 'Presentation', code),
    tabId: nullableId(source.tabId, 'Presented Tab', code), regionId: nullableId(source.regionId, 'Presented Region', code),
    blockers: list(source.blockers, value => member(value, ['settings', 'quick-switcher'] as const, 'Overlay blocker', code), code) }
  if (new Set(result.blockers).size !== result.blockers.length ||
    (result.state === 'main-visible' && (result.provenance !== 'observed' || result.blockers.length > 0)) ||
    (result.state === 'covered' && result.blockers.length === 0)) fail('Desktop presentation facts disagree.', code)
  return result
}
function floating(value: unknown, code: Code): AgentMuxDesktopFloating {
  const source = fields(value, ['provenance', 'state', 'topicId', 'tabId', 'regionId', 'sessionId', 'presentation'], code)
  return { provenance: provenance(source.provenance, code), state: member(source.state, ['closed', 'preview', 'pinned', 'unknown'], 'Floating state', code),
    topicId: nullableId(source.topicId, 'Floating Topic', code), tabId: nullableId(source.tabId, 'Floating Tab', code),
    regionId: nullableId(source.regionId, 'Floating Region', code), sessionId: nullableId(source.sessionId, 'Floating Session', code),
    presentation: member(source.presentation, ['visible', 'hidden', 'pending', 'unknown'], 'Floating presentation', code) }
}
function overlays(value: unknown, code: Code): AgentMuxDesktopOverlays {
  const source = fields(value, ['provenance', 'settings', 'quickSwitcher'], code)
  return { provenance: provenance(source.provenance, code), settings: nullableBoolean(source.settings, 'Settings', code),
    quickSwitcher: nullableBoolean(source.quickSwitcher, 'Quick switcher', code) }
}
function focus(value: unknown, code: Code): AgentMuxDesktopObservation['focus'] {
  const source = fields(value, ['executionSessionId', 'pmoSessionId'], code)
  return { executionSessionId: nullableId(source.executionSessionId, 'Execution focus', code), pmoSessionId: nullableId(source.pmoSessionId, 'PMO focus', code) }
}
export function parseDesktopFocusSuccessReceipt(value: unknown): AgentMuxControlSuccessReceipt {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const source = fields(value, ['schemaVersion', 'requestId', 'ok', 'operation', 'result'], code)
  if (source.schemaVersion !== 5 || source.operation !== 'focus' || source.ok !== true) fail('Desktop focus receipt is invalid.', code)
  const body = fields(source.result, ['navigation', 'presentation', 'input', 'floating', 'overlays', 'focus', 'partial', 'save', 'issues'], code)
  const nav = fields(body.navigation, ['state', 'requested', 'selection'], code)
  const caret = fields(body.input, ['policy', 'outcome', 'before', 'after'], code)
  const saved = fields(body.save, ['layoutApplied', 'localStorageWritten', 'storageFlushRequested', 'diskDurability', 'reason'], code)
  const result: Omit<AgentMuxDesktopFocusResult, 'operation'> = {
    navigation: { state: member(nav.state, ['applied', 'unchanged', 'rejected', 'unconfirmed'], 'Navigation', code),
      requested: parseDesktopFocusTarget(nav.requested, code), selection: selection(nav.selection, code) },
    presentation: presentation(body.presentation, code), input: { policy: member(caret.policy, ['preserve', 'target'], 'Input policy', code),
      outcome: member(caret.outcome, ['preserved', 'transferred', 'unavailable', 'unconfirmed'], 'Input outcome', code), before: input(caret.before, code), after: input(caret.after, code) },
    floating: floating(body.floating, code), overlays: overlays(body.overlays, code), focus: focus(body.focus, code), partial: boolean(body.partial, 'Partial', code),
    save: { layoutApplied: boolean(saved.layoutApplied, 'Selection applied', code), localStorageWritten: boolean(saved.localStorageWritten, 'Local storage', code),
      storageFlushRequested: boolean(saved.storageFlushRequested, 'Storage flush', code), diskDurability: member(saved.diskDurability, ['unconfirmed'], 'Disk durability', code),
      reason: saved.reason === null ? null : text(saved.reason, 'Save reason', code) },
    issues: list(body.issues, value => {
      const issue = fields(value, ['step', 'code', 'message', 'recovery', 'candidates'], code)
      return { step: text(issue.step, 'Issue step', code), code: text(issue.code, 'Issue code', code), message: text(issue.message, 'Issue message', code), recovery: text(issue.recovery, 'Issue recovery', code),
        ...(Object.hasOwn(issue, 'candidates') ? { candidates: list(issue.candidates, value => parseSpaceControlSelector(value, code), code) } : {}) }
    }, code)
  }
  const { navigation, input: observedInput } = result
  if (observedInput.policy === 'target' && (navigation.requested.kind !== 'space' ||
    (!navigation.requested.tabId && !navigation.requested.regionId))) fail('Input target requires an exact Tab or Region.', code)
  if ((navigation.state === 'applied' || navigation.state === 'unchanged')) {
    const requested = navigation.requested, actual = navigation.selection
    if (requested.kind === 'goal' && (actual.goalId !== requested.goalId || actual.surface !== 'goals')) fail('Goal receipt target is mismatched.', code)
    if (requested.kind === 'surface' && actual.surface !== requested.surface) fail('Surface receipt target is mismatched.', code)
    if (requested.kind === 'space') {
      const { kind: _, ...parent } = requested
      if (actual.surface !== 'space' || !actual.space || Object.entries(parent).some(([key, id]) => actual.space![(key === 'displayWorkspaceId' ? 'workspaceId' : key) as keyof AgentMuxDesktopSpaceSelection] !== id)) {
        fail('Space receipt parent identities are mismatched.', code)
      }
    }
  }
  if (result.presentation.state === 'main-visible' || result.presentation.state === 'floating') {
    const presented = navigation.selection.surface === 'space' ? navigation.selection.space : null
    if (result.presentation.provenance !== 'observed' || result.presentation.tabId !== (presented?.tabId ?? null) ||
      result.presentation.regionId !== (presented?.regionId ?? null) ||
      (result.presentation.state === 'floating' && (!presented?.tabId || !presented.regionId))) {
      fail('Desktop presented identities disagree with selection.', code)
    }
  }
  if ((observedInput.outcome === 'preserved' && (observedInput.policy !== 'preserve' || observedInput.before.provenance !== 'observed' ||
    observedInput.after.provenance !== 'observed' || observedInput.after.connected !== true || observedInput.after.visible !== true || observedInput.after.inert !== false ||
    ['scope', 'ownerKind', 'tabId', 'regionId', 'sessionId'].some(key => observedInput.before[key as keyof AgentMuxDesktopInput] !== observedInput.after[key as keyof AgentMuxDesktopInput]))) ||
    (observedInput.outcome === 'transferred' && (observedInput.policy !== 'target' ||
      (navigation.state !== 'applied' && navigation.state !== 'unchanged') || observedInput.after.provenance !== 'observed' ||
      observedInput.after.connected !== true || observedInput.after.visible !== true || observedInput.after.inert !== false ||
      observedInput.after.regionId !== navigation.selection.space?.regionId || observedInput.after.tabId !== navigation.selection.space?.tabId)) ||
    (!result.partial && (navigation.state === 'rejected' || navigation.state === 'unconfirmed' || result.presentation.state !== 'main-visible' ||
      observedInput.outcome === 'unavailable' || observedInput.outcome === 'unconfirmed'))) fail('Focus receipt confirmation is inconsistent.', code)
  const receipt = { schemaVersion: 5 as const, requestId: spaceControlId(source.requestId, 'Receipt Request', code), ok: true as const, operation: 'focus' as const, result }
  budget(receipt, code)
  return receipt
}
