import { AgentMuxError } from './errors.js'
import { observeRead } from './observation-read.js'
import { createAgentInputContextCaptureRecord, parseAgentInputContextCaptureRead, agentInputContextCaptureProofFields,
  type AgentInputContextCaptureReference, type AgentInputContextCaptureReader, type AgentInputContextCaptureProof } from './agent-input-context-capture.js'
import { parseBrowserInputContext, type BrowserInputContext } from './browser-input-context.js'
import type { AgentMuxRunRef, AgentPromptMessageContent } from './types.js'

export type ResolvedAgentInputContextCapture = { inputContext: BrowserInputContext; inputContextCaptureProof: AgentInputContextCaptureProof }
type Intent = { reference: AgentInputContextCaptureReference; agentSessionId: string; expectedRun: AgentMuxRunRef; operationId: string; prompt: string; agentMuxNote?: string }
type Frozen = Pick<AgentPromptMessageContent, 'inputContext' | 'inputContextSource' | 'inputContextCaptureProof'>

/** The original input owner supplies its exact saved producer, before and after this read-only await.
 * A Host reader bounds its own transport observation; cancellation never cancels the original input. */
export async function resolveAgentInputContextCapture(intent: Intent, readFrozen: () => Promise<Frozen | undefined>,
  reader?: AgentInputContextCaptureReader, signal?: AbortSignal): Promise<ResolvedAgentInputContextCapture> {
  const fail = (code: string, stage: string): never => { throw new AgentMuxError(
    'The original input capture is unconfirmed. Retain this reference and message; restore its capture owner before explicitly retrying. Ordinary input remains available.', code,
    JSON.stringify({ reference: intent.reference, agentSessionId: intent.agentSessionId, originRun: intent.expectedRun, stage })) }
  const binding = { executionHostId: 'local', agentSessionId: intent.agentSessionId, originRun: intent.expectedRun }
  const verify = (context: BrowserInputContext, proof: AgentInputContextCaptureProof, code: string) => {
    const expected = createAgentInputContextCaptureRecord({ reference: intent.reference, binding, prompt: intent.prompt,
      ...(intent.agentMuxNote === undefined ? {} : { agentMuxNote: intent.agentMuxNote }), inputContext: context })
    if (intent.reference.hostId !== 'local' || intent.reference.operationId !== intent.operationId ||
        JSON.stringify(proof) !== JSON.stringify({ reference: expected.reference, binding: expected.binding, intentDigest: expected.intentDigest })) fail(code, 'stable-input-match')
    return { inputContext: context, inputContextCaptureProof: proof }
  }
  const frozen = (value: Frozen): ResolvedAgentInputContextCapture => {
    const { inputContextCaptureProof: proof } = agentInputContextCaptureProofFields(value)
    if (!proof || !value.inputContext) fail('AGENT_PROMPT_OPERATION_CONFLICT', 'original-producer')
    return verify(parseBrowserInputContext(value.inputContext), proof!, 'AGENT_PROMPT_OPERATION_CONFLICT')
  }
  const original = await readFrozen()
  if (original) return frozen(original)
  if (!reader || intent.reference.hostId !== 'local') fail('AGENT_INPUT_CONTEXT_CAPTURE_UNCONFIRMED', 'capture-owner-route')
  signal?.throwIfAborted()
  let record
  try { record = parseAgentInputContextCaptureRead(await observeRead(reader!.read(structuredClone(intent.reference), { ...(signal ? { signal } : {}) }), signal), intent.reference).record }
  catch (error) {
    if (signal?.aborted) throw error
    fail('AGENT_INPUT_CONTEXT_CAPTURE_UNCONFIRMED', 'capture-owner-read')
  }
  // Another same-key producer may have frozen while the Host observation was in flight.
  const concurrent = await readFrozen()
  if (concurrent) return frozen(concurrent)
  if (!record) fail('AGENT_INPUT_CONTEXT_CAPTURE_UNCONFIRMED', 'capture-record-unavailable')
  const { schema: _schema, inputContext, ...proof } = record!
  return verify(inputContext, proof, 'AGENT_INPUT_CONTEXT_CAPTURE_CONFLICT')
}
