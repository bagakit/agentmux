import { identityRuntimeSource } from '@agentmux/identity/runtime-source'
import { join } from 'node:path'
import type { AgentManagedHookMutation } from '../managed-hook-installer.js'
import { resolveCoreBinPath } from '../runtime-paths.js'
import { HOOK_COMMAND_TIMEOUT_SECONDS } from './shared.js'
import type { AgentHookObservationFailure, AgentNativeActivityEvent } from '../types.js'

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

/** A Provider-owned native observer; classic hooks retain input, permission and history ownership. */
export function claudeNativeActivityDirectory(workspacePath: string): string {
  return join(workspacePath, '.claude', 'agentmux', 'native-activity')
}

/**
 * Claude mods run without Node globals. The public process API launches the existing passive Hook
 * runner, which owns authenticated delivery, its bounded retries, and the original receipt ID.
 * Callbacks never wait for ingress and always return the unchanged native middleware result.
 */
export function claudeNativeActivitySource(): string {
  return `// AgentMux managed native activity observer. Generated; no input or completion decisions.
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
    return next(event)
  })
}
`
}

export function claudeNativeActivityMutations(workspacePath: string): AgentManagedHookMutation[] {
  const directory = claudeNativeActivityDirectory(workspacePath)
  return [
    { path: join(directory, '.claude-plugin', 'plugin.json'), mode: 0o600,
      content: `${JSON.stringify({ name: 'agentmux-native-activity', version: '1.0.0',
        description: 'Observe native turn activity without input or completion decisions.',
        author: { name: 'AgentMux' } }, null, 2)}\n` },
    { path: join(directory, 'hooks', 'hooks.json'), mode: 0o600,
      content: `${JSON.stringify({ modules: ['./register.js'] }, null, 2)}\n` },
    { path: join(directory, 'hooks', 'register.js'), mode: 0o600, content: claudeNativeActivitySource() }
  ]
}

/** The repeatable, single-value --plugin-dir follows prompts; an explicit -- keeps its meaning. */
export function withClaudeNativeActivity(args: readonly string[], workspacePath: string): string[] {
  const separator = args.indexOf('--')
  const at = separator < 0 ? args.length : separator
  return [...args.slice(0, at), '--plugin-dir', claudeNativeActivityDirectory(workspacePath), ...args.slice(at)]
}
