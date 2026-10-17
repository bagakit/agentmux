import { createAgentInputContextCaptureRecord, parseAgentInputContextCaptureRead } from '@agentmux/core/agent-input-context-capture'
import { browserInputContextJson } from '@agentmux/core/browser-input-context'
import type { AgentPromptMessageContent } from '@agentmux/core'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { BrowserInputContextFreezeReceipt } from '../../../shared/browser-input-context-capture'

/** Display and original intent only. Core independently reads and verifies its capture owner. */
export type BrowserCapturedInput = { control: AgentSessionControl; capture: BrowserInputContextFreezeReceipt }

export function frozenBrowserInput(value: BrowserCapturedInput, sessionId: string, operationId: string, prompt: string, agentMuxNote?: string): BrowserCapturedInput {
  const control = value.control
  const capture = parseAgentInputContextCaptureRead(value.capture, value.capture.reference)
  const record = capture.record
  if (!record || control.kind !== 'agent' || control.agentSessionId !== sessionId || record.reference.operationId !== operationId ||
      record.binding.executionHostId !== control.hostId || record.binding.agentSessionId !== control.agentSessionId ||
      record.binding.originRun.runId !== control.run.runId || createAgentInputContextCaptureRecord({ reference: record.reference,
        binding: record.binding, prompt, ...(agentMuxNote === undefined ? {} : { agentMuxNote }), inputContext: record.inputContext }).intentDigest !== record.intentDigest) {
    throw new Error('This captured opinion does not match its original recipient, message or Run. Your draft and capture are kept.')
  }
  return structuredClone({ control, capture: { ...capture, record } })
}

/** Compare original Core fields, never a newly formatted wire or the current Browser. */
export function matchesBrowserInputMessage(input: BrowserCapturedInput | undefined, message: AgentPromptMessageContent): boolean {
  const proof = message.inputContextCaptureProof
  if (!input) return proof === undefined
  try {
    const record = parseAgentInputContextCaptureRead(input.capture, input.capture.reference).record
    return record !== null && message.inputContextSource === 'host-capture' && message.inputContext !== undefined && proof !== undefined &&
      proof.reference.hostId === record.reference.hostId && proof.reference.operationId === record.reference.operationId &&
      proof.binding.executionHostId === record.binding.executionHostId && proof.binding.agentSessionId === record.binding.agentSessionId &&
      proof.binding.originRun.runId === record.binding.originRun.runId && proof.intentDigest === record.intentDigest &&
      browserInputContextJson(message.inputContext) === browserInputContextJson(record.inputContext)
  } catch { return false } // A damaged saved projection cannot replace Core's original receipt.
}
