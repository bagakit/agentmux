import type { ContinuousProgressLoop, ContinuousProgressTarget, ContinuousProgressTaskSource } from '@agentmux/core'
import type { AgentSessionControl } from './contracts'

export type ContinuousProgressApi = {
  goals(goalId: string): Promise<ContinuousProgressLoop[]>
  goalAction(goalId: string, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check', revision: number, operationId: string, caller?: import('@agentmux/core').AgentMuxControlCaller): Promise<ContinuousProgressLoop>
  list(target: ContinuousProgressTarget): Promise<ContinuousProgressLoop[]>
  create(target: ContinuousProgressTarget, intervalMs: number, prompt: string, taskSource?: ContinuousProgressTaskSource): Promise<ContinuousProgressLoop>
  action(target: ContinuousProgressTarget, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check', expectedLoop: ContinuousProgressLoop, operationId: string): Promise<ContinuousProgressLoop>
  pauseForInput(control: AgentSessionControl): Promise<void>
}
