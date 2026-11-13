import { identityRuntimeSource } from '@agentmux/identity/runtime-source'
import { join } from 'node:path'
import type { AgentManagedHookMutation } from '../managed-hook-installer.js'
import { defaultAgentMuxStateDirectory, resolveCoreBinPath } from '../runtime-paths.js'
import { HOOK_COMMAND_TIMEOUT_SECONDS } from './shared.js'
import type { AgentHookObservationFailure, AgentNativeActivityEvent } from '../types.js'

/**
 * A main tool call that Claude asked the person about has ended. Claude emits no classic Hook
 * when such a call is declined; this observation carries that exact call's own tool_use_id.
 * It ends the request only and never states an answer, an approval or tool success.
 */
export const CLAUDE_ASKED_TOOL_END_EVENT = 'AgentMuxAskedToolEnded'

/** The managed module asks Core at each genuinely answered main turn end whether a notice is waiting. */
export const CLAUDE_TURN_END_EVENT = 'AgentMuxTurnEnd'
/** The managed module reports what Claude's own idle prompt queue did with a handed notice. */
export const CLAUDE_NOTICE_ADMISSION_EVENT = 'AgentMuxNoticeAdmission'

/**
 * Claude's turn-end decision. The module asks once per answered main turn; Core answers with the
 * frozen notice, which the module hands to Claude's own idle queue ($.prompt.submit). That queue runs
 * it as its own next turn once idle, after user input already queued, and never touches the draft.
 */
export const CLAUDE_TURN_END_DECISION: NonNullable<import('../hook-normalizer.js').AgentNativeHookSpecification['turnEndDecision']> = {
  eventName: CLAUDE_TURN_END_EVENT,
  readTurn(payload) {
    const nativeTurnId = payload.turnId
    if (typeof nativeTurnId !== 'string' || !nativeTurnId.trim() || payload.agent_id !== undefined || payload.reason !== 'answer') return undefined
    return { nativeTurnId, firstStop: true }
  },
  output: (notice, notificationId) => ({ agentmuxNotice: { notificationId, text: notice } }),
  admission: {
    eventName: CLAUDE_NOTICE_ADMISSION_EVENT,
    read(payload) {
      const id = payload.notificationId
      if (typeof id !== 'string' || !id.trim()) return undefined
      if (payload.entered === true) return { notificationId: id, admitted: true }
      return typeof payload.dropped === 'string' && payload.dropped.trim()
        ? { notificationId: id, admitted: false, reason: payload.dropped.slice(0, 300) } : undefined
    }
  }
}

function observationIdentity(payload: Readonly<Record<string, unknown>>) {
  if (typeof payload.session_id !== 'string' || !payload.session_id.trim() ||
      typeof payload.sourceId !== 'string' || !payload.sourceId.trim() ||
      typeof payload.sequence !== 'number' || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1) return
  return { nativeSessionId: payload.session_id, sourceId: payload.sourceId, sequence: payload.sequence }
}

export function claudeNativeTurnIdentity(payload: Readonly<Record<string, unknown>>) {
  const identity = observationIdentity(payload)
  if (!identity || typeof payload.turnId !== 'string' || !payload.turnId.trim()) return
  return { nativeTurnId: payload.turnId, sourceId: identity.sourceId, sequence: identity.sequence }
}

export function claudeNativeObservationFailure(
  eventName: string,
  payload: Readonly<Record<string, unknown>>
): AgentHookObservationFailure | undefined {
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
): AgentNativeActivityEvent | undefined {
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
  return { ...base, nativeTurnId: payload.turnId, state: eventName === 'turn.start' ? 'active' : 'idle',
    ...(eventName === 'turn.complete' ? { interruption: payload.isAborted ? 'interrupted' as const : 'not-interrupted' as const } : {}) }
}

/**
 * A Provider-owned native observer; classic hooks retain input, permission and history ownership.
 * It lives in AgentMux's own state directory and is loaded by --plugin-dir, never written into the
 * user's workspace. Its content does not depend on the workspace, so one copy serves every Run.
 */
export function claudeNativeActivityDirectory(): string {
  return join(defaultAgentMuxStateDirectory(), 'providers', 'claude', 'native-activity')
}

/**
 * Claude mods run without Node globals. The public process API launches the existing passive Hook
 * runner, which owns authenticated delivery, its bounded retries, and the original receipt ID.
 * Callbacks never wait for ingress and return the native middleware result unchanged. The one
 * payload addition is the asked call's own tool_use_id on Claude's classic ask, which omits it.
 */
