/**
 * Offset from the first event. Tabular numerals keep the gutter from shifting as it ticks.
 *
 * 整个读数都交给 {@link formatDuration}——一个符号加一段时长，没有第二套分档。原先这里自己重写了
 * 毫秒档与秒档（只有分钟以上才转交），那两行与 formatDuration 完全同义，于是「一个格式化器」这条
 * 只在文档里成立：把 formatDuration 的分档修好之后，时间沟里仍旧印着 `+60.0s`。同一条规则住在两处
 * 就一定会走岔，这一次走岔的是最显眼的那一处——机器行每一行都在读它。
 */
export function formatOffset(createdAt: number, origin: number): string {
  return `+${formatDuration(Math.max(0, createdAt - origin))}`
}

/**
 * 一段时长，按时分秒读出来。
 *
 * 用户：「时间只显示分钟太不友好了, 应该显示从什么时间点到什么时间点, 消耗的时分秒」。这条是那个
 * 「消耗的时分秒」——原先的实现在分钟处封顶，一次跑了三小时的 Session 会显示成 `184m03s`，读者
 * 得自己去除以 60。小时位不是可选的修饰：Agent 跑一下午是这个产品的常态。
 *
 * 只在**非零的最高位**起显示单位，低位补零：`3h04m03s` / `4m03s` / `3.2s` / `840ms`。补零是为了
 * 等宽下不跳位（gutter 里每行都在同一列），而省掉高位的零是为了短跑不必读 `0h00m03s`。
 *
 * 分档必须按**将要显示的那个值**来判，不是按另一个精度的同一时长。秒档显示到 0.1s，所以先把时长
 * 归到十分之一秒，再用这个粒度决定进不进分钟档：否则 `59_950ms` 会以整数秒 59 留在秒档，却被
 * 四舍五入印成 `60.0s`——一个这套记法里不存在的读数。
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms))
  if (total < 1_000) return `${total}ms`
  const tenths = Math.round(total / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`
  const seconds = Math.round(total / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const rest = seconds % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) return `${hours}h${pad(minutes)}m${pad(rest)}s`
  return `${minutes}m${pad(rest)}s`
}

/**
 * 一个时刻的挂钟读数，`HH:MM:SS`，本地时区。
 *
 * 用户要的「从什么时间点到什么时间点」需要真正的时刻，而偏移量答不了这个问题——`+4m03s` 说不出
 * 那是下午两点还是凌晨三点。
 *
 * 固定 24 小时补零而不走 `toLocaleTimeString`：这个读数落在等宽的时间沟里，一列上下必须对齐，而
 * locale 格式的宽度会变（`h:mm:ss a` 比 `HH:mm:ss` 长且长度随小时变化）。日志读数取可预测的
 * 对齐，这也是各类日志查看器的通行做法。
 */
export function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
