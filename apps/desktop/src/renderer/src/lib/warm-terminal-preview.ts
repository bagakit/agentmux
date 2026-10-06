import type { SessionSnapshot, TerminalLaunchInput } from '../../../shared/contracts'
import type { SessionLaunchFailure } from '../../../shared/session-launch-result'

/** The original request survives a lost receipt and a transfer of its preview owner. */
export type WarmTerminalCreation = {
  request: TerminalLaunchInput
  inFlight: boolean
  issue?: SessionLaunchFailure
  hostRecoveryAttempted?: boolean
}

/** Each visible Launcher owns its preview; only released candidates may be reused. */
export function warmTerminalForLauncher<T extends {
  ownerLauncherId: string | null
  claimToken?: object
  explicitOpening?: true
  creation?: WarmTerminalCreation
  session?: SessionSnapshot | null
}>(candidates: readonly T[] | undefined, launcherId: string): T | null {
  return candidates?.find(candidate => candidate.ownerLauncherId === launcherId) ??
    candidates?.find(candidate => candidate.ownerLauncherId === null && !candidate.claimToken && (!candidate.explicitOpening || candidate.session != null) && !candidate.creation?.issue) ?? null
}

export type WarmTerminalPreview = {
  /** 挂 live preview 用的 session；`null` 表示这个 launcher 不显示预览（显示冷卡片）。 */
  session: SessionSnapshot | null
  /** 槽属于这个 workspace 但 shell 还没起好——显示「正在预热」而不是冷卡片。 */
  pending: boolean
  /** This Launcher has a candidate for the exact target, including an unconfirmed request. */
  slotHeld: boolean
  state: 'idle' | 'preparing' | 'ready' | 'unconfirmed'
  creation?: WarmTerminalCreation
}

/**
 * 这个 launcher 挂载点的归属身份。
 *
 * 归属键必须**永远在场**，且同胞之间互不相同。`regionId` 只满足后者：空分组占位没有 region，而那
 * 恰是新建 workspace 的第一眼（最主要那条路径）——拿可缺席的字段当归属键，会把那条路径永久降级成
 * 冷卡片。所以缺 region 时退到 `tabGroupId`：一个 group 在同一时刻最多只有一个空占位 launcher，
 * 所以它在那条路径上同样唯一。
 *
 * Region 和 Group 的实体 ID 都是 opaque。这里给归属键各自加类型前缀，区分两种挂载点。
 */
export function warmLauncherId(input: { tabGroupId: string; regionId: string | undefined }): string {
  return input.regionId === undefined ? `group:${input.tabGroupId}` : `region:${input.regionId}`
}

export function warmTerminalPreview(input: {
  /** Candidate selected from this exact execution target. */
  warmTerminal: { key: string; ownerLauncherId: string | null; session: SessionSnapshot | null; creation?: WarmTerminalCreation } | null
  /** 这个 launcher 所属 workspace 的 host + cwd 键；无 workspace 时为 `null`。 */
  warmKey: string | null
  /** 这个 launcher 的归属身份，来自 {@link warmLauncherId}。 */
  launcherId: string
}): WarmTerminalPreview {
  const { warmTerminal, warmKey, launcherId } = input
  // key 不同就是另一个 host / 另一个 cwd 的 shell，与这个 launcher 无关。`warmKey` 为 null（没有
  // workspace）时也走这条：不能让「两个都没有键」凑成相等。
  if (!warmTerminal || warmKey === null || warmTerminal.key !== warmKey) {
    return { session: null, pending: false, slotHeld: false, state: 'idle' }
  }
  // Keep this candidate's original request visible while its creation is pending or unknown.
  if (!warmTerminal.session) {
    const unconfirmed = Boolean(warmTerminal.creation?.issue && !warmTerminal.creation.inFlight)
    return { session: null, pending: !unconfirmed, slotHeld: true,
      state: unconfirmed ? 'unconfirmed' : 'preparing', ...(warmTerminal.creation ? { creation: warmTerminal.creation } : {}) }
  }
  // A released candidate becomes visible only after this Launcher acquires it.
  if (warmTerminal.ownerLauncherId !== launcherId) {
    return { session: null, pending: false, slotHeld: false, state: 'idle' }
  }
  return { session: warmTerminal.session, pending: false, slotHeld: true, state: 'ready' }
}
