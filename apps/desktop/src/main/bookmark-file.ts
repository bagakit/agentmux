/**
 * 书签解析里**唯一需要主进程能力**的那一件事：把二进制 `.webloc` 转成 XML 再取 URL。
 *
 * 纯逻辑（判扩展名、解析 XML/`.url`、发射、判二进制）全在 `shared/bookmark-file.ts`，两个进程都
 * import 它。这里只放主进程专属的一步——shell 出去调 macOS 自带的 `plutil`——因为渲染进程既拿不到
 * 子进程、也拿不到 `plutil`（见 `shared/bookmark-file.ts` 顶部关于位置的说明）。
 *
 * `runProcess` **由调用方注入**，不在这里 `import { runProcess }`：注入保留可测性（同
 * `browser-app-link.ts` 注入 `openExternal` 的形状），也不让本模块直接依赖 core。传的时候别摘方法
 * 丢 receiver——本仓吃过 `exit: app.exit` 抛 Illegal invocation 的亏；`runProcess` 是自由函数没有
 * receiver 问题，但注入点仍照既有形状收一个函数值。
 */
import type { ProcessRunner } from '@agentmux/core'
import { isBinaryContent, parseWeblocUrl } from '../shared/bookmark-file.js'

/** macOS 自带，固定绝对路径（同 `composer-screenshot.ts` 用 `/usr/sbin/screencapture` 的形状）。 */
const PLUTIL = '/usr/bin/plutil'

/**
 * 从一份 `.webloc` 的**原始字节**里取 URL，能应付二进制。文本（XML）直接解析；二进制（含 NUL）先经
 * `plutil -convert xml1 -o - -`（从 stdin 读，往 stdout 写 XML）转成 XML 再解析。
 *
 * **只收 `Uint8Array`，不收 string**：二进制 plist 一旦经 `toString('utf8')` 往返就会被破坏（实测
 * 83→85 字节、`plutil` 报 `Unexpected character b`），所以「要原字节」这件事必须由签名说死，不能留一个
 * string 兜底臂——那是已证必坏的路径（见 memory「可选属性只买到关掉 tsc」）。调用方在 main 内部读文件时
 * 字节本来就在手上（`WorkspaceFiles.read` 里是 Buffer），交出字节不是负担；渲染侧本就没有字节，也就不该调它。
 * 文本判定仍走 shared 的 `isBinaryContent`（NUL 经 utf8 解码存活为 U+0000），保持「什么算二进制」单一数据源。
 *
 * 「打开」要能认二进制，因为别的软件存的 `.webloc` 我们管不着。但**发射**永远发 XML（见 §2.7），
 * 而「看源码」在二进制上直接不给（T-004）——那一步不经过这里。
 *
 * 取不出一律返回 `null`，不抛：让调用方能说出「这个文件读不出 URL」，退回把它当文本打开。
 * `plutil` 失败（非 macOS、坏 plist）也归入 `null`。
 */
export async function readWeblocUrl(
  rawBytes: Uint8Array,
  runProcess: ProcessRunner
): Promise<string | null> {
  const content = new TextDecoder().decode(rawBytes)
  if (!isBinaryContent(content)) return parseWeblocUrl(content)
  try {
    const result = await runProcess(PLUTIL, ['-convert', 'xml1', '-o', '-', '-'], {
      input: rawBytes,
      timeoutMs: 10_000
    })
    if (result.exitCode !== 0) return null
    return parseWeblocUrl(result.stdout)
  } catch {
    return null
  }
}
