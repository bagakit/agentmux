// 一条**不经过选区**的复制路。
//
// 为什么需要它：#638 的根因是选区服务被停用（机制写在 `terminal-selection-mode.ts` 文件头——
// TUI 一开鼠标上报，xterm 就 `disable()` 选区服务，平白左拖不建选区模型）。此前发货的三条复制路
// ——右键 Copy、Ctrl+C、Cmd+C——**全都以「有没有选区」为闸**，所以它们一起失效：那不是三个缺陷，
// 是一个缺陷的三个出口。既然如此，再修那三条出口中的任何一条都到不了根上。
//
// 这一层换了取值源：读 `terminal.buffer.active`，xterm 的**公开数据 API**，与 SelectionService
// 完全无关——它不问选区在不在、不问鼠标上报开没开，因此鼠标上报开着时它照常工作。
//
// 为什么不走 `selectAll()`：那条推论（selectAll 不检查 `_enabled`，故能绕过停用）读源码是成立的，
// 但在本仓**无法被验证**——desktop 包没有 DOM 环境，选区 API 一个都调不到（在册 #649）。把用户
// 眼下最痛的一条路建在一个测不了的推论上，等于把「它到底修没修好」交给下一次手工验收。缓冲区读取
// 反过来：接口是三个纯取值方法，用假 buffer 就能逐条断言，包括下面那条最容易写错的换行合并。
//
// 取值范围有两档，因为「复制」在终端里本就是两个意思，不该合成一个按钮：可视区（我现在看见的这屏）
// 与整个回滚缓冲（这个会话到目前为止的全部输出）。

/** 一行缓冲区文本。取 xterm `IBufferLine` 的**最小**子集——这一层只需要这两样。 */
export interface TerminalBufferLine {
  /**
   * 这一行是不是上一行的**续行**（xterm 的 `isWrapped`）。
   *
   * 承重字段，见 {@link joinBufferLines}：一条超过终端宽度的逻辑行在缓冲区里被切成多行存放，
   * 只有这个标记能把「换行是真的」与「换行是排版造成的」分开。
   */
  readonly isWrapped: boolean
  /** 这一行的文本；`trimRight` 为真时裁掉行尾空白（xterm 用空白单元把每行填满到 cols）。 */
  translateToString(trimRight?: boolean): string
}

/** 缓冲区。取 xterm `IBuffer` 的最小子集。 */
export interface TerminalBufferSnapshot {
  /** 缓冲区总行数（含回滚）。 */
  readonly length: number
  /** 可视区顶端在缓冲区里的行号。 */
  readonly viewportY: number
  /** 取一行；越界返回 `undefined`。 */
  getLine(index: number): TerminalBufferLine | undefined
}

/**
 * 把若干缓冲行拼成文本，**只在逻辑换行处插 `\n`**。
 *
 * 这是本模块唯一有难度的一条，也是最容易被写错且错得很安静的一条：xterm 把一条超过终端宽度的
 * 逻辑行切成多个缓冲行存放，续行带 `isWrapped: true`。天真地 `lines.join('\n')` 会在每个折行处
 * 插入一个**原文里不存在**的换行——复制一条长命令再粘回终端，它会被切成两半执行。这不是显示瑕疵，
 * 是会改变粘贴语义的数据损坏，而且宽终端上很难撞见，正是那种发货很久才被发现的形状。
 *
 * 所以：续行直接接在前一行**后面**，不插换行；非续行才起新行。
 *
 * 行尾空白必须裁（`trimRight = true`）：xterm 用空白单元把每行填满到 cols，不裁的话每行都拖着
 * 几十个空格。但**折行的那一段不能裁**——它右边界正是终端宽度，裁掉就把真实内容里的空格吃了。
 * 判据是「下一行是不是续行」：是，就说明这一行被写满了，原样保留。
 */
export function joinBufferLines(lines: readonly TerminalBufferLine[]): string {
  let text = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line) continue
    // 后面还跟着续行 → 这一行是被写满折下去的，右侧空白属于内容，不裁。
    const continues = lines[index + 1]?.isWrapped === true
    const chunk = line.translateToString(!continues)
    if (index > 0 && !line.isWrapped) text += '\n'
    text += chunk
  }
  return text
}

/**
 * 掐掉末尾的空行。
 *
 * 终端缓冲区的下方通常是一片尚未写过的空行（光标之后的整个屏）。把它们一起复制走，用户粘贴时会
 * 拖着一大段空白。开头的空行**不动**：那可能是程序自己排的版，删掉就改了内容。
 */
function withoutTrailingBlankLines(text: string): string {
  const lines = text.split('\n')
  let end = lines.length
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1
  return lines.slice(0, end).join('\n')
}

/**
 * 从缓冲区取一段行（半开区间 `[from, to)`）。
 *
 * 越界安全**由 `if (line)` 兜住**，不靠夹取：xterm 的 `getLine` 越界返回 `undefined`。
 * 上界的 `Math.min` 只是把循环次数收进缓冲区大小（`viewportY + rows` 在屏幕比内容长时会超出），
 * 对**输出**没有影响——去掉它测试全绿，这是如实记录，不是遗漏的判据。下界一度也写了
 * `Math.max(0, from)`，已删：两个调用点传的是 `viewportY` 和 `0`，负数到不了这里，那段代码
 * 连同它注释里编造的调用方一起是死的。
 */
function sliceLines(
  buffer: TerminalBufferSnapshot,
  from: number,
  to: number
): TerminalBufferLine[] {
  const end = Math.min(buffer.length, to)
  const lines: TerminalBufferLine[] = []
  for (let index = from; index < end; index += 1) {
    const line = buffer.getLine(index)
    if (line) lines.push(line)
  }
  return lines
}

/**
 * 可视区那一屏的文本——「复制我现在看见的」。
 *
 * 起点取 `viewportY` 而**不是** `baseY`：用户往回滚了之后，这两者才分岔，而这条动作说的是
 * 「我看见的这屏」，所以必须跟着视口走。取 `baseY` 会在滚动之后复制到另一段内容，那种错误
 * 完全静默——剪贴板里是一段合法文本，只是不是用户指的那段。
 */
export function terminalViewportText(buffer: TerminalBufferSnapshot, rows: number): string {
  return withoutTrailingBlankLines(
    joinBufferLines(sliceLines(buffer, buffer.viewportY, buffer.viewportY + rows))
  )
}

/** 整个回滚缓冲的文本——「复制这个会话到目前为止的全部输出」。 */
export function terminalScrollbackText(buffer: TerminalBufferSnapshot): string {
  return withoutTrailingBlankLines(joinBufferLines(sliceLines(buffer, 0, buffer.length)))
}
