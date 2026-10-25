import type { ContinuousProgressTarget } from '@agentmux/core/continuous-progress-scheduler'
import type { ScheduleParamsMap } from '@agentmux/core'
import type { AgentScheduleCheckInPolicy } from '@agentmux/core/schedule'

/** An unsent/frozen UI request, never a schedule or delivery fact. */
export type ScheduleRequest =
  | { action: 'create'; params: ScheduleParamsMap['schedule.create'] }
  | { action: 'pause' | 'resume' | 'cancel'; params: ScheduleParamsMap['schedule.pause'] }
export type ScheduleFormDraft = {
  open: boolean
  timing: 'calendar' | 'afterMs' | 'everyMs'
  kind: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly'
  timezone: string; time: string; date: string
  weekday: string; day: string; month: string; fold: 'earlier' | 'later'
  delay: string; delayUnit: 'seconds' | 'minutes' | 'hours'
  prompt: string; checkIn: boolean; checkInPolicy: AgentScheduleCheckInPolicy; context?: string
  target?: ContinuousProgressTarget | undefined
}
export type ScheduleDraft = { form?: ScheduleFormDraft; pending?: ScheduleRequest | undefined }
