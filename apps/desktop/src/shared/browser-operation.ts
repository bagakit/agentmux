/** Browser activity belongs to Desktop Main, independently of Agent/PTY timelines. */
export type BrowserOperator = { id: string; name: string; providerId?: string }
export type BrowserOperationPhase = 'preparing' | 'running' | 'waiting' | 'human' | 'completed' | 'failed' | 'indeterminate' | 'stopped'
export type BrowserReplayTarget = { role: string; name: string; ordinal: number; count: number }
export type BrowserReplayStep = {
  method: string
  /** URL without credentials, query or fragment. */
  url: string
  target?: BrowserReplayTarget
  /** Only non-secret scalar arguments; text/code is never recorded. */
  args: unknown[]
  inputKey?: string
  blockedReason?: string
}
export type BrowserOperationStep = {
  sequence: number
  method: string
  label: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'completed' | 'failed' | 'stopped'
  ref?: string
  target?: BrowserReplayTarget
  /** Result shape/size only, never raw page data or script errors with echoed secrets. */
  summary?: string
  replay?: BrowserReplayStep
}
export type BrowserOperation = {
  id: string
  browserId: string
  operator: BrowserOperator
  startedAt: number
  finishedAt?: number
  phase: BrowserOperationPhase
  summary: string
  url: string
  steps: BrowserOperationStep[]
  replayOf?: string
  warning?: string
}
export type BrowserReplayPlan = {
  schema: 'agentmux.browser-replay.v1'
  operationId: string
  url: string
  steps: BrowserReplayStep[]
}
export type BrowserActivityState = {
  operation: BrowserOperation | null
  control: 'agent' | 'human'
  warning?: string
}
