import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentInputSubmissionReceipt } from './agent-input-wait.js'

/** Original journal membership, independent of later dispatch or capture. */
export type AgentInputJournalCut = { queueId: string; incarnation: string; sequence: number }
export type AgentInputSubmissionObservation = Pick<AgentInputSubmissionReceipt, 'status' | 'observation'>

export function parseAgentInputJournalCut(value: unknown): AgentInputJournalCut {
  const p = rpcRecord(value, ['queueId', 'incarnation', 'sequence'], 'INVALID_AGENT_INPUT_READ')
  if (typeof p.queueId !== 'string' || !p.queueId.trim() || /[\0\r\n]/u.test(p.queueId) ||
      typeof p.incarnation !== 'string' || !p.incarnation.trim() || /[\0\r\n]/u.test(p.incarnation) ||
      !Number.isSafeInteger(p.sequence) || (p.sequence as number) < 0) throw new AgentMuxError(
    'The original input journal position is invalid.', 'INVALID_AGENT_INPUT_READ')
  return { queueId: p.queueId, incarnation: p.incarnation, sequence: p.sequence as number }
}

export function parseAgentInputSubmissionObservation(value: unknown): AgentInputSubmissionObservation {
  const p = rpcRecord(value, ['status', 'observation'], 'INVALID_AGENT_INPUT_READ')
  if (!['waiting', 'stopped', 'terminal-confirmed', 'admitted', 'not-applied', 'unknown'].includes(p.status as string) ||
      !['owned', 'rejoin-needed', 'closed'].includes(p.observation as string)) throw new AgentMuxError(
    'The original input observation is invalid.', 'INVALID_AGENT_INPUT_READ')
  return { status: p.status as AgentInputSubmissionObservation['status'], observation: p.observation as AgentInputSubmissionObservation['observation'] }
}
