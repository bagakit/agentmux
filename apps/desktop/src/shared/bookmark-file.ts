/**
 * 书签文件的两种标准格式——`.webloc`（macOS plist，键 `URL`）与 `.url`
 * （Windows `[InternetShortcut]`）——的**纯判定与发射**。判定单独成模块，理由和
 * `main/browser-app-link.ts` 一样：留在 IPC 回调体里就只能靠文本扫描守，而那种守法本仓吃过亏
 * （`window-security.ts` 的 docstring 记着两个实测存活的变异）。这里的判定要能被单测直接质询。
 *
 * ## 为什么它在 `shared/` 而不在 `main/`
 *
 * `browser-app-link.ts` 待在 `main/` 是对的——它的消费者**只有主进程**。书签这条不一样：判扩展名、
 * 从文本取 URL、发射、判二进制，这四件事全在**渲染进程**（`openFile` 分派、BrowserPane 存、
 * 「看源码」按钮按二进制灰掉）。而渲染进程从不 import `main/`（vite 分包 + `externalizeDepsPlugin`
 * 是硬边界）。跨两个进程的纯代码，本仓的既有家是 `shared/`（`browser-bounds.ts` 两端都 import，
 * `scratch-topics.ts` 被 8 个渲染侧文件 import）。
 *
 * 「纯（可测）」和「放 main/」是两件事——`browser-app-link.ts` 之所以纯是为了可测，不是为了留在
 * main。位置该由消费者决定：数一遍消费者，书签的消费者跨两个进程，所以 SSOT 落 `shared/`。
 * 真正需要主进程能力的那一件事（二进制 plist 要 shell 出去调 `plutil`）单独放 `main/bookmark-file.ts`。
 *
 * ## 这个文件必须保持零 `node:` 导入
 *
 * 有守卫在盯 `shared/` 的这条性质，而它正是本模块能被渲染侧 import 的**前提**。所以文件名派生等
 * 用不上 `node:path`——自己写字符串处理。源码里也绝不写字面控制字符（NUL 禁令会打红，且会破坏
 * 文件），需要比对时一律走 `charCodeAt` 的码点判断。
 */

/** 二进制判据用的 NUL 码点。源码里不写字面 NUL，用码点构造。 */
const NUL = String.fromCharCode(0)

/**
 * 我们认得的书签扩展名，**唯一真源**。散在两处写 `'webloc'` 字面量会被 `schema-enum-ssot` 房规
 * 打红。类型从这份元组派生（`[number]`），别再手写第二份联合。
 */
export const BOOKMARK_FILE_EXTENSIONS = ['webloc', 'url'] as const

export type BookmarkFileKind = (typeof BOOKMARK_FILE_EXTENSIONS)[number]

/**
 * 双向精确性：元组与联合互相包含。`as const` 只保证联合从元组派生（⊆ 的一半），但若哪天有人把
 * `BookmarkFileKind` 手写成别的形状，这道断言会红。形状同 `browser-toolbar.ts` 的 exactness 证明。
 */
const _bookmarkKindIsExactlyTheTuple: [
  BookmarkFileKind extends (typeof BOOKMARK_FILE_EXTENSIONS)[number] ? true : never,
  (typeof BOOKMARK_FILE_EXTENSIONS)[number] extends BookmarkFileKind ? true : never
] = [true, true]
void _bookmarkKindIsExactlyTheTuple

/** 取路径末尾 `.` 之后的小写扩展名。无 `node:path`：`shared/` 不许有 node 依赖。 */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  // 没有 `.`、或 `.` 在开头（`.webloc` 这种无名点文件不是书签）都不算。
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

/**
 * 按路径判它是不是书签文件、是哪一种。纯字符串判定——文件到底装了什么由解析那步说。
 * 不是书签就返回 `null`。
 */
export function bookmarkKindForPath(path: string): BookmarkFileKind | null {
  const ext = extensionOf(path)
  return (BOOKMARK_FILE_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as BookmarkFileKind)
    : null
}

/**
 * 这份字节是不是二进制。**判据是有没有 NUL**，不是扩展名、也不是「XML 解析失败了」——后两者会把
 * 一个合法但我们没料到的 XML 变体误判成二进制。同一判据本仓已有先例
 * （`reference-name-containment.test.ts` 按 `raw.includes(0)` 区分）。
 *
 * 渲染侧收到的是 `files.read` 过 `toString('utf8')` 后的 string，NUL 字节会变成 U+0000 字符留在串里
 * （实测二进制 `bplist00` 的 NUL 过 utf8 解码后仍在）。所以在 string 上判。T-004 靠它决定
 * 「看源码」按钮灰不灰——那一步在渲染侧，拿不到主进程。
 */