export function claudeNativeActivitySource(): string {
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

async function captureActor($) {
  if (actorCaptured) return
  actorCaptured = true
  if (await $.env.get('AGENTMUX_ENV') !== '1') return
  const id = await $.session.id()
  if (typeof id === 'string' && id.trim()) initialSessionId = id
  else return 'unavailable'
}

async function deliver($, eventName, event, sourceSequence) {
  const identityUnavailable = eventName === 'AgentMuxActivityUnavailable' && event.reason === 'source-identity-unavailable'
  if (!initialSessionId && !identityUnavailable) return
  if (!identityUnavailable) {
    const current = await $.session.id()
    if (current !== initialSessionId) sourceChanged = true
  }
  if (eventName === 'turn.start' && sourceSequence > deliveryGapThrough) deliveryGapThrough = 0
  const unavailable = identityUnavailable || sourceChanged || deliveryGapThrough > 0
  const payload = {
    hook_event_name: unavailable ? 'AgentMuxActivityUnavailable' : eventName,
    ...(initialSessionId ? { session_id: initialSessionId } : {}),
    sourceId,
    sequence: sourceSequence,
    ...(unavailable ? { reason: identityUnavailable ? 'source-identity-unavailable' : sourceChanged ? 'source-changed' : 'delivery-gap' } : {
      turnId: event.turnId,
      ...(event.agentId === undefined ? {} : { agent_id: event.agentId }),
      ...(eventName === 'turn.complete' ? { reason: event.reason, isAborted: event.isAborted } : {})
    })
  }
  const result = await $.process.run(
    ${JSON.stringify([process.execPath, resolveCoreBinPath('agentmux-hook.js')])},
    { stdin: JSON.stringify(payload),
      env: { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_HOOK_PROVIDER: 'claude' },
      timeoutMs: ${HOOK_COMMAND_TIMEOUT_SECONDS * 1_000} }
  )
  if (result.exitCode !== 0 || result.stderr) {
    deliveryGapThrough = Math.max(deliveryGapThrough, sourceSequence)
    await $.ui.log('AgentMux activity observation delivery unconfirmed; the Agent remains available.', { to: 'debug' })
  }
}

// Calls Claude asked the person about in this session, keyed by the native tool_use_id.
// Each entry: { tool, input, identified }; identified once its classic ask carries the id.
const askedCalls = new Map()

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
      ${JSON.stringify([process.execPath, resolveCoreBinPath('agentmux-hook.js')])},
      { stdin: JSON.stringify({ hook_event_name: ${JSON.stringify(CLAUDE_TURN_END_EVENT)}, session_id: initialSessionId, turnId, reason: 'answer' }),
        env: { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_HOOK_PROVIDER: 'claude' },
        timeoutMs: ${HOOK_COMMAND_TIMEOUT_SECONDS * 1_000} }
    )
    let notice
    try { notice = JSON.parse(asked.stdout || '{}').agentmuxNotice } catch {}
    if (!notice || typeof notice.notificationId !== 'string' || typeof notice.text !== 'string' || !notice.text) return
    let result
    try { result = await $.prompt.submit({ text: notice.text }) }
    catch (error) { result = { drop: 'the native queue refused this prompt: ' + String(error && error.message || error).slice(0, 200) } }
    await $.process.run(
      ${JSON.stringify([process.execPath, resolveCoreBinPath('agentmux-hook.js')])},
      { stdin: JSON.stringify({ hook_event_name: ${JSON.stringify(CLAUDE_NOTICE_ADMISSION_EVENT)}, session_id: initialSessionId,
          notificationId: notice.notificationId, ...(typeof result?.drop === 'string' ? { dropped: result.drop } : { entered: true }) }),
        env: { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_HOOK_PROVIDER: 'claude' },
        timeoutMs: ${HOOK_COMMAND_TIMEOUT_SECONDS * 1_000} }
    )
  } catch {
    try { await $.ui.log('AgentMux could not confirm an Inbox notice; the original messages stay in the Inbox.', { to: 'debug' }) } catch {}
  }
}

async function reportAskedEnd($, toolUseId, toolName) {
  try {
    const result = await $.process.run(
      ${JSON.stringify([process.execPath, resolveCoreBinPath('agentmux-hook.js')])},
      { stdin: JSON.stringify({ hook_event_name: ${JSON.stringify(CLAUDE_ASKED_TOOL_END_EVENT)}, session_id: initialSessionId,
          tool_use_id: toolUseId, ...(toolName ? { tool_name: toolName } : {}) }),
        env: { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_HOOK_PROVIDER: 'claude' },
        timeoutMs: ${HOOK_COMMAND_TIMEOUT_SECONDS * 1_000} }
    )
    if (result.exitCode !== 0 || result.stderr) await $.ui.log('AgentMux could not report a finished request; its card stays until confirmed.', { to: 'debug' })
  } catch {
    try { await $.ui.log('AgentMux could not report a finished request; its card stays until confirmed.', { to: 'debug' }) } catch {}
  }
}

