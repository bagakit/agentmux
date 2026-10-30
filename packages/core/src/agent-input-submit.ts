import { parseAgentInputImageReference, type AgentInputImageReference } from './agent-input-resource.js'
import { AgentMuxError } from './errors.js'
import { parseAgentInputMoteSource, type AgentInputMoteSource } from './mote-input-source.js'
import { rpcRecord } from './rpc-data.js'
import { validateAgentDirectedPromptTarget, validateAgentPromptCondition, validateAgentPromptInputKey, type AgentPromptCondition, type AgentDirectedPromptTarget } from './agent-prompt-condition.js'
import { parseBrowserInputContext, type BrowserInputContext } from './browser-input-context.js'
import type { AgentMuxRunRef, AgentPromptExecution, AgentPromptSubmissionRecord } from './types.js'
import type { AgentInputSubmissionReceipt } from './agent-input-wait.js'
import { parseAgentInputContextCaptureReference, type AgentInputContextCaptureReference } from './agent-input-context-capture.js'
import { normalizeMessageChannel } from './message-origin.js'

/** Unmanaged transport intake. Author, platform notes and automatic fences are not business arguments. */
export type AgentInputSubmit = {
  agentSessionId: string; operationId: string; prompt: string; inputContext?: BrowserInputContext
  inputImages?: AgentInputImageReference[]
  /** Selects fixed app-owned guidance only; author and role authority remain transport/Host-owned. */
  moteGuidance?: true
  /** Original capture packet only. The execution owner verifies its original target/body/note digest. */
  capturedContext?: { reference: AgentInputContextCaptureReference; agentMuxNote?: string }
  moteSource?: AgentInputMoteSource
  /** Original request attribution only; it grants no author, role or automatic-input authority. */
  sourceChannel?: import('./types.js').AgentMessageChannel
  allowUncertainTurn?: boolean
} & ((AgentPromptCondition & { execution?: AgentPromptExecution; admissionIntent?: never; preparationRetry?: import('./prompt-preparation.js').AgentPromptPreparationRetryFence }) |
  { expectedRun: AgentMuxRunRef; afterSubmissionId?: never; admissionIntent: AgentDirectedPromptTarget; execution: 'immediate'; preparationRetry?: never })
export type AgentInputSubmitResult = {
  moteObservationId?:string
  key: Extract<import('./agent-prompt-condition.js').AgentPromptInputKey, { kind: 'prompt' }>
  record: AgentPromptSubmissionRecord | null
  input?: AgentInputSubmissionReceipt | null
}
export const AGENT_INPUT_SUBMIT_FIELDS = ['agentSessionId', 'operationId', 'prompt', 'inputImages', 'inputContext', 'capturedContext', 'moteSource', 'moteGuidance', 'sourceChannel', 'preparationRetry', 'expectedRun', 'afterSubmissionId', 'admissionIntent', 'execution', 'allowUncertainTurn'] as const
export function parseAgentInputSubmit(value: unknown): AgentInputSubmit {
  const p = rpcRecord(value, AGENT_INPUT_SUBMIT_FIELDS)
  const key = validateAgentPromptInputKey({ kind: 'prompt', agentSessionId: p.agentSessionId, expectedRun: p.expectedRun, submissionId: p.operationId })
  if (typeof p.prompt !== 'string' || !p.prompt.trim() || p.prompt.includes('\0') ||
      p.allowUncertainTurn !== undefined && typeof p.allowUncertainTurn !== 'boolean' ||
      p.moteGuidance !== undefined && p.moteGuidance !== true ||
      p.execution !== undefined && p.execution !== 'default' && p.execution !== 'immediate') throw new AgentMuxError('The original prompt and execution choice are invalid.', 'INVALID_AGENT_PROMPT')
  let capturedContext: AgentInputSubmit['capturedContext']
  if (p.capturedContext !== undefined) {
    const packet = rpcRecord(p.capturedContext, ['reference', 'agentMuxNote'], 'INVALID_INPUT_CONTEXT_CAPTURE')
    if (p.inputContext !== undefined || p.moteGuidance !== undefined || packet.agentMuxNote !== undefined &&
      (typeof packet.agentMuxNote !== 'string' || packet.agentMuxNote.includes('\0'))) throw new AgentMuxError('A captured input retains its original packet; a second context or platform note cannot replace it.', 'INVALID_INPUT_CONTEXT_CAPTURE')
    capturedContext = { reference: parseAgentInputContextCaptureReference(packet.reference), ...(packet.agentMuxNote === undefined ? {} : { agentMuxNote: packet.agentMuxNote as string }) }
  }
  let preparationRetry: AgentInputSubmit['preparationRetry']
  if (p.preparationRetry !== undefined) {
    const retry = rpcRecord(p.preparationRetry, ['inputByte', 'nativeSourceId'], 'INVALID_AGENT_PROMPT')
    if (p.admissionIntent !== undefined || p.execution !== 'immediate' || !Number.isSafeInteger(retry.inputByte) || Number(retry.inputByte) < 0 ||
      typeof retry.nativeSourceId !== 'string' || !retry.nativeSourceId || retry.nativeSourceId.length > 4096) throw new AgentMuxError('Preparation retry retains its original finite input and native-source fence.', 'INVALID_AGENT_PROMPT')
    preparationRetry = { inputByte: retry.inputByte as number, nativeSourceId: retry.nativeSourceId }
  }
  const common = { agentSessionId: key.agentSessionId, operationId: p.operationId as string, prompt: p.prompt,
    ...(p.sourceChannel === undefined ? {} : {sourceChannel:normalizeMessageChannel(p.sourceChannel)}),
    ...(p.moteGuidance === true ? {moteGuidance:true as const} : {}),
    ...(capturedContext === undefined ? {} : { capturedContext }),
    ...(p.moteSource === undefined ? {} : {moteSource:parseAgentInputMoteSource(p.moteSource)}),
    ...(p.inputImages === undefined ? {} : { inputImages: (() => { if (!Array.isArray(p.inputImages)) throw new AgentMuxError('Selected input images must be a list.', 'INVALID_AGENT_INPUT_RESOURCE'); return p.inputImages.map(parseAgentInputImageReference) })() }),
    ...(p.inputContext === undefined ? {} : { inputContext: parseBrowserInputContext(p.inputContext) }),
    ...(p.allowUncertainTurn === undefined ? {} : { allowUncertainTurn: p.allowUncertainTurn as boolean }) }
  if (p.admissionIntent !== undefined) {
    if (Object.hasOwn(p, 'afterSubmissionId') || p.execution !== 'immediate') throw new AgentMuxError('Directed input retains its exact Run and immediate execution intent.', 'INVALID_AGENT_PROMPT')
    return { ...common, expectedRun: key.expectedRun, admissionIntent: validateAgentDirectedPromptTarget(p.admissionIntent), execution: 'immediate' }
  }
  return { ...common, ...validateAgentPromptCondition({ expectedRun: key.expectedRun, ...(Object.hasOwn(p, 'afterSubmissionId') ? { afterSubmissionId: p.afterSubmissionId } : {}) }),
    ...(preparationRetry === undefined ? {} : { preparationRetry }),
    ...(p.execution === undefined ? {} : { execution: p.execution as AgentPromptExecution }) }
}
