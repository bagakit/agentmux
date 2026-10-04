import type { SessionSnapshot } from '../../../shared/contracts'

/**
 * 热终端槽在**这一个 launcher** 眼里是什么样。
 *
 * 槽是全局单个的（`store.warmTerminal`）：一台机器上不该为没人认领的 shell 攒 N 个 PTY。但 launcher
 * 是**每个挂载点一个**——分屏能在同一个 Tab 里开出好几个，空分组占位又能在每个 group 里各有一个，
 * 它们的 `warmKey` 逐字相同（同 host 同 cwd）。于是「这个槽是不是我的」不能只判 key。
 *
 * 只判 key 时每个 launcher 都会把一个 `TerminalView` 挂到同一个 run 上。attach 那一侧**不会报错**：
 * 同一个 session 快照算出同一个 control identity，第二次 attach 走 `readRunReplay` 而不是「owner
 * 已存在」那条抛出。所以没有任何响亮信号——但两个 view 各有自己的 FitAddon 与 ResizeObserver，
 * 尺寸不同就对着同一个 PTY 轮流 resize，网格来回跳，两边的 xterm 都在错的行列上重排。
 *
 * 所以归属由**槽自己**记（`ownerLauncherId`），而不是各个 launcher 各自推断。这个函数是那条判定在
 * 整个 renderer 里的唯一落点：三个取值必须来自同一次判断，分开算必然漂移——症状是「转圈提示归 A、
 * 终端画面归 B」这种自相矛盾的画面。
 */
export type WarmTerminalPreview = {
  /** 挂 live preview 用的 session；`null` 表示这个 launcher 不显示预览（显示冷卡片）。 */
  session: SessionSnapshot | null
  /** 槽属于这个 workspace 但 shell 还没起好——显示「正在预热」而不是冷卡片。 */
  pending: boolean
  /**
   * 这个 workspace 的槽**在不在**，与归属无关。
   *
   * 预热 effect 的依赖只能用这个量，**不能**用带归属的 `session` / `pending`：归属会在同胞之间转移，
   * 若依赖跟着归属翻动，失去归属的那个 launcher 就会立刻重新预热去夺回来，对方随即再夺回——两个
   * 同时在场的 launcher 之间无限 ping-pong 重渲染。与归属无关的「槽在不在」不会震荡，同时仍然能
   * 表达 promote 之后槽被清空（此时该重新预热一个）。
   */
  slotHeld: boolean
}

/**
 * 这个 launcher 挂载点的归属身份。
 *
 * 归属键必须**永远在场**，且同胞之间互不相同。`regionId` 只满足后者：空分组占位没有 region，而那
 * 恰是新建 workspace 的第一眼（最主要那条路径）——拿可缺席的字段当归属键，会把那条路径永久降级成
 * 冷卡片。所以缺 region 时退到 `tabGroupId`：一个 group 在同一时刻最多只有一个空占位 launcher，
 * 所以它在那条路径上同样唯一。
 *
 * 两个命名空间不会撞：region id 是 `region:...`（见 `workbench-tabs.ts` 的 `initialWorkbenchRegionId`
 * 与 store 的 uuid 版），group id 由调用方给且不带这个前缀；这里再各自加前缀，让「同一个字符串
 * 既是 region 又是 group」不可能发生。
 */
export function warmLauncherId(input: { tabGroupId: string; regionId: string | undefined }): string {
  return input.regionId === undefined ? `group:${input.tabGroupId}` : `region:${input.regionId}`
}

export function warmTerminalPreview(input: {
  /** 全局槽。`null` 表示当前没有热 shell。 */
  warmTerminal: { key: string; ownerLauncherId: string; session: SessionSnapshot | null } | null
  /** 这个 launcher 所属 workspace 的 host + cwd 键；无 workspace 时为 `null`。 */
  warmKey: string | null
  /** 这个 launcher 的归属身份，来自 {@link warmLauncherId}。 */
  launcherId: string
}): WarmTerminalPreview {
  const { warmTerminal, warmKey, launcherId } = input
  // key 不同就是另一个 host / 另一个 cwd 的 shell，与这个 launcher 无关。`warmKey` 为 null（没有
  // workspace）时也走这条：不能让「两个都没有键」凑成相等。
  if (!warmTerminal || warmKey === null || warmTerminal.key !== warmKey) {
    return { session: null, pending: false, slotHeld: false }
  }
  // 槽是这个 workspace 的，shell 还在起——不论归属给谁，这个 launcher 都该显示「正在预热」而不是
  // 冷卡片：点下去 promote 会等 `ready`，用户看到的不该是「没有热 shell」。
  if (!warmTerminal.session) return { session: null, pending: true, slotHeld: true }
  // shell 起好了，但只有 owner 渲染 live view；同胞显示冷卡片。点击认领照旧可用（promote 只按 key
  // 取槽，不看归属）。宁可少一个预览，也不要两个抢同一个 PTY 的预览。
  if (warmTerminal.ownerLauncherId !== launcherId) {
    return { session: null, pending: false, slotHeld: true }
  }
  return { session: warmTerminal.session, pending: false, slotHeld: true }
}
