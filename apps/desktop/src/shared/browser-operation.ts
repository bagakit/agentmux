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

/**
 * phase 词汇的运行期清单，从类型派生不了所以只能列一次——**这就是那唯一的一次**。
 *
 * 协议那侧刻意把 phase 放宽成 `string`、把 steps 放宽成 `unknown[]`（`AgentMuxControlBrowserOperation`）：
 * core 不持有 Desktop 的步骤语义，也不该为了 Desktop 多一档 phase 就发一次协议版本。代价是收窄这件
 * 事必须由 Desktop 做，而收窄点只能有一个——两个收窄点就是两份词表，加一档 phase 时漏改一处，那一档
 * 会在其中一条路上静默退化成"未知"。
 */
export const BROWSER_OPERATION_PHASES: readonly BrowserOperationPhase[] = [
  'preparing', 'running', 'waiting', 'human', 'completed', 'failed', 'indeterminate', 'stopped'
]

/**
 * 把协议答出的操作事实收窄成 Desktop 的类型。
 *
 * **认不出来的 phase 不静默改成一个眼熟的档位**（那会把"我们不认识这个状态"伪装成"它完成了"或
 * "它在跑"）：`indeterminate` 就是为这种情形存在的档位——意思是"这件事做到哪儿我们不知道"，而调用方
 * 对它唯一正确的反应是别盲目重试。
 *
 * steps 同理不在这里逐条校验：它们只喂时间线渲染，而渲染对缺字段是安全的（每一处都是可选读）。
 * 在这里造一套第二份校验规则，等于把 Main 那份 normalizeDocument 抄一遍。
 */
export function narrowBrowserOperation(
  value: {
    id: string; browserId: string; operator: BrowserOperator; startedAt: number; finishedAt?: number
    phase: string; summary: string; url: string; steps: unknown[]; replayOf?: string; warning?: string
  }
): BrowserOperation {
  const phase = BROWSER_OPERATION_PHASES.includes(value.phase as BrowserOperationPhase)
    ? value.phase as BrowserOperationPhase
    : 'indeterminate'
  return { ...value, phase, steps: value.steps as BrowserOperationStep[] }
}

/** 同上，收窄回放计划。steps 的语义归 Desktop，协议只持有它的版本与 join identity。 */
export function narrowBrowserReplayPlan(
  value: { schema: 'agentmux.browser-replay.v1'; operationId: string; url: string; steps: unknown[] }
): BrowserReplayPlan {
  return { ...value, steps: value.steps as BrowserReplayStep[] }
}