function observe($, eventName, event) {
  const sourceSequence = ++sequence
  // An unavailable ingress cannot retain an unbounded promise chain. A dropped observation
  // invalidates earlier queued ends too; only a later native start can establish activity again.
  if (pending >= 32) {
    deliveryGapThrough = sourceSequence
    if (!overflowReported) {
      overflowReported = true
      try { $.ui.log('AgentMux activity observation queue full; current activity remains unconfirmed.', { to: 'debug' }) } catch {}
    }
    return
  }
  pending += 1
  // Reserve order before any await, including concurrent child endings. Delivery failure does not
  // break the tail, prevent later observations, or escape into the native event's result.
  delivery = delivery.then(() => deliver($, eventName, event, sourceSequence)).catch(async () => {
    deliveryGapThrough = Math.max(deliveryGapThrough, sourceSequence)
    try { await $.ui.log('AgentMux activity observer unavailable; the Agent remains available.', { to: 'debug' }) } catch {}
  }).finally(() => { pending -= 1; if (pending === 0) overflowReported = false })
}

export function register(on) {
  on('session.start', async ($, event, next) => {
    let unavailable = false
    try { unavailable = await captureActor($) === 'unavailable' } catch { unavailable = true }
    if (unavailable) {
      observe($, 'AgentMuxActivityUnavailable', { reason: 'source-identity-unavailable' })
      try { $.ui.log('AgentMux activity source identity unavailable; the Agent remains available.', { to: 'debug' }) } catch {}
    }
    return next(event)
  })
  on('classic.SessionStart', ($, event, next) => {
    if (initialSessionId && typeof event.session_id === 'string' && event.session_id !== initialSessionId) {
      sourceChanged = true
      observe($, 'AgentMuxActivityUnavailable', {})
    }
    return next(event)
  }).catch(($, event, next) => next(event))
  on('turn.start', ($, event, next) => {
    observe($, 'turn.start', event)
    return next(event)
  })
  on('turn.complete', ($, event, next) => {
    observe($, 'turn.complete', event)
    // Only an answered main turn of the original session asks; the queue runs a notice as its own next turn.
    if (event?.agentId === undefined && event?.reason === 'answer' && typeof event?.turnId === 'string' && initialSessionId && !sourceChanged) {
      void askTurnEndNotice($, event.turnId)
    }
    return next(event)
  })
  // Classic Hooks report no end for a declined asked call. Only calls this session asked about
  // send one exact end, after the native call settles; other tools add no work.
  on('tool.check', async ($, event, next) => {
    const result = await next(event)
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
    if (sourceChanged || event?.agent_id !== undefined || event?.tool_use_id !== undefined) return next(event)
    const input = canonical(event?.tool_input)
    const matches = [...askedCalls].filter(([, call]) => !call.identified && call.tool === event?.tool_name && call.input === input)
    if (matches.length !== 1) return next(event)
    matches[0][1].identified = true
    return next({ ...event, tool_use_id: matches[0][0] })
  }).catch(($, event, next) => next(event))
  on('tool.call', async ($, event, next) => {
    const id = event?.tool_use_id, call = typeof id === 'string' ? askedCalls.get(id) : undefined
    try { return await next(event) }
    finally {
      if (call && askedCalls.delete(id) && initialSessionId && !sourceChanged) {
        // Delivery uses the authenticated runner; the native result is never inspected or altered.
        void reportAskedEnd($, id, call.tool)
      }
    }
  })
}
`
}

export function claudeNativeActivityMutations(): AgentManagedHookMutation[] {
  const directory = claudeNativeActivityDirectory()
  return [
    { path: join(directory, '.claude-plugin', 'plugin.json'), mode: 0o600,
      content: `${JSON.stringify({ name: 'agentmux-native-activity', version: '1.0.0',
        description: 'Observe native turn activity and queue AgentMux Inbox notices through the native idle queue.',
        author: { name: 'AgentMux' } }, null, 2)}\n` },
    { path: join(directory, 'hooks', 'hooks.json'), mode: 0o600,
      content: `${JSON.stringify({ modules: ['./register.js'] }, null, 2)}\n` },
    { path: join(directory, 'hooks', 'register.js'), mode: 0o600, content: claudeNativeActivitySource() }
  ]
}

/** The repeatable, single-value --plugin-dir follows prompts; an explicit -- keeps its meaning. */
export function withClaudeNativeActivity(args: readonly string[]): string[] {
  const separator = args.indexOf('--')
  const at = separator < 0 ? args.length : separator
  return [...args.slice(0, at), '--plugin-dir', claudeNativeActivityDirectory(), ...args.slice(at)]
}
