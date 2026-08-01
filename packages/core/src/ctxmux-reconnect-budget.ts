/**
 * 跨成功幸存的重连预算——挡「半死 daemon」，即 `ctxmux-reconnect.ts` 那道界**挡不住**的那一族。
 *
 * 两道界守的是两件不同的事，别混：
 * - `nextReconnectStep`（同文件夹另一模块）守**一轮之内**：连不上就退避、6 次放弃。它对「连上了」
 *   一无所知，因为一旦连上，那一轮就正常结束了。
 * - 本模块守**跨轮**：daemon 半死不活——接受连接、握手过、然后立刻又把流关掉。每一轮重连都
 *   「成功」，于是上面那道界每次都被重置，用户看到的是无穷次「失联→重连中→恢复→失联」，
 *   一屏 Agent 反复变灰。单轮有界 ≠ 整体有界。
 *
 * ## 判据是次数，不是墙钟
 *
 * 病理本身是**抖动次数**，不是「坏了多久」。用墙钟当主轴会在两头都错：
 *
 * - **误杀慢而健康的恢复。** 一轮重连的真实墙钟远不止退避那 31.5s：每次 attempt 里 `open()` 还要
 *   等 daemon ready（`ctxmux-run-adapter.ts` 的 `DAEMON_READY_TIMEOUT_MS`，5s）、再给每个 Session
 *   跑终端握手（`client.ts` 的 `TERMINAL_HANDSHAKE_TIMEOUT_MS`，10s，虽已并行但仍是一整个窗口）。
 *   一台负载高的机器上，一次**最终成功**的重连轻松超过一分钟。任何「N 秒还没好就 unrecoverable」
 *   的天花板都会把它误判成绝症。
 * - **笔记本合盖直接爆掉。** 合盖两小时再打开，`Date.now()` 跳了两小时。醒来后第一次掉线要是拿
 *   「首次失联至今」去比，任何天花板都当场超限——用户开盖看到的第一件事就是「彻底连不上，请手动
 *   处理」，而真相是它一次都还没重试过。语义状态的新鲜度衰减（`agent-status-freshness.ts`）能吞下
 *   这种跳变是因为它的终局是 `unknown`、会自愈；这里的终局**阻断用户**，不能自愈，所以不能这么建模。
 *
 * 所以主轴是 `flapCount`：「掉线—重连成功」这个循环重复了几次。次数不受时钟跳变影响，也不惩罚
 * 一次慢而成功的恢复。
 *
 * ## 缓刑（probation）：连接连续健康到期才清账
 *
 * 计数不能只增不减，否则一台开了一个月的机器迟早会因为一月一次的正常抖动攒满配额。清账的判据必须
 * 是**连接连续健康了一段时间**，而不是「刚刚 restored」——restored 恰恰是抖动那一刻发生的事，拿它
 * 清账等于永远清得掉，这道界就成了死代码。缓刑期必须 ≥ 一整轮内层重连窗口（31.5s 退避 + ready +
 * 握手），否则「一轮慢而成功的重连」会被误当成缓刑期满。
 */

/**
 * 允许的抖动次数。第 {@link RECONNECT_FLAP_BUDGET} 次「掉线又重连成功」之后再掉线，就不再重连了。
 *
 * 3 是「偶发抖动」与「半死」之间的分界：网络切换、daemon 重启、睡眠唤醒各自会造成一到两次真实的
 * 抖动，都该被容忍并自愈；连着三次以上通常意味着对面处在一个不会自己好的状态。
 *
 * 改成 Infinity/极大值 = 恢复无界抖动，守卫据此变红。
 */
export const RECONNECT_FLAP_BUDGET = 3

/**
 * 缓刑期：连接连续健康这么久，抖动账就清零。
 *
 * 下界由内层那一轮的最坏墙钟决定，三项相加：退避梯合计 31.5s（见 `ctxmux-reconnect.ts`）
 * + daemon ready 5s + 终端握手 10s ≈ 46.5s。取 90s 留出一倍余量——短于一轮窗口的缓刑期会把
 * 「一次慢但成功的重连」误判成「已经稳了」，那正是本模块要挡的那族误判的镜像。
 *
 * 与 `control-host.ts` 的 `LONG_REQUEST_TIMEOUT_MS`（60s，长控制请求的上限）对账：90s > 60s，
 * 所以缓刑判定不会在一个仍在途的长请求中途就宣布「稳了」。
 */
export const RECONNECT_PROBATION_MS = 90_000

/** 跨成功幸存的抖动账。由调用方持有；本模块是纯函数，不碰时钟、不碰状态。 */
export type ReconnectFlapLedger = {
  /** 已经发生过几次「掉线 → 重连成功」。缓刑期满清零。 */
  flapCount: number
}

export type FlapVerdict =
  /** 还在预算内：正常起一轮有界重连。 */
  | { kind: 'reconnect'; flapCount: number }
  /**
   * 预算用尽：**不要**再起重连循环，直接终局。
   *
   * 这个判决必须在「发 lost、把整屏 Agent 置灰」**之前**取得（见 client 的 handleConnectionLost）：
   * 判完了再走老路，用户仍要看一次全体变灰、再白等一整轮 ≥31.5s 才得到终局，抖动照旧。
   */
  | { kind: 'give-up'; flapCount: number }

/**
 * 这次掉线该重连还是该放弃。
 *
 * `ledger` 是掉线**之前**的账（本次掉线还没记进去）。返回的 `flapCount` 是记账后的值，调用方
 * 直接存回去即可——把「读账、判决、写账」收成一次调用，是因为分开算两次必然漂移。
 */
export function judgeReconnectFlap(ledger: ReconnectFlapLedger): FlapVerdict {
  const flapCount = ledger.flapCount + 1
  if (ledger.flapCount >= RECONNECT_FLAP_BUDGET) {
    return { kind: 'give-up', flapCount }
  }
  return { kind: 'reconnect', flapCount }
}

/**
 * 连接连续健康到 `now` 为止是否够久，够久就该清账。
 *
 * `healthySince` 是最近一次「连接恢复健康」的时刻（restored，或首次 connect 成功）。
 *
 * 时钟跳变在这里是**安全**的方向：合盖两小时再开，`now - healthySince` 变得巨大 → 判定清账 →
 * 抖动预算恢复满额。那正是我们想要的——醒来后的第一次掉线应该得到完整的重连机会。反过来（把
 * 跳变算成「坏了很久」）才会阻断用户，那种建模本模块刻意不采用。
 */
export function shouldClearFlapLedger(healthySince: number, now: number): boolean {
  return now - healthySince >= RECONNECT_PROBATION_MS
}
