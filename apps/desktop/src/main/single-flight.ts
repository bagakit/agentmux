/**
 * 单飞（single-flight）：把一个异步任务包一层，保证同一时刻至多有一次在途。任务在途时，后来的调用
 * 不再启动新的一次，而是复用同一个 Promise；上一次结算后，下一次调用才会真正重新启动。
 *
 * 为什么需要：主进程建窗有三个触发点——whenReady 首次建窗、second-instance（用户又双击图标）、
 * activate（macOS 全关窗后点 dock）。它们各自异步，且都在「窗口还没构造出来」的空档里判断「当前没有
 * 窗口」。若不去重，whenReady 的建窗还在 await（读几何配置）时 second-instance 触发，会看到 0 个窗口
 * 从而并发建出第二个——单进程开两个窗口的 UX 回归。单飞让这三处共享同一次在途建窗。
 *
 * 这是纯粹的并发去重原语：不碰 Electron，可直接用 deferred 任务断言「在途只跑一次、结算后能再跑」。
 */
export function singleFlight<A extends unknown[]>(
  task: (...args: A) => Promise<void>
): (...args: A) => Promise<void> {
  let inFlight: Promise<void> | null = null
  return (...args: A): Promise<void> => {
    // 已有在途：复用它，绝不并发启动第二次。首个调用的入参胜出，后来者的入参被忽略——这正是我们要的，
    // 因为它们本就想要「确保有一次在跑」，而不是「各跑一次」。
    if (inFlight) return inFlight
    inFlight = task(...args).finally(() => {
      inFlight = null
    })
    return inFlight
  }
}
