import { DateTime } from 'luxon'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import { MAX_AGENT_TIMELINE_INPUT_ITEMS } from '@agentmux/core/timeline'
import type { AgentScheduleCheckInState } from '@agentmux/core/schedule'
import type { ContinuousProgressLoop } from '@agentmux/core'

export type CheckInHuman = { id: string; createdAt: number }
export type CheckInObservation = { known: true; human: CheckInHuman } | { known: false; reason: string }
/** Only an original strict-current read supplies these snapshots. Native text never establishes an author. */
export function checkInHumanObservation(agentSessionId: string, timeline: AgentTimelineSnapshot, page: AgentSessionHistoryPage, now: number): CheckInObservation {
  const unknown = (reason: string): CheckInObservation => ({ known: false, reason })
  if (timeline.agentSessionId !== agentSessionId || page.agentSessionId !== agentSessionId || timeline.items.some(item => item.agentSessionId !== agentSessionId)) return unknown('The original conversation identity is unconfirmed.')
  const inputs = timeline.items.filter(item => item.kind === 'user_message')
  if (inputs.length >= MAX_AGENT_TIMELINE_INPUT_ITEMS || page.nextCursor !== null || !Number.isSafeInteger(page.sourceSizeBytes) || page.sourceSizeBytes! < 0) return unknown('The conversation coverage is bounded or unconfirmed; silence and replies are not inferred.')
  if (inputs.some(item => !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || item.createdAt > now)) return unknown('An input occurrence time is unconfirmed; silence and replies are not inferred.')
  const human = inputs.filter(item => item.status === 'complete' && item.authorHuman === true && item.authorAgentSessionId === undefined && Number.isSafeInteger(item.createdAt) && item.createdAt <= now).sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!human || !human.content?.trim()) return unknown('No confirmed human conversation context is available; no topic will be invented.')
  if (inputs.some(item => item.createdAt > human.createdAt && (item.status !== 'complete' || item.authorHuman !== true || item.authorAgentSessionId !== undefined))) return unknown('A later input has unknown or Agent authorship; a human reply and silence are unconfirmed.')
  if (page.items.some(item => item.kind === 'user-message' && (!Number.isSafeInteger(item.startedAt) || item.startedAt! < 0 || item.startedAt! > human.createdAt || item.startedAt! > now))) return unknown('A native input cannot confirm human authorship or silence after the captured human message.')
  return { known: true, human: { id: human.id, createdAt: human.createdAt } }
}
export function decideCheckIn(loop: ContinuousProgressLoop, observation: CheckInObservation, now: number): { send: boolean; reason: string; state: AgentScheduleCheckInState } {
  const policy = loop.checkIn!, state = { ...loop.checkInState }
  if (!observation.known) return { send: false, reason: observation.reason, state }
  const human = observation.human, unanswered = state.unanswered
  if (unanswered && human.id !== unanswered.humanId && human.createdAt > unanswered.claimAt) delete state.unanswered
  if (state.unanswered) return { send: false, reason: 'The previous quiet follow-up has no confirmed human reply; another question is suppressed.', state }
  if (now - human.createdAt < policy.silenceMs) return { send: false, reason: 'The confirmed human conversation is still within the saved silence interval.', state }
  if (state.lastClaimAt !== undefined && now - state.lastClaimAt < policy.minIntervalMs) return { send: false, reason: 'The saved minimum follow-up interval has not elapsed.', state }
  const civil = DateTime.fromMillis(now, { zone: loop.calendar!.timezone }), time = civil.toFormat('HH:mm'), date = civil.toISODate()!
  const { start, end } = policy.quiet
  if (start < end ? time >= start && time < end : time >= start || time < end) return { send: false, reason: 'The saved local quiet period is active.', state }
  const used = state.budgetDate === date ? state.budgetUsed ?? 0 : 0
  if (used >= policy.dailyBudget) return { send: false, reason: 'The saved civil-day follow-up budget is exhausted.', state }
  return { send: true, reason: 'One quiet follow-up is eligible from the confirmed conversation.', state: { ...state, lastClaimAt: now, budgetDate: date, budgetUsed: used + 1, unanswered: { humanId: human.id, humanCreatedAt: human.createdAt, claimAt: now } } }
}
