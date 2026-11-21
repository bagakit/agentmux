import { createHash } from 'node:crypto'
import { join } from 'node:path'

type NativeActivity = {
  state: 'active' | 'idle' | 'unknown'
  mainState?: 'active' | 'idle'
  interruption?: 'interrupted' | 'not-interrupted'
  nativeSessionId: string
  nativeTurnId?: string
  sourceId: string
  sequence: number
}
type Payload = Readonly<Record<string, unknown>>

/**
 * A main tool call that Claude asked the person about has ended. Claude emits no classic Hook
 * when such a call is declined; this observation carries that exact call's own tool_use_id.
 * It ends the request only and never states an answer, an approval or tool success. It travels in
 * the ordered native observation stream; an unconfirmed end is kept, sent again ahead of later
 * observations, and shown as a delivery gap until Core confirms it.
 */
export const CLAUDE_ASKED_TOOL_END_EVENT = 'AgentMuxAskedToolEnded'
/** A native child call's scoped permission/question wait, never a main-session request. */
export const CLAUDE_CHILD_ACTIVITY_EVENT = 'AgentMuxChildActivity'
/** Main-session model and quota figures read from the native observer, never transcript text. */
export const CLAUDE_INFORMATION_EVENT = 'AgentMuxInformation'

/** The managed module asks Core at each genuinely answered main turn end whether a notice is waiting. */
export const CLAUDE_TURN_END_EVENT = 'AgentMuxTurnEnd'
/** The managed module reports what Claude's own idle prompt queue did with a handed notice. */
export const CLAUDE_NOTICE_ADMISSION_EVENT = 'AgentMuxNoticeAdmission'

/**
 * Claude's turn-end decision. The module asks once per answered main turn; Core answers with the
 * frozen notice, which the module hands to Claude's own idle queue ($.prompt.submit). That queue runs
 * it as its own next turn once idle, after user input already queued, and never touches the draft.
 */
export const CLAUDE_TURN_END_DECISION = {
  eventName: CLAUDE_TURN_END_EVENT,
  readTurn(payload: Payload) {
    const nativeTurnId = payload.turnId
    if (typeof nativeTurnId !== 'string' || !nativeTurnId.trim() || payload.agent_id !== undefined || payload.reason !== 'answer') return undefined
    return { nativeTurnId, firstStop: true as const }
  },
  output: (notice: string, notificationId: string) => ({ agentmuxNotice: { notificationId, text: notice } }),
  admission: {
    eventName: CLAUDE_NOTICE_ADMISSION_EVENT,
    read(payload: Payload) {
      const id = payload.notificationId
      if (typeof id !== 'string' || !id.trim()) return undefined
      if (payload.entered === true) return { notificationId: id, admitted: true as const }
      return typeof payload.dropped === 'string' && payload.dropped.trim()
        ? { notificationId: id, admitted: false as const, reason: payload.dropped.slice(0, 300) } : undefined
    }
  }
}

function observationIdentity(payload: Readonly<Record<string, unknown>>) {
  if (typeof payload.session_id !== 'string' || !payload.session_id.trim() ||
      typeof payload.sourceId !== 'string' || !payload.sourceId.trim() ||
      typeof payload.sequence !== 'number' || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1) return
  return { nativeSessionId: payload.session_id, sourceId: payload.sourceId, sequence: payload.sequence }
}

