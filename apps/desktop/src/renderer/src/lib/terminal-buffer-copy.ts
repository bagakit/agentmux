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
// 与当前保留的正常回滚缓冲。

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

/**
 * 当前保留的 normal 回滚缓冲的文本，不包含已淘汰行或 alternate 输出。
 *
 * 调用方必须喂 **normal buffer**，不是 `buffer.active`。这是 #638 那次修复漏掉的半条：全屏 TUI
 * 会把终端切到 alternate buffer（DECSET ?1049），那块缓冲按定义只有一屏、没有回滚，而此刻
 * `buffer.active` 正指着它。跟着 active 走，「全部输出」就在 TUI 开着时缩水成当前一屏，
 * 想复制的内容一旦滚出去就直接取空——而且是静默取空。normal buffer 只保留自身的有限历史，alternate 中的输出不会自动追加进去。
 *
 * 这一层不接收终端对象、也不自己挑缓冲区：挑哪一块是**调用点的判定**，在那里被
 * terminal-buffer-copy-wiring 逐个调用点钉死取值身份。这里多一个「要不要 normal」的开关，
 * 等于让同一个决定有两个说法。
 */
export function terminalScrollbackText(buffer: TerminalBufferSnapshot): string {
  return withoutTrailingBlankLines(joinBufferLines(sliceLines(buffer, 0, buffer.length)))
}

/**
 * 两档复制范围。加一档会让下面那张表少一格而 tsc 变红，不会安静落进某个 default。
 *
 * **不导出**：调用点传的是字面量 'visible' / 'all'，没有人需要这个名字。导出一个零消费者的
 * 类型只是把内部形状钉在公开面上，以后改它要先数谁在用。
 */
type TerminalCopyScope = 'visible' | 'all'

/**
 * 某一档复制取到空串时要说的那句话（原则 11 第 2 类）。
 *
 * 取空**不是错误**：Agent 好好的，字节也好好的，是我们这一步没取到东西。所以三件事都要说清——
 * 哪一档空了、现在是什么状态、还能怎么办——并且**点名另一档**，因为两档的取值源本就不同
 * （可见读 active、全部读 normal），一档空着另一档往往正好有内容，这是用户此刻唯一有用的动作。
 *
 * 判据只能是缓冲区模型，不能是「哪个 Agent 在跑」：这里不出现任何 Provider 名
 * （守卫见 test/terminal-copy-provider-agnostic.test.ts）。
 */
const EMPTY_COPY_NOTICE: Record<TerminalCopyScope, string> = {
  visible:
    'Copy visible output found nothing on screen. Nothing was written to the clipboard — ' +
    'your Agent is unaffected. Copy all output still has this session’s retained history.',
  all:
    'Copy all output found no retained history for this session. Nothing was written to the clipboard — ' +
    'your Agent is unaffected. Copy visible output still copies what is on screen now.'
}

/**
 * 一次复制的结局：要么有文本可写，要么该说一句话。
 *
 * 为什么是 union 而不是让组件自己写 `if (!text) return`：那个分支**守不住**。
 * terminal-buffer-copy-wiring 已经如实记过这个缺口——唯一能对 in-component 分支写的判据是
 * 「这个 if 在场」，而在场判据挡不住把条件取反（`if (text) return` 编译照过、计数不变、全绿，
 * 而用户从此一次都复制不到）。换成纯函数之后，取反当场变红。
 *
 * 两条出路都不是「失败」：`empty` 这一支专门存在，是为了让「没取到」有个地方可说，而不是
 * 静默 `return`——静默正是用户报上来的症状：点了菜单，什么都没发生，也没人说为什么。
 */
export type TerminalCopyOutcome =
  | { kind: 'copy'; text: string }
  | { kind: 'empty'; notice: string }

export function terminalCopyOutcome(text: string, scope: TerminalCopyScope): TerminalCopyOutcome {
  if (text === '') return { kind: 'empty', notice: EMPTY_COPY_NOTICE[scope] }
  return { kind: 'copy', text }
}
