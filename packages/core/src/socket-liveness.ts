/**
 * Whether a Unix socket has a live listener. Unknown includes permissions and timeouts,
 * and must remain distinct from dead. Control ownership uses this to avoid taking over
 * an endpoint whose existing owner could still be alive.
 */
import { createConnection } from 'node:net'

/** 探测的三种答案。`unknown` 是「探不准」，不是「死了」——两者的后果不可互换。 */
export type SocketLiveness = 'alive' | 'dead' | 'unknown'

/**
 * 探测的等待预算。
 *
 * 250ms 是原先两处各写一份的值，保持不变。超时**不是** `dead`：一个正在处理大请求的健康 daemon
 * 完全可能慢过这个预算，把超时当死等于用一次抖动换掉整个存储。
 */
export const SOCKET_LIVENESS_PROBE_MS = 250

/**
 * 一个 errno 意味着「确实没人监听」，还是「说不准」。
 *
 * 纯函数，与 socket、与计时器都无关——这样「哪些错误算死」这份清单本身可以被逐条断言，而不必
 * 制造出真的 `EACCES`/`ENOTSOCK` 才能测到它（那两个 errno 都是实测得来的真实取值，见模块头）。
 *
 * 超时也从这里过：预算用完由 `AbortSignal.timeout` 变成一次 `ABORT_ERR` 错误，于是它落在**同一个**
 * 判定点上，而不是另开一条 `setTimeout` 分支。这样做的理由是那条超时出口原先无人守，而它无人守的
 * 结构性原因正是它自成一路：`setTimeout(() => settle(...))` 与 connect 赛跑，在本机 300 次里只赢 5 次
 * （实测），于是「让超时必然发生」在测试里近乎做不到。收成一处之后，超时与其余未知错误共用一条被
 * 逐条断言的清单，且能用一个已过期的预算确定性地走到。
 */
export function socketLivenessFromErrorCode(code: string | undefined): 'dead' | 'unknown' {
  // 只有这两个 errno 能证明「没人监听」：文件不存在，或文件在但没有 accept 的一端。
  return code === 'ENOENT' || code === 'ECONNREFUSED' ? 'dead' : 'unknown'
}

/**
 * 探一次 socket，报出三态。**绝不抛异常**：探测失败本身是一种答案（`unknown`），不是异常路径。
 *
 * 等待预算以 `AbortSignal` 表达，而不是内部自己 `setTimeout`。三个理由，每一个都是实测出来的：
 *
 * 1. **超时因此与其余「探不准」共用同一个判定点**。原先它是独立的一条 `setTimeout(() => settle(...))`，
 *    于是那条出口自成一路、无人守——把它翻成「死了」，回收侧 20 条测试全绿（实测）。现在预算用完
 *    表现为一次 `ABORT_ERR`，走 {@link socketLivenessFromErrorCode}，与 `EACCES`/`ENOTSOCK` 同路。
 * 2. **它让那条出口可以被确定性地走到**。自己起计时器时超时要和 connect 赛跑：本机 300 次里计时器
 *    只赢 5 次，"让超时必然发生"在测试里近乎做不到。而传入一个**已过期**的 signal 是确定的
 *    （实测 50/50 全部 abort）。
 * 3. `AbortSignal.timeout` 的计时器是 unref 的（实测：5 秒预算下进程 34ms 内正常退出），探测提前
 *    结束后不会把事件循环按住。
 *
 * 只留这一个入参、不再另给一个 `budgetMs`：同一件事两种说法，日后必然有人只改其中一处。默认值
 * 每次调用现算，取 {@link SOCKET_LIVENESS_PROBE_MS}。
 */
export async function probeSocketLiveness(
  path: string,
  signal: AbortSignal = AbortSignal.timeout(SOCKET_LIVENESS_PROBE_MS)
): Promise<SocketLiveness> {
  return await new Promise<SocketLiveness>((resolve) => {
    const socket = createConnection({ path, signal })
    const settle = (liveness: SocketLiveness): void => {
      socket.destroy()
      resolve(liveness)
    }
    socket.once('connect', () => settle('alive'))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      settle(socketLivenessFromErrorCode(error.code))
    })
  })
}
