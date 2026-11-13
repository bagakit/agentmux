import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { api } from './api'
import { acceptAgentStopReceipt, agentOperationKey, beginAgentOperation, updateAgentOperation } from './agent-operation-feedback'
import { sessionStopErrorCode, sessionStopFailedStage, STALE_STOP_CODE, type SessionStopIntent } from './session-stop-intent'

const flights = new Map<string, { promise: Promise<boolean>; reader: object }>()

/** The caller already confirmed this frozen intent. Component lifetime owns no Stop work. */
export function stopSessionInBackground(intent: SessionStopIntent, options: { continueOriginal?: boolean } = {}): Promise<boolean> {
  const operation = { kind: 'stop' as const, operationId: intent.operationId, control: intent.control,
    subject: { hostId: intent.control.hostId, agentSessionId: intent.control.agentSessionId },
    phase: 'pending' as const, startedAt: Date.now() }
  const key = agentOperationKey(operation), flight = flights.get(key)
  if (flight && !options.continueOriginal) return flight.promise
  beginAgentOperation(operation)
  updateAgentOperation(operation, { phase: 'pending', message: undefined, canContinue: false })
  const reader = {}
  const sent = Promise.resolve().then(async () => {
    try {
      const receipt = await api.sessions.stop(intent.control, intent.operationId)
      return acceptAgentStopReceipt(operation, receipt)
    } catch (error) {
      const current = useAppStore.getState().agentOperations[key]
      if (!current || current.phase === 'succeeded') return current?.phase === 'succeeded'
      const stale = sessionStopErrorCode(error) === STALE_STOP_CODE
      const stage = sessionStopFailedStage(error), code = sessionStopErrorCode(error)
      const message = stale ? '运行已变化，本次原 Run 未停止。请重新选择当前 Run 并确认。'
        : `${stage ? `Failed stage: ${stage}` : 'Failed stage: not recorded'}${code ? ` (${code})` : ''}. ${presentError(error)}`
      updateAgentOperation(operation, { phase: stale ? 'failed' : 'unconfirmed', message, canContinue: false })
      useAppStore.getState().reportError(error, { kind: 'indeterminate', subject: intent.control,
        summary: `Stop ${intent.operationId} is unconfirmed. The original Session, workface, history and drafts are kept. Check this same operation.` })
      return false
    } finally { if (flights.get(key)?.reader === reader) flights.delete(key) }
  })
  flights.set(key, { promise: sent, reader })
  return sent
}
