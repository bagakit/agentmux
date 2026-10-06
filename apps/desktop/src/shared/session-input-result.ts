import type { SessionInputWriteResult, SessionInputOperationResult } from './contracts'
import { deliveryFailure } from '@agentmux/core/delivery-attempt'
import type { AgentMuxControlFailure, AgentInputSubmissionReceipt } from '@agentmux/core'

/** One write attempt; uncertain input is reported, never replayed at the IPC boundary. */
export async function sessionInputWriteResult(write: () => Promise<void | AgentInputSubmissionReceipt>): Promise<SessionInputWriteResult> {
  try {
    const inputReceipt = await write()
    return { ok: true, ...(inputReceipt ? { inputReceipt } : {}) }
  } catch (error) {
    const source = error instanceof Error ? error as Error & { code?: string; detail?: string; controlFailure?: AgentMuxControlFailure; logId?: string } : null
    return { ok: false, error: {
      code: typeof source?.code === 'string' ? source.code : 'SESSION_INPUT_FAILED',
      message: source?.message ?? String(error),
      ...(source?.logId === undefined ? {} : { logId: source.logId }),
      ...(source?.detail === undefined ? {} : { detail: source.detail }),
      ...(source?.controlFailure === undefined ? {} : { controlFailure: source.controlFailure })
    } }
  }
}

/** Restore the original typed failure in Renderer after IPC and contextBridge copy the envelope. */
export function unwrapSessionInputWriteResult(result: SessionInputWriteResult): void | AgentInputSubmissionReceipt {
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
  return result.inputReceipt
}

export async function sessionInputOperationResult<T>(operation: () => Promise<T>): Promise<SessionInputOperationResult<T>> {
  try { return { ok: true, value: await operation() } }
  catch (error) {
    const failure = deliveryFailure(error)
    return { ok: false, error: { ...failure, code: failure.code ?? 'SESSION_INPUT_FAILED' } }
  }
}

export function unwrapSessionInputOperationResult<T>(result: SessionInputOperationResult<T>): T {
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
  return result.value
}