/** Normalize only the original observer's typed main-session information. */
export function claudeNativeInformation(eventName: string, payload: Payload) {
  if (eventName !== CLAUDE_INFORMATION_EVENT || payload.agent_id !== undefined || payload.agentId !== undefined) return
  const identity = observationIdentity(payload)
  if (!identity || typeof payload.observedAt !== 'number' || !Number.isSafeInteger(payload.observedAt) || payload.observedAt < 0) return
  const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value)
  const model = text(payload.model) ? { id: payload.model, scope: 'session' as const } : undefined
  const ids = new Set<string>()
  let validLimits = Array.isArray(payload.rateLimits)
  const limits = (Array.isArray(payload.rateLimits) ? payload.rateLimits : []).flatMap(value => {
    const row = value as Record<string, unknown> | null
    const resetsAt = row?.resetsAt === undefined ? undefined : typeof row.resetsAt === 'string' ? Date.parse(row.resetsAt) : NaN
    if (!row || !text(row.kind) || ids.has(row.kind) || typeof row.percentUsed !== 'number' || !Number.isFinite(row.percentUsed) ||
        row.percentUsed < 0 || resetsAt !== undefined && (!Number.isFinite(resetsAt) || resetsAt < 0)) {
      validLimits = false; return []
    }
    ids.add(row.kind)
    const names: Record<string, string> = { five_hour: 'Five hours', seven_day: 'Seven days', spend_limit: 'Spend limit' }
    return [{ id: row.kind, name: names[row.kind] ?? row.kind, usedPercent: row.percentUsed,
      ...(resetsAt === undefined ? {} : { resetsAt }) }]
  })
  return { ...identity, observedAt: payload.observedAt, ...(model ? { model } : {}), ...(validLimits ? { limits } : {}),
    issues: [
      { field: 'plan' as const, kind: 'unsupported' as const, code: 'CLAUDE_PLAN_UNSUPPORTED', message: 'The original native observer does not expose the subscription plan to this plugin.' },
      { field: 'configuration' as const, kind: 'unsupported' as const, code: 'CLAUDE_MODEL_CONFIGURATION_UNSUPPORTED', message: 'The original native protocol does not expose a session-only model selection contract.' },
      ...(!model ? [{ field: 'model' as const, kind: payload.modelUnavailable === true ? 'unavailable' as const : 'unconfirmed' as const,
        code: 'CLAUDE_MODEL_UNCONFIRMED', message: 'The original native observer could not confirm the main-session model.' }] : []),
      ...(!validLimits || limits.length === 0 ? [{ field: 'limits' as const, kind: payload.limitsUnavailable === true ? 'unavailable' as const : 'unconfirmed' as const,
        code: 'CLAUDE_LIMITS_UNCONFIRMED', message: 'The original native observer has no confirmed quota windows.' }] : [])
    ] }
}

export function claudeNativeTurnIdentity(payload: Readonly<Record<string, unknown>>) {
  const identity = observationIdentity(payload)
  if (!identity || typeof payload.turnId !== 'string' || !payload.turnId.trim()) return
  return { nativeTurnId: payload.turnId, sourceId: identity.sourceId, sequence: identity.sequence }
}

export function claudeNativeObservationFailure(
  eventName: string,
  payload: Readonly<Record<string, unknown>>
) {
  if (eventName === 'AgentMuxActivityUnavailable' && ['delivery-gap', 'source-changed'].includes(String(payload.reason)) &&
      payload.agent_id === undefined && payload.agentId === undefined) {
    const source = observationIdentity(payload)
    if (source) return { code: 'AGENT_NATIVE_ACTIVITY_UNAVAILABLE',
      source: { sourceId: source.sourceId, sequence: source.sequence },
      message: 'The original native observer lost source continuity. Its main and same-source child activity are unconfirmed; original identities, observations and input remain available.' }
  }
  if (eventName !== 'AgentMuxActivityUnavailable' || payload.reason !== 'source-identity-unavailable' ||
      payload.session_id !== undefined || payload.agent_id !== undefined || payload.agentId !== undefined ||
      typeof payload.sourceId !== 'string' || !payload.sourceId.trim() ||
      typeof payload.sequence !== 'number' || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1) return
  return { code: 'AGENT_NATIVE_ACTIVITY_UNAVAILABLE',
    source: { sourceId: payload.sourceId, sequence: payload.sequence },
    message: 'The native activity observer could not capture its original actor identity. Current activity is unconfirmed. The original Session, Run and input remain available; a subsequent original-identity Run can establish a fresh observer.' }
}