export function isBinaryContent(content: string): boolean {
  return content.includes(NUL)
}

/** `<`/`&`/`>`/`"` 的 XML 转义。plist 是 XML，URL 里的 `&` 与 `<` 不转义会让 `plutil` 判非法。 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 从一份 `.webloc` 的 **XML** 文本里取出 `URL`。取不出返回 `null`，绝不抛——调用方要能说出
 * 「这个文件读不出 URL」而不是崩。
 *
 * 只认 XML：二进制 plist 由 `main/bookmark-file.ts` 先 `plutil` 转成 XML 再喂进来（渲染侧拿不到
 * `plutil`）。不引 XML 依赖——plist 的 `<key>URL</key><string>…</string>` 形状足够窄，正则够用。
 */
export function parseWeblocUrl(xml: string): string | null {
  // <key>URL</key> 后面第一个 <string>…</string>。plist 允许键值之间有空白/换行。
  const match = /<key>\s*URL\s*<\/key>\s*<string>([\s\S]*?)<\/string>/i.exec(xml)
  if (!match) return null
  const url = unescapeXml(match[1] ?? '').trim()
  return url.length > 0 ? url : null
}

/**
 * 从一份 `.url`（`[InternetShortcut]`）文本里取出 `URL=` 的值。取不出返回 `null`，不抛。
 * 认 CRLF 也认 LF（别的软件存的可能是 CRLF）。
 */
export function parseUrlShortcutUrl(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    // 键名大小写不敏感（Windows 侧 `URL=` 惯例，但容错）。
    if (/^url\s*=/i.test(line)) {
      const value = line.slice(line.indexOf('=') + 1).trim()
      if (value.length > 0) return value
    }
  }
  return null
}

/**
 * 从一份书签**文本**里按种类取 URL。种类由调用方（已知路径）给定。取不出返回 `null`，不抛。
 * 二进制 `.webloc` 不走这里——调用方要先转 XML。
 */
export function parseBookmarkUrl(kind: BookmarkFileKind, content: string): string | null {
  return kind === 'webloc' ? parseWeblocUrl(content) : parseUrlShortcutUrl(content)
}

/**
 * 发射一份 `.webloc` 的 XML plist。只写 `URL`（§2.7.1：页面摘要会过期，不放；标题不进这个格式，
 * Finder 靠文件名）。产出必须过 `plutil -lint`——所以 DOCTYPE、声明、闭合标签一个都不能少。
 */
export function emitWebloc(url: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    '\t<key>URL</key>\n' +
    `\t<string>${escapeXml(url)}</string>\n` +
    '</dict>\n' +
    '</plist>\n'
  )
}

/**
 * 从页面标题派生一个安全的书签文件名（不含扩展名）。
 *
 * 承重的一条：**必须挡住 `/` `\\` `:` 与所有控制字符（含 NUL）**——派生出一个含 `/` 的名字会写到
 * 意料之外的目录去（`files.write` 之后是 `localMutablePathWithin`，一个含 `/` 的段会改变落点）。
 * 冒号在 macOS 的 Finder 里会被显示成 `/`，也一并换掉。连字符等普通标点保留——进文件名安全，砍掉
 * 只会让派生名难认。空标题（`about:blank`、还没加载出标题的页）退回一个常量名。
 *
 * 走 `charCodeAt` 逐字判而不是控制字符正则区间：源码里不写字面控制字符（NUL 禁令 + 破坏文件），
 * 而 `[\x00-\x1f]` 这种区间在本仓工具链里会被落成字面字节。无 `node:path`：`shared/` 不许 node 依赖。
 */
export function bookmarkFileNameFromTitle(title: string): string {
  let out = ''
  for (const ch of title) {
    const code = ch.codePointAt(0) ?? 0
    out += ch === '/' || ch === '\\' || ch === ':' || code < 0x20 ? ' ' : ch
  }
  const cleaned = out.replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim()
  // 按码点截，不按 UTF-16 code unit：`slice(0, 120)` 若切在代理对中间会留下半个字符（孤立
  // 代理），派生名里就多个坏字符。`Array.from` 逐码点，切 emoji/CJK 边界也整。
  return cleaned.length > 0 ? Array.from(cleaned).slice(0, 120).join('') : 'Bookmark'
}
