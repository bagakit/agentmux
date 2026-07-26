import { useEffect } from 'react'
// 从 @agentmux/core/agent-status 这个 node-free 子路径导入（它只 import type ./types.js），而不是从
// 桶文件 '@agentmux/core'。桶文件会把 runtime-paths.js 一路拖进渲染器包，那里的 node:crypto
// createHash 在浏览器构建下解析成 __vite-browser-external，整个 renderer 构建直接失败。
// 同 api.ts 用 '@agentmux/core/launch-option' 的理由。
import {
  DECAYED_SEMANTIC_STATE,
  msUntilSemanticStatusStale,
  semanticStatusStale
} from '@agentmux/core/agent-status'
import type { SessionSnapshot } from '../../../shared/contracts'
import { useAppStore } from '../store'

// 让「永远转的圈」停下。
//
// 一个 Agent 的显示状态由一串 hook 事件驱动。那串流一旦断掉（进程被杀、hook 配错、daemon 重启），
// 最后落下的 `working` 会永远粘住——界面一直转着圈、声称 Agent 在干活，无限期。判定「这个 working
// 还算不算数」是纯函数（@agentmux/core 的 agent-status-freshness），落点是中性的「不知道」，绝不
// 伪造成 done/error。这里是产品侧的两件事：把已经陈旧的降下来（decayStaleAgentStatuses），以及算出
// 下一个该降的还有多久（nextAgentStatusDecayDelayMs）好排定时器。
//
// 写成纯函数 + 一个只管排点的 hook：本仓库组件测试用 renderToStaticMarkup，effect 不跑、定时器不响，
// 判定若埋在 effect 里就没有断言够得着。判定在这两个纯函数里被直接断言；hook 只把它们接到 store 与
// setTimeout，那一截由源码扫描证明确实接上了（见 agent-status-decay wiring 测试）。

/**
 * 陈旧的 `working` 归一到的显示态。
 *
 * core 的衰减落点是语义态 `unknown`（我们确实**不知道**它现在怎么样），renderer 一律把 `unknown` 归一
 * 为 `running`——进程还在、但此刻没有「在干活」的声明。这与 session-state 里 agent-status 的归一口径
 * （`unknown → running`）一致，不另起一套。
 */
const DECAYED_DISPLAY_STATE: SessionSnapshot['status']['state'] =
  DECAYED_SEMANTIC_STATE === 'unknown' ? 'running' : DECAYED_SEMANTIC_STATE

/**
 * 把所有已经陈旧的 `working` Agent 降为中性态。
 *
 * 只动 Agent、且只动那条 status 的 `state` 一个字段：`observedAt` 与 `source` 原样保留——它们记的是
 * 「最后一次真实观察发生在何时、由谁观察」，衰减不是一次新观察，而是对那次旧观察「已太陈旧、不再意味
 * 着在干活」的重新解读。保留 observedAt 还让降级幂等（降完是 `running`，不可再衰减），并让一条真正更新
 * 的证据（observedAt 更大）经既有 reducer 的 `>=` 守卫正常刷新、把活着的 Agent 重新点亮。
 *
 * 没有任何东西要降时返回**原数组引用**，让 store 与 effect 依赖不做无谓的重算。
 */
export function decayStaleAgentStatuses(
  sessions: readonly SessionSnapshot[],
  now: number
): SessionSnapshot[] {
  let changed = false
  const next = sessions.map((session) => {
    if (session.kind !== 'agent') return session
    if (!semanticStatusStale(session.status, now)) return session
    changed = true
    return { ...session, status: { ...session.status, state: DECAYED_DISPLAY_STATE } }
  })
  return changed ? next : (sessions as SessionSnapshot[])
}

/**
 * 距离下一个 `working` Agent 变陈旧还有多少毫秒；没有任何在途的会返回 `null`。
 *
 * client 的定时器据此排点：只挑「还没到点」的最近一个（`msUntil > 0`），到点唤醒一次去衰减，而不是
 * 每秒轮询每个 Agent。下限钳到 1ms，避免取整落在阈值线上时排出 0ms 的空转定时器。
 */
export function nextAgentStatusDecayDelayMs(
  sessions: readonly SessionSnapshot[],
  now: number
): number | null {
  const delays = sessions.flatMap((session) => {
    if (session.kind !== 'agent') return []
    const ms = msUntilSemanticStatusStale(session.status, now)
    return ms > 0 ? [ms] : []
  })
  if (delays.length === 0) return null
  return Math.max(1, Math.min(...delays))
}

/**
 * 把衰减判定接到 store 与一个到点唤醒的定时器。
 *
 * 每次 `sessions` 变化：先把此刻已陈旧的降下来（store action，什么都不该降时是无操作、不触发写入），
 * 再为下一个将陈旧的排一个满额延时的定时器。定时器一响就再降一次，`sessions` 随之变化、effect 重跑、
 * 排下一个点。一条新证据（新的 hook 事件）也会改 `sessions`、重跑本 effect，于是活着的 Agent 的定时器
 * 被不断重排、永远够不到衰减。
 */
export function useAgentStatusDecay(): void {
  const sessions = useAppStore((state) => state.sessions)
  const decay = useAppStore((state) => state.decayStaleAgentStatuses)
  useEffect(() => {
    decay(Date.now())
    const delay = nextAgentStatusDecayDelayMs(useAppStore.getState().sessions, Date.now())
    if (delay === null) return
    const timer = window.setTimeout(() => decay(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [sessions, decay])
}