/** Only the documented native turn stream contributes activity; no outcome grants success. */
export function claudeNativeActivity(
  eventName: string,
  payload: Readonly<Record<string, unknown>>
): NativeActivity | undefined {
  if (!['turn.start', 'turn.complete', 'AgentMuxActivityUnavailable'].includes(eventName) || payload.agent_id !== undefined) return
  const base = observationIdentity(payload)
  if (!base) return
  if (eventName === 'AgentMuxActivityUnavailable') {
    return ['source-changed', 'delivery-gap'].includes(String(payload.reason)) ? { ...base, state: 'unknown' } : undefined
  }
  if (typeof payload.turnId !== 'string' || !payload.turnId.trim()) return
  if (eventName === 'turn.complete' &&
      (!['answer', 'aborted', 'refusal', 'error'].includes(String(payload.reason)) ||
       typeof payload.isAborted !== 'boolean' || (payload.reason === 'aborted') !== payload.isAborted)) return
  // Stop's snapshot includes ambient watchers and cannot prove current active work. Only a
  // matching, complete empty snapshot can establish idle; missing old-module evidence is unknown.
  const state = eventName === 'turn.start' ? 'active' :
    payload.reason === 'answer' && payload.backgroundWork === 'none' ? 'idle' : 'unknown'
  return { ...base, nativeTurnId: payload.turnId, state,
    mainState: eventName === 'turn.start' ? 'active' : 'idle',
    ...(state === 'idle' ? { interruption: payload.isAborted ? 'interrupted' as const : 'not-interrupted' as const } : {}) }
}


/**
 * Claude mods run without Node globals. The public process API launches the existing passive Hook
 * runner, which owns authenticated delivery, its bounded retries, and the original receipt ID.
 * Callbacks never wait for ingress and return the native middleware result unchanged. Main asks
 * gain their original tool_use_id; child call scopes report permission/question waits separately.
 */
