/**
 * OSC 52 「往剪贴板写」的载荷解析。
 *
 * 为什么需要我们自己做：xterm 5.5.0 **没有**实现 OSC 52。它的 InputHandler 在 0/1/2/4/8/10/11/12/
 * 104/110/111/112 都注册了 handler，唯独 52 只剩一行注释 `// 52 - Manipulate Selection Data.`。
 * 于是 PTY 里的 agent 跑 nvim / fzf / lazygit 时，那些 TUI 用标准方式往剪贴板写的内容全部落地。
 *
 * 为什么解析要独立成纯函数而不是写在 handler 里：这一层承载的全是**安全判据**，必须能被测试逐条
 * 质询。handler 那侧只剩「拿到文本 → 交给剪贴板出口」。
 *
 * 判据一：**只写，不读。** OSC 52 的读形式是 `52;c;?`，终端要把当前剪贴板内容回送到 PTY 里。那是
 * 一条实打实的外泄通道——PTY 里跑的东西不该能读用户刚复制的密码。这件事不是靠一道「挡住 `?`」的
 * 门保证的（那道门是多余的，`?` 本来就过不了 base64），而是靠**本模块只产出文本、永不产出回送
 * 字节**这个结构性质：52 的 handler 拿不到 `sendInput`。
 *
 * 判据二：**base64 必须真的能解开。** 载荷是 base64；解不开就是坏帧，不能把原始字节当文本写进
 * 剪贴板（那会把控制序列的残渣塞给用户）。
 *
 * 判据三：**空载荷不算写。** `52;c;` 在规范里表示清空，但一个跑飞的进程发出的空帧和用户主动清空
 * 剪贴板长得一样；静默清掉用户的剪贴板是不可逆的数据丢失，所以不做。
 */

/** 单次 OSC 52 写请求解析出的结果；`null` 表示这一帧不该写剪贴板。 */
export type TerminalOscClipboardWrite = { text: string }

/**
 * 单帧 OSC 52 载荷的体积上限（选区字段 + `;` + base64，即 `ESC ] 52 ;` 之后的全部字符数）。
 *
 * 为什么要有上限：剪贴板写入要过一次 IPC，而 PTY 那侧可以无节制地灌。一个跑飞的进程能用几十兆的
 * 帧把主进程拖住。128KiB 足够覆盖任何人真的想复制的东西（约 96KiB 原文）。
 *
 * 为什么量的是**整帧**而不只是 base64 那段：这道门放在切分选区之前，所以一个几十兆的选区字段
 * （`AAAA…;QQ==`）同样被挡住，而且挡在任何字符串切片之前——只量 body 的话，那种帧要先 indexOf +
 * slice 一遍几十兆才被选区白名单拒掉。名字曾经叫 `MAX_BODY` 而代码判的是整帧，两者漂了；这里以
 * 代码为准把名字改对。
 */
export const TERMINAL_OSC_CLIPBOARD_MAX_PAYLOAD = 128 * 1024

/**
 * 哪些剪贴板选区我们接受。
 *
 * `c` 是系统剪贴板，`s` 在多数终端里等同于「主选区或剪贴板」。`p`（X11 primary，选中即粘贴）在 mac
 * 上没有对应物，写它等于偷偷改掉系统剪贴板，所以不接。空的选区字段按规范默认 `s`。
 */
const ACCEPTED_SELECTIONS = new Set(['c', 's', ''])

/**
 * 解析一个 OSC 52 的载荷（`data` 是 `ESC ] 52 ;` 之后、终止符之前的部分）。
 *
 * 返回 `null` 表示「不写剪贴板」，四种情况共用这一个出口：不认的选区、读请求、空载荷、坏 base64。
 * 调用方对这四种一视同仁——都是「什么也不做」，没有需要区分的后续动作。
 */
export function terminalOscClipboardWrite(data: string): TerminalOscClipboardWrite | null {
  if (data.length > TERMINAL_OSC_CLIPBOARD_MAX_PAYLOAD) return null
  // 选区与载荷之间只按**第一个**分号切：base64 字母表里没有分号，但载荷之后可能还跟着别的东西，
  // 而选区字段本身可以是多个字母（`pc` 这类）。
  const separator = data.indexOf(';')
  if (separator === -1) return null
  const selection = data.slice(0, separator)
  const body = data.slice(separator + 1)
  if (!ACCEPTED_SELECTIONS.has(selection)) return null
  if (body === '') return null
  // 读请求（`52;c;?`）在这里不需要单独一道门：`?` 不在 base64 字母表里，`decodeBase64Text` 必然给
  // null。实测加过那道门，删掉它 14 条全绿——它不可能改变结果，写上去只会让读者以为读请求另有
  // 一条独立的门。判据二真正落在哪：读请求之所以外泄不了，是因为**这个模块只会产出文本、永远
  // 不产出回送 PTY 的字节**，而 52 的 handler 里没有 `sendInput` 这条路（见
  // terminal-capability-replies.ts，那里有一条守卫钉死它）。
  const text = decodeBase64Text(body)
  if (text === null) return null
  return { text }
}

/**
 * base64 → UTF-8 文本，坏输入给 `null`。
 *
 * 用 `atob` 而不是 `Buffer`：这段代码跑在 renderer 里。`atob` 得到的是每字符一字节的 latin1 串，
 * 必须再按 UTF-8 解一次，否则任何非 ASCII（中文、emoji）都会变成乱码。
 */
function decodeBase64Text(body: string): string | null {
  // atob 会容忍一些非法输入，所以先自己把字母表卡死。允许尾部的 `=` 填充与内嵌空白（换行是 base64
  // 在长载荷里的常见形态）。
  const compact = body.replace(/\s+/g, '')
  if (compact === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null
  if (compact.length % 4 !== 0) return null
  try {
    const bytes = Uint8Array.from(atob(compact), (char) => char.charCodeAt(0))
    // fatal: 坏 UTF-8 要报错，而不是替换成 U+FFFD。半个字符的残渣写进剪贴板毫无用处。
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
