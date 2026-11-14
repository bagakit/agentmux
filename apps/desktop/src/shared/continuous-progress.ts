import type { ContinuousProgressLoop, ContinuousProgressTarget } from '@agentmux/core'
import type { AgentSessionControl } from './contracts'

export type ProgressUpdateRequest = import('@agentmux/core').AgentProgressParams['agent.progress.update']
export type ProgressCreateRequest = import('@agentmux/core').AgentProgressParams['agent.progress.create']
export type ProgressActionRequest = import('@agentmux/core').AgentProgressParams['agent.progress.action']
export type ProgressRequest = ({ kind: 'create'; input: ProgressCreateRequest } | { kind: 'action'; input: ProgressActionRequest }) & { dispatch?: 'prepared' | 'started' }
export type OriginalContinuousProgressControl = {
  identity: string; target: ContinuousProgressTarget; label?: string; executionState: 'unknown'
  port: Pick<ContinuousProgressApi, 'list' | 'create' | 'update' | 'action'>
  readInputEpoch(): Promise<string | null>
}
export type ProgressUpdateResult = { ok: true; loop: ContinuousProgressLoop } | { ok: false; error: { code?: string; message: string } }

export type ContinuousProgressApi = {
  goals(goalId: string): Promise<ContinuousProgressLoop[]>
  goalAction(goalId: string, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check', revision: number, operationId: string, caller?: import('@agentmux/core').AgentMuxControlCaller): Promise<ContinuousProgressLoop>
  list(target: ContinuousProgressTarget, operationId?: string): Promise<ContinuousProgressLoop[]>
  create(input: ProgressCreateRequest): Promise<ContinuousProgressLoop>
  update(input: ProgressUpdateRequest): Promise<ContinuousProgressLoop>
  action(target: ContinuousProgressTarget, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check', expectedLoop: ContinuousProgressLoop, operationId: string): Promise<ContinuousProgressLoop>
  pauseForInput(control: AgentSessionControl): Promise<void>
}
