import type { AgentMuxControlFailure } from '@agentmux/core'

// Errors lose their custom fields through both Electron IPC and contextBridge.
export type SessionInputReceipt = { ok: true } | { ok: false; error: {
  name: string
  message: string
  code?: string | undefined
  detail?: string | undefined
  controlFailure?: AgentMuxControlFailure | undefined
} }

export async function captureSessionInput(operation: () => Promise<void>): Promise<SessionInputReceipt> {
  try { await operation(); return { ok: true } }
  catch (cause) {
    const error = (cause instanceof Error ? cause : new Error(String(cause))) as Error & {
      code?: string; detail?: string; controlFailure?: AgentMuxControlFailure
    }
    return { ok: false, error: { name: error.name, message: error.message,
      code: error.code, detail: error.detail, controlFailure: error.controlFailure } }
  }
}

export function requireSessionInput(receipt: SessionInputReceipt): void {
  if (receipt.ok) return
  const failure = receipt.error.controlFailure
  const confirmation = failure ? failure.confirmedInputBytes === null
    ? ' Confirmed input bytes are unknown.'
    : ` Confirmed input prefix: ${failure.confirmedInputBytes} bytes.` : ''
  const outcome = failure ? failure.disposition === 'unknown'
    ? ' Remaining input delivery is unconfirmed. Input was not resent.'
    : ' Input was not applied. Input was not resent.' : ''
  throw Object.assign(new Error(receipt.error.message + confirmation + outcome), {
    name: receipt.error.name, code: receipt.error.code, detail: receipt.error.detail,
    controlFailure: failure
  })
}
