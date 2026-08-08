/**
 * 「一段文本要送进 PTY 时，ESC 怎么办」——bracketed paste 的字节层判定，全仓唯一一份。
 *
 * 判定本身只有一句：ESC（0x1b）换成 ␛（U+241B，可见的替代字形）。之所以是**替换**而不是删除，是因为
 * 用户看得见自己粘了什么——一段带颜色转义的日志粘进来会显示 ␛[32m 而不是变色，这是刻意的代价：
 * 让「本该是数据的东西」在屏幕上暴露自己，好过让它被当成命令执行。
 *
 * 为什么非有不可（这是真事故的形状，不是理论）：`wrapBracketedPasteText` 把文本包在
 * `ESC[200~` … `ESC[201~` 之间告诉 shell「这一整段是数据，别当命令跑」。但**包装不等于转义**——
 * 若载荷自己带一个 `ESC[201~`，它就提前闭合了这个括号，其后的字节重新被 shell 当命令读。
 * 上游 xterm 5.5.0 正是只包不转义（`lib/xterm.js` 的 paste 模块：`prepareTextForTerminal` 只把
 * 换行归一成 `\r`，`bracketTextForPaste` 只做前后拼接），所以**不能指望终端库替我们做这件事**。
 *
 * 为什么它是自己一个 node-free 叶子模块，而不是留在 `providers/shared.ts`：
 * 消毒器的消费者天然分居两个进程。Core 侧 provider 往 PTY 送 prompt 要用它；**渲染进程的终端粘贴
 * 路径同样要用它**（用户按 Cmd+V 或右键 Paste，那段字节直通 PTY，与 prompt 是同一个概念）。而
 * `providers/shared.ts` 顶上就是 `import { existsSync } from 'node:fs'`，根 barrel `@agentmux/core`
 * 也会把 Core 的 process/filesystem 运行时一并拖进来——渲染进程到不了。于是「渲染层需要它却拿不到」
 * 的唯一出路本会是**再手抄一份**，而这正是本仓最常复发的缺陷族：同一个概念两处判定，今天一致纯属
 * 两处同时写对，任一侧改了另一侧不会红。搬到这里 + 开 `@agentmux/core/bracketed-paste` 子路径，
 * 两个进程读的就是同一个函数。同 `risk-tier.ts` / `agent-provider-id.ts` 的理由与做法。
 *
 * 本文件刻意不 import 任何 `node:` 内置模块——这是它能被渲染进程消费的前提，
 * `test/bracketed-paste.test.ts` 里有一条守卫钉住这一点（判 import 关系，不判文件里有没有出现那几个字）。
 *
 * **控制字节一律写成 `\u001b` 转义，不许把裸 0x1b 敲进源文件**：裸控制字节在 diff、grep、审阅里都不可见
 * （tracker #385 就是一个 NUL 字节让整个测试文件对 `git grep` 永久失明）。
 *
 * **本模块管不到的事，明说**：它只管「我们主动送进 PTY 的字节」。往**系统剪贴板**写的那条路
 * （PTY 里的程序发 OSC 52 → `clipboard.writeText`）不在这里，且今天不消毒——用户把被投毒的剪贴板
 * 粘到别的终端里时，我们的消毒器根本不在链路上。那是另一处判定，见 tracker #815。
 */

export const BRACKETED_PASTE_START = '\u001b[200~'
export const BRACKETED_PASTE_END = '\u001b[201~'

/**
 * 把 ESC 换成可见的 ␛，使任何载荷都不可能自己闭合 bracketed paste、也不可能携带别的控制序列。
 *
 * 判据是「ESC 这个字节」而不是「`ESC[201~` 这个串」：只挡结束符会漏掉 `ESC[200~`（伪造开始）、
 * 光标移动、OSC 写剪贴板等一整族；按字节挡则不需要枚举下游终端认得的所有序列。
 */
export function sanitizeBracketedPasteText(text: string): string {
  return text.replaceAll('\u001b', '\u241b')
}

/** 消毒后再包 bracket。顺序是承重的：先包后消毒会把我们自己的包装符也消掉。 */
export function wrapBracketedPasteText(text: string): string {
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(text)}${BRACKETED_PASTE_END}`
}

/**
 * 送一条 prompt 进 PTY 的字节。
 *
 * 只有多行才包 bracket：单行文本不存在「中途被当成回车提交」的问题，而包装本身要求对端开了
 * bracketed paste 模式，没开的话那两个序列会原样显示出来。两条路都消毒——**这是本函数的不变量**：
 * 无论走哪个分支，ESC 都不会以原字节到达 PTY。
 */
export function buildPromptInputPayload(prompt: string): string {
  return /[\r\n]/.test(prompt)
    ? wrapBracketedPasteText(prompt)
    : sanitizeBracketedPasteText(prompt)
}
