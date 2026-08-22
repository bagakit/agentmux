/**
 * 复制路径时「怎么表示」这一层——把当前用户家目录缩写成 `~`。
 *
 * 与 `clipboard-copy` 的分工（见设计 SSOT《寻址与复制》「一个概念一个出口」）：`copyTextToClipboard`
 * 是「文本怎么写进剪贴板」的出口，它同时承载终端选区、分支名等非路径文本，**不是**缩写该发生的层；
 * 缩写属于「路径怎么表示」。所以缩写在这里做，产路径的那几处调它，写剪贴板仍走 `copyTextToClipboard`。
 *
 * 判据全部来自真实 `home` 值，绝不按路径长相猜（设计 SSOT：不得用 `/Users/<任意一段>` 这类正则）。
 */

/**
 * 把绝对路径开头的当前用户家目录换成 `~`；不匹配则原样返回。
 *
 * 边界必须是 `home` 本身或 `home + '/'`，**不是** `startsWith(home)`——否则 `/tmp/alice-homeOTHER/x`
 * 会被剥成 `~OTHER/x`，一个看起来合法、实则不存在的路径（设计 SSOT 点名的反例）。所以只认两种：
 *   - `path === home`            → `~`
 *   - `path` 以 `home + '/'` 开头 → `~` + 其余部分（含那个 `/`）
 *
 * `home` 为空串表示「不知道本机家目录」（渲染层还没拿到），此时不缩写——宁可长，不可错。远程主机的
 * 路径由调用方负责不传本机 home 进来（缩写以「该路径属于本机」为前置条件），这个纯函数只管边界。
 */
export function abbreviateHomePath(path: string, home: string): string {
  if (!home) return path
  if (path === home) return '~'
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  return path
}

/**
 * 复制多行路径文本时逐行套用缩写。`copyPathsAsAbsolute` 为 `true`（用户主动选了绝对路径）时原样返回；
 * 否则（默认档）把每一行里的本机家目录缩写掉。`home` 为空时同样不动——由 `abbreviateHomePath` 兜住。
 *
 * 输入是 `formatPathsForCopy` 产出的、以 `\n` 拼接的绝对路径文本（复制路径的唯一格式化出口）。这里
 * 只做「表示」这一层的加工，不重拼路径、不碰剪贴板。
 */
export function applyCopyPathStyle(
  text: string,
  options: { home: string; copyPathsAsAbsolute: boolean | undefined }
): string {
  if (options.copyPathsAsAbsolute === true) return text
  return text
    .split('\n')
    .map((line) => abbreviateHomePath(line, options.home))
    .join('\n')
}
