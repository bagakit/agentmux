import '../result-ready-input-continuity/entry'
import { flushSync } from 'react-dom'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import type { RuntimeEvent } from '../../../src/shared/contracts'

// Reuse the healthy two-Region Renderer fixture. Only existing API facts/failures are controlled;
// neither TerminalView nor its notification children are replaced with a fixture component.
const original = (window as any).resultReady
const attach = api.sessions.attach, resize = api.sessions.resize, write = api.sessions.write
const onEvent = api.sessions.onEvent
const listeners = new Set<Parameters<typeof api.sessions.onEvent>[0]>()
api.sessions.onEvent = (listener, ...args) => {
  listeners.add(listener); const dispose = onEvent(listener, ...args)
  return () => { listeners.delete(listener); dispose() }
}
const ownAttachments = new Set<string>()
let mode = 'healthy', delayed: (() => void) | null = null, redrawCalls = 0, liveCursor: number | null = null
const current = () => useAppStore.getState().sessions.find(s => s.id === original.sessionId)!
api.sessions.attach = async (...args) => {
  const result = await attach(...args)
  if (args[0].kind !== 'agent' || args[0].agentSessionId !== original.sessionId) return result
  ownAttachments.add(result.attachmentId)
  if (mode === 'reveal') await new Promise<void>(resolve => { delayed = resolve })
  if (mode === 'continuation') return { ...result, terminal: { type: 'unknown', reason: 'origin_unknown' } }
  if (mode === 'geometry' || mode === 'all') return { ...result, currentSize: null,
    terminal: { type: 'unknown', reason: 'origin_unknown' } }
  if (mode === 'gap') return { ...result, terminal: { type: 'unknown', reason: 'source_gap' },
    gap: { requestedFromByte: 0, firstAvailableByte: 0 } }
  return result
}
api.sessions.resize = async (...args) => {
  if (ownAttachments.has(args[0]) && (mode === 'viewport' || mode === 'all'))
    throw new Error('Private viewport synchronization failure Diagnostic: cursor=123')
  return resize(...args)
}
api.sessions.refreshAttachment = async () => { throw new Error('Private observation failure Diagnostic: cursor=' + Date.now()) }
useAppStore.setState({ refreshSession: async () => current() })
api.sessions.replay = async () => { throw new Error('Private retained history read failure') }
api.sessions.redraw = async () => { redrawCalls++; return undefined }
function event(data: string, startByte: number) {
  const session = current(), dataBytes = new TextEncoder().encode(data), endByte = startByte + dataBytes.length
  const value: RuntimeEvent = { type: 'core', hostId: session.hostId, event: { type: 'terminal-output',
    agentSessionId: session.id, run: session.control.run, data, dataBytes,
    evidence: { source: 'terminal-output', observedAt: Date.now(), run: session.control.run, outputByteRange: { startByte, endByte } } } }
  for (const listener of listeners) listener(value)
  return endByte
}
api.sessions.write = async (...args) => {
  await write(...args)
  if (liveCursor !== null && args[0].kind === 'agent' && args[0].agentSessionId === original.sessionId)
    liveCursor = event(typeof args[1] === 'string' ? args[1] : String.fromCharCode(...args[1]), liveCursor)
}
function observed(value: boolean) {
  flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(s => s.id === original.sessionId
    ? { ...s, ...(value ? { terminalCapability: { state: 'unknown', reason: 'handshake-timeout', observedAt: Date.now() } } : { terminalCapability: undefined }) }
    : s) })))
}
Object.assign(window, { terminalNotice: {
  seed(value: string, readonly = false) { mode = value; delayed = null; liveCursor = null; original.seed(readonly ? 'readonly' : 'healthy');
    if (value === 'session' || value === 'all' || value === 'attachment') observed(true)
  }, observed, facts: () => ({ ...original.facts(), redrawCalls }), terminal: () => original.terminal(),
  releaseReveal() { delayed?.(); delayed = null }, visible: (value: boolean) => original.visible(value),
  historyFailure() { liveCursor = event('\r\nagent > recovered live prompt', 100_000) },
  newCause() { flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(s => s.id === original.sessionId
    ? { ...s, terminalCapability: undefined, terminalOutputChannel: { state: 'failed', reason: 'reattach-failed', observedAt: Date.now() } } : s) }))) },
  newRun() { flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(s => s.id === original.sessionId
    ? { ...s, control: { ...s.control, run: { ...s.control.run, runId: s.control.run.runId + '-new', generation: s.control.run.generation + 1 } } } : s) }))) }
} })