export function claudeNativeActivitySource(identityRuntimeSource: string, hookCommandTimeoutSeconds: number): string {
  return `// AgentMux managed native activity observer. Generated; makes no answer or approval decision, and queues
// only the Inbox notices Core hands it at a turn end, through Claude's own idle prompt queue.
const { mintObjectId } = ${identityRuntimeSource}
const sourceId = mintObjectId()
let sequence = 0
let initialSessionId
let actorCaptured = false
let sourceChanged = false
let deliveryGapThrough = 0
let pending = 0
let overflowReported = false
let delivery = Promise.resolve()
let mainTurn
let lastInformation
const ASKED_END = ${JSON.stringify(CLAUDE_ASKED_TOOL_END_EVENT)}
const CHILD_ACTIVITY = ${JSON.stringify(CLAUDE_CHILD_ACTIVITY_EVENT)}
const INFORMATION = ${JSON.stringify(CLAUDE_INFORMATION_EVENT)}

// The launching Core names its own runner in the Run environment, so these files carry no install path.
// --launch-scoped marks a call this launch declared; the runner ignores unmarked leftovers in such a Run.
let runnerArgv
async function runner($) {
  if (!runnerArgv) {
    const node = await $.env.get('AGENTMUX_HOOK_NODE'), script = await $.env.get('AGENTMUX_HOOK_RUNNER')
    if (!node || !script) throw new Error('The AgentMux Hook runner is not named in this Run environment.')
    runnerArgv = [node, script, '--launch-scoped']
  }
  return runnerArgv
}

async function captureActor($) {
  if (actorCaptured) return
  actorCaptured = true
  if (await $.env.get('AGENTMUX_ENV') !== '1') return
  const id = await $.session.id()
  if (typeof id === 'string' && id.trim()) initialSessionId = id
  else return 'unavailable'
}

// The authenticated runner exits after Core has decided; stderr or a nonzero exit means unconfirmed.
async function send($, payload) {
  const result = await $.process.run(
    await runner($),
    { stdin: JSON.stringify(payload),
      env: { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_HOOK_PROVIDER: 'claude' },
      timeoutMs: ${hookCommandTimeoutSeconds * 1_000} }
  )
  return result.exitCode === 0 && !result.stderr
}

// These built-ins read the native session in memory. No breakdown/token-count request,
// account identity, transcript content or protected managed-only API is used.
async function readInformation($, event) {
  try {
    const observedAt = await $.clock.now()
    if (typeof observedAt !== 'number' || !Number.isSafeInteger(observedAt) || observedAt < 0) return
    const reads = await Promise.allSettled([
      Promise.resolve().then(() => $.session.model()),
      event.rateLimits === undefined ? Promise.resolve().then(() => $.session.usage()).then(usage => usage.rateLimits) : Promise.resolve(event.rateLimits)
    ])
    const model = reads[0].status === 'fulfilled' ? reads[0].value : undefined
    const rawRates = reads[1].status === 'fulfilled' ? reads[1].value : undefined
    const scalar = value => typeof value === 'string' && value.trim() && !/[\\0\\r\\n]/u.test(value)
    const validRates = Array.isArray(rawRates) && rawRates.every(row => row && scalar(row.kind) &&
      typeof row.percentUsed === 'number' && Number.isFinite(row.percentUsed) && row.percentUsed >= 0 &&
      (row.resetsAt === undefined || typeof row.resetsAt === 'string'))
    return { observedAt,
      ...(scalar(model) ? { model } : { modelUnavailable: true }),
      ...(validRates ? { rateLimits: rawRates.map(row => ({ kind: row.kind, percentUsed: row.percentUsed,
        ...(row.resetsAt === undefined ? {} : { resetsAt: row.resetsAt }) })) } : { limitsUnavailable: true }) }
  } catch {
    try { await $.ui.log('AgentMux native information read unconfirmed; original activity and input remain available.', { to: 'debug' }) } catch {}
  }
}

async function deliver($, eventName, event, sourceSequence) {
  const identityUnavailable = eventName === 'AgentMuxActivityUnavailable' && event.reason === 'source-identity-unavailable'
  if (!initialSessionId && !identityUnavailable) return
  if (!identityUnavailable) {
    const current = await $.session.id()
    if (current !== initialSessionId) sourceChanged = true
  }
  // Ends reserved at or before this position go first, each with its exact call identity. An end that
  // is still unconfirmed keeps the gap open, so the next turn.start cannot clear it.
  let confirmed = true
  if (!sourceChanged) {
    const due = [...askedCalls].filter(([, call]) => call.end !== undefined && call.end <= sourceSequence).sort(([, a], [, b]) => a.end - b.end)
    for (const [id, call] of due) {
      if (await send($, { hook_event_name: ASKED_END, session_id: initialSessionId, tool_use_id: id, tool_name: call.tool })) askedCalls.delete(id)
      else confirmed = false
    }
  }
  if (eventName !== ASKED_END) {
    if (confirmed && eventName === 'turn.start' && sourceSequence > deliveryGapThrough) deliveryGapThrough = 0
    let information, signature, skipInformation = false
    if (eventName === INFORMATION && !identityUnavailable && !sourceChanged && deliveryGapThrough === 0) {
      information = await readInformation($, event)
      if (!information) skipInformation = true
      else {
        if (await $.session.id() !== initialSessionId) sourceChanged = true
        // The observer retains only a change signature. Unchanged turn/model commands do not
        // launch another Hook process or refresh the last sample's observation time.
        signature = JSON.stringify({ ...information, observedAt: undefined })
        if (!sourceChanged && signature === lastInformation) skipInformation = true
      }
    }
    const unavailable = identityUnavailable || sourceChanged || deliveryGapThrough > 0
    const payload = {
      hook_event_name: unavailable ? 'AgentMuxActivityUnavailable' : eventName,
      ...(initialSessionId ? { session_id: initialSessionId } : {}),
      sourceId,
      sequence: sourceSequence,
      ...(unavailable ? { reason: identityUnavailable ? 'source-identity-unavailable' : sourceChanged ? 'source-changed' : 'delivery-gap' } : {
        ...(eventName === INFORMATION ? information : {}),
        turnId: event.turnId,
        ...(event.agentId === undefined ? {} : { agent_id: event.agentId }),
        ...(eventName === CHILD_ACTIVITY ? { state: event.state, reason: event.reason, tool_use_id: event.toolUseId } : {}),
        ...(eventName === 'turn.complete' ? { reason: event.reason, isAborted: event.isAborted,
          ...(event.agentId === undefined ? { backgroundWork: event.backgroundWork } : {}) } : {})
      })
    }
    if ((!skipInformation || unavailable) && !await send($, payload)) confirmed = false
    else if (eventName === INFORMATION && !unavailable && !skipInformation) lastInformation = signature
  }
  if (!confirmed) {

    deliveryGapThrough = Math.max(deliveryGapThrough, sourceSequence)
    lastInformation = undefined
    await $.ui.log('AgentMux activity observation delivery unconfirmed; the Agent remains available.', { to: 'debug' })
  }
}

// Calls Claude asked the person about in this session, keyed by the native tool_use_id.
// Each entry: { tool, input, identified, end }; identified once its classic ask carries the id, end
// the reserved position of its exact end. An entry stays until Core confirms that end.
const askedCalls = new Map()

// Native observer scopes, not a second activity Store. A tool callback retains the exact
// turn object it entered, so a resumed child cannot inherit a late permission or finally.
const childTurns = new Map()
const childCalls = new Map()

function childCall(event) {
  const call = typeof event?.tool_use_id === 'string' ? childCalls.get(event?.agentId)?.get(event.tool_use_id) : undefined
  return call && call.agentId === event?.agentId && call.tool === event?.tool ? call : undefined
}

function childActivity($, scope, trigger) {
  if (!initialSessionId || sourceChanged || childTurns.get(scope.agentId) !== scope) return
  const pending = [...(childCalls.get(scope.agentId)?.values() || [])].filter(call => call.scope === scope)
  const waiting = pending.find(call => call.waitingReason)
  const uncertain = pending.find(call => call.permissionObserved)
  const evidence = waiting || uncertain || trigger
  observe($, CHILD_ACTIVITY, { agentId: scope.agentId, turnId: scope.turnId, toolUseId: evidence.id,
    state: waiting ? 'waiting' : uncertain ? 'unknown' : 'working',
    reason: waiting?.waitingReason || trigger.waitingReason || 'permission' })
}

// A stable rendering of tool arguments, independent of property insertion order.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value ?? null)
}

// One notice ask per answered main turn. Core answers with a notice only when references are
// waiting; the module hands it to Claude's own idle queue and reports what that queue did with it.
async function askTurnEndNotice($, turnId) {
  try {
    const asked = await $.process.run(
      await runner($),
      { stdin: JSON.stringify({ hook_event_name: ${JSON.stringify(CLAUDE_TURN_END_EVENT)}, session_id: initialSessionId, turnId, reason: 'answer' }),
        env: { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_HOOK_PROVIDER: 'claude' },
        timeoutMs: ${hookCommandTimeoutSeconds * 1_000} }
    )
    let notice
    try { notice = JSON.parse(asked.stdout || '{}').agentmuxNotice } catch {}
    if (!notice || typeof notice.notificationId !== 'string' || typeof notice.text !== 'string' || !notice.text) return
    let result
    try { result = await $.prompt.submit({ text: notice.text }) }
    catch (error) { result = { drop: 'the native queue refused this prompt: ' + String(error && error.message || error).slice(0, 200) } }
    await $.process.run(
      await runner($),
      { stdin: JSON.stringify({ hook_event_name: ${JSON.stringify(CLAUDE_NOTICE_ADMISSION_EVENT)}, session_id: initialSessionId,
          notificationId: notice.notificationId, ...(typeof result?.drop === 'string' ? { dropped: result.drop } : { entered: true }) }),
        env: { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_HOOK_PROVIDER: 'claude' },
        timeoutMs: ${hookCommandTimeoutSeconds * 1_000} }
    )
  } catch {
    try { await $.ui.log('AgentMux could not confirm an Inbox notice; the original messages stay in the Inbox.', { to: 'debug' }) } catch {}
  }
}


function observe($, eventName, event) {
  const sourceSequence = ++sequence
  // An unavailable ingress cannot retain an unbounded promise chain. A dropped observation
  // invalidates earlier queued ends too; only a later native start can establish activity again.
  // An asked end dropped here keeps its position and goes ahead of the next delivered observation.
  if (pending >= 32) {
    deliveryGapThrough = sourceSequence
    lastInformation = undefined
    if (!overflowReported) {
      overflowReported = true
      try { $.ui.log('AgentMux activity observation queue full; current activity remains unconfirmed.', { to: 'debug' }) } catch {}
    }
    return sourceSequence
  }
  pending += 1
  // Reserve order before any await, including concurrent child endings. Delivery failure does not
  // break the tail, prevent later observations, or escape into the native event's result.
  delivery = delivery.then(() => deliver($, eventName, event, sourceSequence)).catch(async () => {
    deliveryGapThrough = Math.max(deliveryGapThrough, sourceSequence)
    lastInformation = undefined
    try { await $.ui.log('AgentMux activity observer unavailable; the Agent remains available.', { to: 'debug' }) } catch {}
  }).finally(() => { pending -= 1; if (pending === 0) overflowReported = false })
  return sourceSequence
}

export function register(on) {
  on('session.start', async ($, event, next) => {
    let unavailable = false
    try { unavailable = await captureActor($) === 'unavailable' } catch { unavailable = true }
    if (unavailable) {
      observe($, 'AgentMuxActivityUnavailable', { reason: 'source-identity-unavailable' })
      try { $.ui.log('AgentMux activity source identity unavailable; the Agent remains available.', { to: 'debug' }) } catch {}
    }
    if (initialSessionId && !sourceChanged) observe($, INFORMATION, {})
    return next(event)
  })
  on('session.measure', ($, event, next) => {
    if (initialSessionId && !sourceChanged) observe($, INFORMATION, { rateLimits: Array.isArray(event.rateLimits)
      ? event.rateLimits.map(row => ({ kind: row?.kind, percentUsed: row?.percentUsed,
        ...(row?.resetsAt === undefined ? {} : { resetsAt: row.resetsAt }) })) : event.rateLimits })
    return next(event)
  })
  on('command.run', async ($, event, next) => {
    try { return await next(event) }
    finally {
      if (event.command === 'model' && initialSessionId && !sourceChanged) observe($, INFORMATION, {})
    }
  })
  on('classic.SessionStart', ($, event, next) => {
    if (initialSessionId && typeof event.session_id === 'string' && event.session_id !== initialSessionId) {
      sourceChanged = true
      observe($, 'AgentMuxActivityUnavailable', {})
    }
    return next(event)
  }).catch(($, event, next) => next(event))
  on('turn.start', ($, event, next) => {
    if (event?.agentId === undefined && typeof event?.turnId === 'string' && event.turnId.trim()) {
      mainTurn = { turnId: event.turnId, backgroundWork: 'unknown' }
    } else if (typeof event?.agentId === 'string' && event.agentId.trim() && typeof event?.turnId === 'string' && event.turnId.trim()) {
      childTurns.set(event.agentId, { agentId: event.agentId, turnId: event.turnId })
    }
    observe($, 'turn.start', event)
    if (event?.agentId === undefined && initialSessionId && !sourceChanged) observe($, INFORMATION, {})
    return next(event)
  })
  // Claude's main run is serialized: start, awaited classic.Stop, then complete. The native
  // producer already filters foreground/finished/memory tasks. Its wire lacks ambient membership,
  // so nonempty means unconfirmed idle, never active. Freeze only this original main snapshot.
  on('classic.Stop', ($, event, next) => {
    if (mainTurn && initialSessionId && !sourceChanged && event?.session_id === initialSessionId &&
        event?.agent_id === undefined && event?.agentId === undefined) {
      const tasks = event.background_tasks
      mainTurn.backgroundWork = Array.isArray(tasks) && tasks.every(task => task && typeof task === 'object' &&
        typeof task.id === 'string' && task.id.trim() && typeof task.type === 'string' &&
        (task.status === 'running' || task.status === 'pending'))
        ? tasks.length === 0 ? 'none' : 'pending' : 'unknown'
    }
    return next(event)
  }).catch(($, event, next) => next(event))
  on('turn.complete', ($, event, next) => {
    if (event?.agentId === undefined) {
      const backgroundWork = event?.reason === 'answer' && mainTurn?.turnId === event?.turnId ? mainTurn.backgroundWork : 'unknown'
      if (mainTurn?.turnId === event?.turnId) mainTurn = undefined
      observe($, 'turn.complete', { ...event, backgroundWork })
    } else {
      observe($, 'turn.complete', event)
      const scope = childTurns.get(event?.agentId)
      if (scope?.turnId === event?.turnId && typeof event.isAborted === 'boolean' &&
          ['answer', 'aborted', 'refusal', 'error'].includes(event.reason) && (event.reason === 'aborted') === event.isAborted) childTurns.delete(event.agentId)
    }
    // Only an answered main turn of the original session asks; the queue runs a notice as its own next turn.
    if (event?.agentId === undefined && event?.reason === 'answer' && typeof event?.turnId === 'string' && initialSessionId && !sourceChanged) {
      void askTurnEndNotice($, event.turnId)
    }
    return next(event)
  })
  // Classic Hooks report no end for a declined asked call. Only calls this session asked about
  // send one exact end, after the native call settles; other tools add no work.
  on('tool.check', async ($, event, next) => {
    const child = childCall(event)
    const result = await next(event)
    // An ask is only a policy candidate: the mode may still settle it without a person.
    // Only its actual classic PermissionRequest below publishes a permission wait.
    if (child && childCalls.get(child.agentId)?.get(child.id) === child && result?.decision === 'ask') {
      child.input = canonical(event.input)
      child.asked = true
    }
    // A child Agent's call belongs to its own subject; only main-session asks are reported.
    if (initialSessionId && !sourceChanged && event?.agentId === undefined && result?.decision === 'ask' &&
        typeof event?.tool_use_id === 'string' && event.tool_use_id.trim() && typeof event?.tool === 'string') {
      askedCalls.set(event.tool_use_id, { tool: event.tool, input: canonical(event.input), identified: false })
    }
    return result
  })
  // Claude asks after tool.check, in its classic PermissionRequest, without the call identity.
  // Attach the one exact main call this ask belongs to. Each recorded ask is used once; two
  // equal candidates stay unidentified. Nothing else in the payload changes.
  on('classic.PermissionRequest', ($, event, next) => {
    if (typeof event?.agent_id === 'string') {
      if (!initialSessionId || sourceChanged || event.session_id !== initialSessionId) return next(event)
      const input = canonical(event.tool_input)
      const matches = [...(childCalls.get(event.agent_id)?.values() || [])].filter(call => call.asked &&
        !call.permissionIdentified && call.tool === event.tool_name && call.input === input)
      // Include still-open old scopes in the uniqueness check. Their late callbacks
      // cannot borrow a new turn just because a resumed child kept its native id.
      if (matches.length === 1) {
        const call = matches[0]
        call.permissionIdentified = true
        if (childTurns.get(call.agentId) === call.scope) {
          // This version has no permission-resolved execution event. Keep the
          // original request cause, without claiming it still awaits a person.
          call.permissionObserved = true
          childActivity($, call.scope, call)
        }
      } else if (matches.length > 1) {
        const current = matches.filter(call => childTurns.get(call.agentId) === call.scope)
        if (current.length > 1) {
          for (const call of current) call.permissionObserved = true
          childActivity($, current[0].scope, current[0])
        }
      }
      return next(event)
    }
    if (sourceChanged || event?.agent_id !== undefined || event?.tool_use_id !== undefined) return next(event)
    const input = canonical(event?.tool_input)
    const matches = [...askedCalls].filter(([, call]) => !call.identified && call.end === undefined && call.tool === event?.tool_name && call.input === input)
    if (matches.length !== 1) return next(event)
    matches[0][1].identified = true
    return next({ ...event, tool_use_id: matches[0][0] })
  }).catch(($, event, next) => next(event))
  on('tool.call', async ($, event, next) => {
    const id = event?.tool_use_id
    const scope = typeof event?.agentId === 'string' ? childTurns.get(event.agentId) : undefined
    const calls = scope ? childCalls.get(scope.agentId) || new Map() : undefined
    const child = scope && typeof id === 'string' && id.trim() && typeof event.tool === 'string' && !calls.has(id)
      ? { id, agentId: event.agentId, tool: event.tool, scope } : undefined
    if (child) {
      childCalls.set(child.agentId, calls); calls.set(id, child)
      if (event.tool === 'AskUserQuestion') {
        child.waitingReason = 'question'
        childActivity($, scope, child)
      }
    }
    try { return await next(event) }
    finally {
      if (child && childCalls.get(child.agentId)?.get(id) === child) {
        calls.delete(id)
        if (calls.size === 0) childCalls.delete(child.agentId)
        if (child.waitingReason || child.permissionObserved) childActivity($, scope, child)
      }
      // tool.check (and the ask it records) runs inside next, after tool.call begins.
      const call = event?.agentId === undefined && typeof id === 'string' ? askedCalls.get(id) : undefined
      // Each asked call ends once; the native result is never inspected or altered.
      if (call && call.end === undefined && askedCalls.get(id) === call) {
        if (initialSessionId && !sourceChanged) call.end = observe($, ASKED_END, {})
        else askedCalls.delete(id)
      }
    }
  })
}
`
}

