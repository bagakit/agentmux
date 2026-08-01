/**
 * 一个 Run 事件流「怎么结束的」的分类——纯函数，因为要害在**判定**而非在 pump 的异步壳里。
 *
 * pump 的 `for await (event of attachment.events())` 有三种收尾，含义天差地别：
 *
 * 1. **我们自己 detach 了**（`stillOwned === false`）：map 里的 attachment 已被换/删，这次收尾是
 *    我们主动的，什么都不该做。
 * 2. **抛错**（`threw === true`）：wire 断了。对单 daemon 而言，一个 attachment 的传输失败就是我们
 *    与 daemon 的实时通道断了——判为 connection-lost，让重连去问 daemon 真相，而不是在此刻瞎猜这个
 *    run 死没死。
 * 3. **干净结束**（`threw === false`）：只有两种可能。要么这条流里**发过**终结事件（exited/interrupted，
 *    SDK 的 `events()` 在 yield 终结事件后即 return）——那 run 的退出已经如实发出，收尾正常，无需再做；
 *    要么**没发过**终结事件（daemon 优雅关流却没告诉我们 run 的下场）——这同样是「实时通道没了」，
 *    判为 connection-lost。**这一支正是历史缺陷**：旧 pump 在这里只删 attachment、不发任何东西，于是
 *    run 永远停在最后状态。
 *
 * 关键不变量：干净结束**且发过终结事件**必须判 `run-exited`（无动作）。若把它也判成 connection-lost，
 * 每一次正常退出都会触发一次重连风暴——这就是为什么分类必须显式区分「发过终结事件」这一路。
 */
export type CtxmuxStreamEndKind = 'detached' | 'run-exited' | 'connection-lost'

export type CtxmuxStreamEndObservation = {
  /** for-await 是否以抛错收尾（wire 传输失败）。 */
  threw: boolean
  /** 这条流在收尾前是否发过终结事件（exited/interrupted）。 */
  sawTerminalEvent: boolean
  /** 收尾时 attachment map 是否仍是我们这一次（token 未被换/删）。false = 我们自己 detach 的。 */
  stillOwned: boolean
}

export function classifyStreamEnd(observation: CtxmuxStreamEndObservation): CtxmuxStreamEndKind {
  if (!observation.stillOwned) return 'detached'
  if (observation.threw) return 'connection-lost'
  // 干净结束：发过终结事件 = 正常退出（已发出，无动作）；没发过 = daemon 关流没交代下场 = 连接丢失。
  return observation.sawTerminalEvent ? 'run-exited' : 'connection-lost'
}
