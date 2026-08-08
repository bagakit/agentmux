/**
 * 原生 Browser 视图的几何归一化：一次判定，两层共用。
 *
 * 为什么必须是共用的一份：这条几何要跨 IPC 走两遍同样的判定。renderer 观察 DOM 求出矩形、归一化、
 * 送出；main 收到之后**又**归一化一遍才交给 Electron。两侧原来各写一份逐字节相同的
 * `Number.isFinite` 拒绝 + `Math.max/Math.round` 夹取，互相之间没有任何编译期联系——取值拷贝，
 * `tsc` 看不见。于是改一侧的策略对另一侧完全不可见，而它们**已经**在失败处理上分岔了：renderer 让
 * 非法矩形变成"隐藏"，main 对同样的输入抛错。分岔本身是对的（见下），复制不是。
 *
 * 为什么两侧的失败动作可以不同、而判定必须相同：**判定**是"这个矩形能不能交给原生视图"，那是同一个
 * 问题，只该有一个答案；**动作**是"判定为否之后这一层该做什么"，两层的正确答案本来就不一样——
 * renderer 侧非法矩形几乎总是"这一格现在不该显示"（Region 被折叠、tab 切走、组件卸载中量到 0×0），
 * 隐藏是正常路径；main 侧收到非法矩形意味着上游算错了或 IPC 被绕过，静默隐藏会把 bug 埋掉，所以抛。
 * 所以这个函数返回 `null` 表示"不可用"，把"拿 null 怎么办"留给调用方，而不是自己决定。
 *
 * 为什么没有 `Math.max(1, …)` 那道宽高地板：它是**死代码**。上面那条拒绝已经保证到这里的
 * `width >= 1` 且有限，而 `w >= 1` 时 `Math.round(w) >= 1` 恒成立，所以那道 `max` 一次都改不了结果。
 * 两侧原来各带一份，Reviewer 的变异（地板 `1`→`7`）在两侧都全绿存活——不是因为判据弱，是因为**没有
 * 输入能走到那里**。给不可达的分支补测试等于把死代码钉死，所以这里删掉它，只留真正承重的那道：
 * x/y 的 `Math.max(0, …)`。x/y **没有**下界拒绝（负坐标是合法输入，比如 Region 滚出视口上方），
 * `-0.6` 会 `Math.round` 成 `-1`，必须夹回 0——这一条是可观测的，下面的测试钉的就是它。
 */

import type { BrowserBounds } from './contracts.js'

/**
 * 把一个观察到的矩形归一成原生视图能用的整数像素，不可用时返回 `null`。
 *
 * `null` 的两种来源合并成一个出口：调用方传进来的 `null`（本来就没有矩形），以及矩形存在但不可用
 * （有非有限数，或宽高不足 1 物理像素）。对两个调用方来说这两种情况的处置完全相同，分开返回只会让
 * 每个调用方各写一次同样的合并。
 */
export function normalizeBrowserBounds(bounds: BrowserBounds | null): BrowserBounds | null {
  if (!bounds) return null
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (values.some((value) => !Number.isFinite(value)) || bounds.width < 1 || bounds.height < 1) {
    return null
  }
  return {
    // 只有 x/y 需要夹：负坐标是合法输入（Region 滚出视口），而原生视图不接受负原点。
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    // 宽高不夹：上面的拒绝已保证 >= 1，取整不会把它带到 1 以下（见模块头）。
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
}
