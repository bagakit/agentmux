import type { ContinuousProgressLoop, ContinuousProgressTarget, ContinuousProgressTaskSource } from '@agentmux/core'
import type { AgentSessionControl } from './contracts'

export type ContinuousProgressInputRequest = {
  requestId: string
  operation: 'continuous-progress.observeInput'
  control: AgentSessionControl
}
export type ContinuousProgressInputResult = {
  operation: 'continuous-progress.observeInput'
  control: AgentSessionControl
  occupied: boolean
}
export type ContinuousProgressApi = {
  goals(goalId: string): Promise<ContinuousProgressLoop[]>
  prepareGoal(input: ContinuousProgressTarget & { goalId: string; alignmentRevision: number; intervalMs: number; operationId: string; prompt: string }, caller?: import('@agentmux/core').AgentMuxControlCaller): Promise<ContinuousProgressLoop>
  initialGoalInput(target: ContinuousProgressTarget, loopId: string, operationId: string, phase: 'begin' | 'confirm'): Promise<ContinuousProgressLoop>
  goalAction(goalId: string, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check', revision: number, operationId: string, caller?: import('@agentmux/core').AgentMuxControlCaller): Promise<ContinuousProgressLoop>
  list(target: ContinuousProgressTarget): Promise<ContinuousProgressLoop[]>
  create(target: ContinuousProgressTarget, intervalMs: number, prompt: string, taskSource?: ContinuousProgressTaskSource): Promise<ContinuousProgressLoop>
  action(target: ContinuousProgressTarget, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check'): Promise<ContinuousProgressLoop>
  pauseForInput(control: AgentSessionControl): Promise<void>
  onChanged(listener: (loop: ContinuousProgressLoop) => void): () => void
}
