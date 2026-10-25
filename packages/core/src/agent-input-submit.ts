import { parseAgentInputImageReference, type AgentInputImageReference } from './agent-input-resource.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { validateAgentDirectedPromptTarget, validateAgentPromptCondition, validateAgentPromptInputKey, type AgentPromptCondition, type AgentDirectedPromptTarget } from './agent-prompt-condition.js'
import { parseBrowserInputContext, type BrowserInputContext } from './browser-input-context.js'
import type { AgentMuxRunRef, AgentPromptExecution, AgentPromptSubmissionRecord } from './types.js'
import type { AgentInputSubmissionReceipt } from './agent-input-wait.js'

/** Unmanaged transport intake. Author, platform notes and automatic fences are not business arguments. */
export type AgentInputSubmit = {
  agentSessionId: string; operationId: string; prompt: string; inputContext?: BrowserInputContext
  inputImages?: AgentInputImageReference[]
  allowUncertainTurn?: boolean
} & ((AgentPromptCondition & { execution?: AgentPromptExecution; admissionIntent?: never }) |
  { expectedRun: AgentMuxRunRef; afterSubmissionId?: never; admissionIntent: AgentDirectedPromptTarget; execution: 'immediate' })
export type AgentInputSubmitResult = {
  key: Extract<import('./agent-prompt-condition.js').AgentPromptInputKey, { kind: 'prompt' }>
  record: AgentPromptSubmissionRecord | null
  input?: AgentInputSubmissionReceipt | null
}
export const AGENT_INPUT_SUBMIT_FIELDS = ['agentSessionId', 'operationId', 'prompt', 'inputImages', 'inputContext', 'expectedRun', 'afterSubmissionId', 'admissionIntent', 'execution', 'allowUncertainTurn'] as const
export function parseAgentInputSubmit(value: unknown): AgentInputSubmit {
  const p = rpcRecord(value, AGENT_INPUT_SUBMIT_FIELDS)
  const key = validateAgentPromptInputKey({ kind: 'prompt', agentSessionId: p.agentSessionId, expectedRun: p.expectedRun, submissionId: p.operationId })
  if (typeof p.prompt !== 'string' || !p.prompt.trim() || p.prompt.includes('\0') ||
      p.allowUncertainTurn !== undefined && typeof p.allowUncertainTurn !== 'boolean' ||
      p.execution !== undefined && p.execution !== 'default' && p.execution !== 'immediate') throw new AgentMuxError('The original prompt and execution choice are invalid.', 'INVALID_AGENT_PROMPT')
  const common = { agentSessionId: key.agentSessionId, operationId: p.operationId as string, prompt: p.prompt,
    ...(p.inputImages === undefined ? {} : { inputImages: (() => { if (!Array.isArray(p.inputImages)) throw new AgentMuxError('Selected input images must be a list.', 'INVALID_AGENT_INPUT_RESOURCE'); return p.inputImages.map(parseAgentInputImageReference) })() }),
    ...(p.inputContext === undefined ? {} : { inputContext: parseBrowserInputContext(p.inputContext) }),
    ...(p.allowUncertainTurn === undefined ? {} : { allowUncertainTurn: p.allowUncertainTurn as boolean }) }
  if (p.admissionIntent !== undefined) {
    if (Object.hasOwn(p, 'afterSubmissionId') || p.execution !== 'immediate') throw new AgentMuxError('Directed input retains its exact Run and immediate execution intent.', 'INVALID_AGENT_PROMPT')
    return { ...common, expectedRun: key.expectedRun, admissionIntent: validateAgentDirectedPromptTarget(p.admissionIntent), execution: 'immediate' }
  }
  return { ...common, ...validateAgentPromptCondition({ expectedRun: key.expectedRun, ...(Object.hasOwn(p, 'afterSubmissionId') ? { afterSubmissionId: p.afterSubmissionId } : {}) }),
    ...(p.execution === undefined ? {} : { execution: p.execution as AgentPromptExecution }) }
}
