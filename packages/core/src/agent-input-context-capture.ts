import { sha256 } from '@noble/hashes/sha2.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseBrowserInputContext, type BrowserInputContext } from './browser-input-context.js'
import type { AgentMuxRunRef } from './types.js'

/** The capture owner and original input ID, independently of the execution Host or Browser operation. */
export type AgentInputContextCaptureReference = { hostId: string; operationId: string }
export type AgentInputContextCaptureBinding = { executionHostId: string; agentSessionId: string; originRun: AgentMuxRunRef }
export type AgentInputContextCaptureIntent = {
  reference: AgentInputContextCaptureReference
  binding: AgentInputContextCaptureBinding
  prompt: string
  agentMuxNote?: string
  inputContext: BrowserInputContext
}
/** Historical producer metadata. No body, author, live grant or delivery conclusion. */
export type AgentInputContextCaptureProof = {
  reference: AgentInputContextCaptureReference
  binding: AgentInputContextCaptureBinding
  intentDigest: string
}
export type AgentInputContextCaptureRecord = AgentInputContextCaptureProof & {
  schema: 'agentmux.input-context-capture.v1'
  inputContext: BrowserInputContext
}
export type AgentInputContextCaptureRead = {
  reference: AgentInputContextCaptureReference
  record: AgentInputContextCaptureRecord | null
  diskDurability: 'confirmed' | 'unconfirmed'
}
/** Non-wire reader installed by the original Host. Construction never contacts the capture owner. */
export interface AgentInputContextCaptureReader {
  read(reference: AgentInputContextCaptureReference, options?: { signal?: AbortSignal }): Promise<AgentInputContextCaptureRead>
}

function fail(): never { throw new AgentMuxError('The original input capture is malformed. Retain its original reference and message.', 'INVALID_INPUT_CONTEXT_CAPTURE') }
function text(value: unknown, identity = false): string {
  if (typeof value !== 'string' || value.includes('\0') || identity && (!value.trim() || /[\r\n]/u.test(value))) fail()
  return value as string
}
export function parseAgentInputContextCaptureReference(value: unknown): AgentInputContextCaptureReference {
  const p = rpcRecord(value, ['hostId', 'operationId'], 'INVALID_INPUT_CONTEXT_CAPTURE')
  return { hostId: text(p.hostId, true), operationId: text(p.operationId, true) }
}
function binding(value: unknown): AgentInputContextCaptureBinding {
  const p = rpcRecord(value, ['executionHostId', 'agentSessionId', 'originRun'], 'INVALID_INPUT_CONTEXT_CAPTURE')
  const run = rpcRecord(p.originRun, ['runId'], 'INVALID_INPUT_CONTEXT_CAPTURE')
  return { executionHostId: text(p.executionHostId, true), agentSessionId: text(p.agentSessionId, true), originRun: { runId: text(run.runId, true) } }
}
export function parseAgentInputContextCaptureProof(value: unknown): AgentInputContextCaptureProof {
  const p = rpcRecord(value, ['reference', 'binding', 'intentDigest'], 'INVALID_INPUT_CONTEXT_CAPTURE')
  if (typeof p.intentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(p.intentDigest)) fail()
  return { reference: parseAgentInputContextCaptureReference(p.reference), binding: binding(p.binding), intentDigest: p.intentDigest as string }
}
export function parseAgentInputContextCaptureRecord(value: unknown): AgentInputContextCaptureRecord {
  const p = rpcRecord(value, ['schema', 'reference', 'binding', 'intentDigest', 'inputContext'], 'INVALID_INPUT_CONTEXT_CAPTURE')
  if (p.schema !== 'agentmux.input-context-capture.v1') fail()
  const proof = parseAgentInputContextCaptureProof({ reference: p.reference, binding: p.binding, intentDigest: p.intentDigest })
  const inputContext = parseBrowserInputContext(p.inputContext)
  if (proof.reference.hostId !== inputContext.browser.hostId) fail()
  return { schema: p.schema, ...proof, inputContext }
}
export function parseAgentInputContextCaptureRead(value: unknown, reference: AgentInputContextCaptureReference): AgentInputContextCaptureRead {
  const p = rpcRecord(value, ['reference', 'record', 'diskDurability'], 'INVALID_INPUT_CONTEXT_CAPTURE')
  const echoed = parseAgentInputContextCaptureReference(p.reference)
  if (echoed.hostId !== reference.hostId || echoed.operationId !== reference.operationId ||
      p.diskDurability !== 'confirmed' && p.diskDurability !== 'unconfirmed') fail()
  const record = p.record === null ? null : parseAgentInputContextCaptureRecord(p.record)
  if (record && (record.reference.hostId !== echoed.hostId || record.reference.operationId !== echoed.operationId)) fail()
  return { reference: echoed, record, diskDurability: p.diskDurability as AgentInputContextCaptureRead['diskDurability'] }
}
/** Stable message and scene identity; carrier, condition, choice and preparation fences remain with Core. */
export function createAgentInputContextCaptureRecord(value: AgentInputContextCaptureIntent): AgentInputContextCaptureRecord {
  const p = rpcRecord(value, ['reference', 'binding', 'prompt', 'agentMuxNote', 'inputContext'], 'INVALID_INPUT_CONTEXT_CAPTURE')
  const reference = parseAgentInputContextCaptureReference(p.reference), target = binding(p.binding), inputContext = parseBrowserInputContext(p.inputContext)
  if (reference.hostId !== inputContext.browser.hostId) fail()
  const identity = { schema: 'agentmux.input-context-capture.v1' as const, reference, binding: target, prompt: text(p.prompt),
    ...(p.agentMuxNote === undefined ? {} : { agentMuxNote: text(p.agentMuxNote) }), inputContext }
  const intentDigest = Array.from(sha256(new TextEncoder().encode(JSON.stringify(identity))), byte => byte.toString(16).padStart(2, '0')).join('')
  return { schema: identity.schema, reference, binding: target, intentDigest, inputContext }
}
/** Internal persisted metadata uses its own field and codec, never the business capture reference. */
export function agentInputContextCaptureProofFields(value: { inputContextCaptureProof?: unknown; inputContext?: unknown; inputContextSource?: unknown }): {
  inputContextCaptureProof?: AgentInputContextCaptureProof
} {
  if (value.inputContextCaptureProof === undefined) return {}
  const proof = parseAgentInputContextCaptureProof(value.inputContextCaptureProof)
  if (value.inputContextSource !== 'host-capture' || parseBrowserInputContext(value.inputContext).browser.hostId !== proof.reference.hostId) fail()
  return { inputContextCaptureProof: proof }
}
