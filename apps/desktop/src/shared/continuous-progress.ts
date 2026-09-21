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
  list(target: ContinuousProgressTarget): Promise<ContinuousProgressLoop[]>
  create(target: ContinuousProgressTarget, intervalMs: number, prompt: string, taskSource?: ContinuousProgressTaskSource): Promise<ContinuousProgressLoop>
  action(target: ContinuousProgressTarget, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check'): Promise<ContinuousProgressLoop>
  pauseForInput(control: AgentSessionControl): Promise<void>
  onChanged(listener: (loop: ContinuousProgressLoop) => void): () => void
}