/**
 * The Claude plugin AgentMux loads with --plugin-dir: its classic command Hooks and its module.
 * It lives in AgentMux's state directory, never in the user's workspace. No file names an install
 * path (the Run environment names the runner), so every install writes the same bytes, and the
 * directory is named by those bytes: a new revision is a new directory, never an edit of a folder a
 * running Claude watches and would hot-reload.
 */
export function claudePlugin(stateDirectory: string, activitySource: string, classicHooks: Readonly<Record<string, readonly unknown[]>>) {
  const files: Array<[string, string]> = [
    [join('.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'agentmux-native-activity', version: '1.0.0',
      description: 'Deliver Claude Hooks to AgentMux and queue AgentMux Inbox notices through the native idle queue.',
      author: { name: 'AgentMux' } }, null, 2)}\n`],
    [join('hooks', 'hooks.json'), `${JSON.stringify({ modules: ['./register.js'], hooks: classicHooks }, null, 2)}\n`],
    [join('hooks', 'register.js'), activitySource]
  ]
  const revision = createHash('sha256')
  for (const [path, content] of files) revision.update(path).update('\0').update(content).update('\0')
  const directory = join(stateDirectory, 'providers', 'claude', 'plugins', revision.digest('hex'))
  return { directory, mutations: files.map(([path, content]) => ({ path: join(directory, path), mode: 0o600, content })) }
}

/** The repeatable, single-value --plugin-dir follows prompts; an explicit -- keeps its meaning. */
export function withClaudePlugin(args: readonly string[], directory: string): string[] {
  const separator = args.indexOf('--')
  const at = separator < 0 ? args.length : separator
  return [...args.slice(0, at), '--plugin-dir', directory, ...args.slice(at)]
}
