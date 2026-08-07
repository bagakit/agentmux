/**
 * 「这次 attach/replay 请求的字节里，真的有拿不到的吗」——纯函数，因为要害在**判定**而非在
 * adapter 的三个 attach 壳里（attach / replay / observeOutput 三处此前各抄了一份同样的三元）。
 *
 * 判据不能只看 `replay.truncated`。那个字段是 **per-Run 的粘滞标志，不是这次请求的答案**：
 * daemon 逐出 chunk 时执行的是
 * `UPDATE runs SET replay_bytes = ..., replay_truncated = 1, durable_first_available_byte = ...`，
 * 而整个 daemon 二进制里**不存在** `replay_truncated = 0`——它一旦置 1 就再不清零。SDK 也不算它，
 * `receiveReplay` 原样透传 daemon 的 header（`{ ...header.replay, chunks }`）。所以它的含义只是
 * 「这个 Run 的历史在某个时刻被修过」，而不是「你这次要的字节缺了」。
 *
 * 「你这次要的字节缺没缺」是可以精确回答的，两个数就在手上，且 SDK 的收流循环把语义钉死了：
 * 它从 `max(afterByte, first_available_byte)` 开始收，并要求一路连续到 `latest_output_bytes`
 * （不连续就抛 "ordered replay output"）。于是：
 *
 * - `requestedAfterByte >= firstAvailableByte` ⇒ 收到的字节正好从你要的位置开始、连续到最新。
 *   **一个都没少。** 这一路必须判 `null`。
 * - `requestedAfterByte < firstAvailableByte` ⇒ `[requestedAfterByte, firstAvailableByte)` 这段
 *   真的被逐出了，永远拿不回来。这一路才是 gap。
 *
 * 把第一路也判成 gap 的后果不是「多一句提示」，三个消费者会同时做错事（这就是 #548）：
 *
 * 1. renderer 永远显示「Earlier scrollback is unavailable」——渲染层一律从 byte 0 attach，
 *    所以任何逐出过一次的 Run 会**永久**挂着这句话，尽管从 0 开的这次请求被完整满足了。
 * 2. `finishTerminalReplayRecovery` 把 gap 当成「重放的那一屏不完整」，多发一次强制 TUI 重绘。
 * 3. `screen-evidence` 直接 `throw AgentMuxError(..., 'OUTPUT_GAP')`——一个健康、可交互的会话
 *    取不出屏幕证据。这一条比那句提示严重得多。
 *
 * 「从来没有输出过」不需要单独一支：`first_available_byte` 在无输出时是 0，而 requestedAfterByte
 * 不为负，`0 <= requestedAfterByte` 落在第一路上，天然判 `null`。多写一个 `=== 0` 的守卫是死代码。
 */
export type CtxmuxReplayGapObservation = {
  /** daemon header 里的 `replay.truncated`：这个 Run 的历史曾被逐出过（粘滞，不清零）。 */
  truncated: boolean
  /** 这次 attach/replay 请求的起始字节游标。 */
  requestedAfterByte: number
  /** daemon 当前仍保留的第一个字节；从未有输出时为 0。 */
  firstAvailableByte: number
}

/** 请求区间里确实缺失的那一段：`[requestedAfterByte, firstAvailableByte)`。 */
export type CtxmuxReplayGap = {
  requestedAfterByte: number
  firstAvailableByte: number
}

export function classifyReplayGap(observation: CtxmuxReplayGapObservation): CtxmuxReplayGap | null {
  if (!observation.truncated) return null
  // 逐出发生过，但发生在这次请求的游标**之前**——要的字节一个不少，不是 gap。
  if (observation.requestedAfterByte >= observation.firstAvailableByte) return null
  return {
    requestedAfterByte: observation.requestedAfterByte,
    firstAvailableByte: observation.firstAvailableByte
  }
}
