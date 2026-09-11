/**
 * 「session 关不掉」的那条判据：等 Runtime 收尾**必须有上限**。
 *
 * 用户原话：「经常出现 session 关不掉」。
 *
 * 缺陷形态：关闭一条 Session 的整条链路上没有任何一处客户端超时——preload 的
 * `ipcRenderer.invoke` 不带超时，主进程的 handler 不带超时，ctxmux SDK 的
 * `attachRecoverableStop` 阻塞在 `wire.receive()` 上，而后者只在"来了一行"或"socket 报错"时
 * 才 resolve。daemon 收下了停止帧却没回执（忙、PTY 没排空、socket 卡住），这个 await 就**永远**
 * 不结束。
 *
 * 更糟的是第二层：关闭时会先占一把重入租约，在 `finally` 里释放。await 永不结束 → `finally`
 * 永不执行 → 租约永久扣住 → 之后每一次点关闭都在入口被静默挡掉（`return false`）。用户看到的
 * 是「点了没反应，而且现在这个 Tab 连反应都没有了」——连重试这条路也堵死了，直到重启应用。
 *
 * 这是原则 11 的第 2 类被写成了第 1 类：**Agent 好好活着，是我们的握手没走通**。判据是
 * 「Agent 还能干活吗」而不是「我们的检查过了吗」，所以超时不能静默放行，也不能装作成功——
 * 它要变成一个**如实的失败**，让既有的收尾逻辑跑起来：保留投影、释放租约、把话说给用户听。
 *
 * 为什么把超时放在这一层而不是各个调用点：renderer 里有十二处 `api.sessions.stop`，逐个包一层
 * 会漂（下一处新增的不会带上），而且十二份超时就是十二个事实源。这里是它们唯一的共同出口。
 */

/**
 * 等一次停止收尾的上限。
 *
 * 取 60 秒，与 Core 控制通道给 `stop` 的长预算同档（`AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS`）：
 * 那张表把 `stop` 定为 long 的理由正是"要等进程真的收尾"，这里等的是同一件事。不重新取一个数，
 * 也不从那边 import——preload 跑在隔离的 bridge 上下文里，跨包值导入会把 Core 整个拉进这一层
 * （记忆 renderer-value-import-of-core-barrel-breaks-packaging）。同档的理由写在这里，值就地定义。
 *
 * 为什么不更短：一个正在写盘或正在排空 PTY 的 Agent 收尾到十几秒是正常的，掐早了会把**成功的
 * 关闭**报成失败，而那会让用户以为 Agent 出了事。为什么不更长：超过一分钟还没回音，继续等下去
 * 对用户没有任何新信息，只是把"没反应"拖得更久。
 */
export const SESSION_STOP_TIMEOUT_MS = 60_000

/** 超时抛出的错误带上这个 code，好让上层把"我们没等到"与"Runtime 说它失败了"分开讲。 */
export const SESSION_STOP_TIMEOUT_CODE = 'SESSION_STOP_TIMEOUT'

export function sessionStopTimeoutError(timeoutMs: number): Error & { code: string } {
  return Object.assign(
    new Error(
      `Closing this session had no response from the Runtime within ${Math.round(timeoutMs / 1000)}s. ` +
      'Your Agent is unaffected and may still be running — this step of our handshake did not complete. ' +
      'The View was kept so you can close it again.'
    ),
    { code: SESSION_STOP_TIMEOUT_CODE }
  )
}

/**
 * 给一个等待加上限。到点则**拒绝**，不是 resolve。
 *
 * 拒绝而不是 resolve 是这条修复的要害：resolve 会让上层把它记成"关成功了"，于是 Tab 消失而
 * Session 可能还活着——那是在拿用户的 Agent 撒谎。拒绝会走既有的失败路径：保留投影、报告、
 * 释放租约，用户可以再点一次。
 *
 * 到点之后不去取消底层那个 Promise：IPC 那一侧没有取消语义，而且真正的停止可能只是慢了一拍，
 * 它仍会在 daemon 上生效。我们放弃的只是**等待**，不是那个动作。晚到的结果由 Runtime 的
 * `run-removed` 事件收口，与这里无关。
 */
export async function withStopTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number = SESSION_STOP_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(sessionStopTimeoutError(timeoutMs)), timeoutMs)
      })
    ])
  } finally {
    // 正常返回时必须清掉定时器：留着它会把这个进程多吊住整整一分钟（Node 的 timer 保持事件循环
    // 存活），而且在测试里会表现成"跑完了却不退出"。
    clearTimeout(timer)
  }
}
