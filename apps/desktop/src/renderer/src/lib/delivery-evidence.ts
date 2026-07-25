import type { AgentDeliveryState } from '@agentmux/core'
import type { AttentionCategory } from './attention-event'

/**
 * 一条投递此刻能诚实地说什么。
 *
 * 证据等级是硬边界：启动投递或 PTY write 最多证明**送到了**；`accepted` 与 `replied`
 * 需要 Hook、ACP、Provider 原生回执，或受管 Agent 显式调用 Core。把 `delivered` 写成
 * "已回复"，用户会以为对方看过并回应了——而实际上可能连读都没读。
 *
 * 注意力归类复用窗口既有的那一套，不发明第三种说法。
 */
export type DeliveryEvidence = {
  readonly label: string
  /** 是否已经落定：还在等结果的不该被读成"完了"。 */
  readonly settled: boolean
  readonly attention: AttentionCategory | null
}

const EVIDENCE: Readonly<Record<AgentDeliveryState, DeliveryEvidence>> = {
  queued: { label: 'Queued', settled: false, attention: null },
  // 只说送达。对方是否读到、是否照做，这一档给不出任何证据。
  delivered: { label: 'Delivered', settled: false, attention: null },
  accepted: { label: 'Accepted', settled: false, attention: null },
  replied: { label: 'Replied', settled: true, attention: 'done' },
  failed: { label: 'Failed', settled: true, attention: 'error' },
  // 没等到 ≠ 不等了：前者可能值得重试，后者是明确的放弃。
  'timed-out': { label: 'Timed out', settled: true, attention: 'error' },
  cancelled: { label: 'Cancelled', settled: true, attention: null }
}

export function describeDeliveryEvidence(state: AgentDeliveryState): DeliveryEvidence {
  return EVIDENCE[state]
}
