import { describe, expect, it } from 'vitest'
import {
  joinBufferLines,
  terminalCopyOutcome,
  terminalScrollbackText,
  terminalViewportText,
  type TerminalBufferLine,
  type TerminalBufferSnapshot
} from '../src/renderer/src/lib/terminal-buffer-copy'

/**
 * #638 的**真修复**这一侧：一条不经过选区的复制路。
 *
 * 为什么这个文件能存在，而选区那条路不能被测：desktop 包没有 DOM 环境，选区 API（`selectAll`、
 * `getSelection`）一个都调不到，所以「selectAll 绕过停用」那条推论在本仓无法验证（在册 #649）。
 * 缓冲区取值不同——接口就是三个纯取值方法，用假 buffer 直接喂，每条判据都能被单独变异钉住。
 *
 * 分工：这里守**取值与拼接**；「菜单上有没有这两个入口、点了会不会调到这里」由
 * terminal-buffer-copy-wiring 那一侧守（组件与取值分开，理由同 service-window-notice）。
 */

/** 造一行。`wrapped` 表示它是上一行的续行。 */
function line(text: string, wrapped = false): TerminalBufferLine {
  return {
    isWrapped: wrapped,
    // 真 xterm 用空白单元把每行填满到 cols，所以 trimRight 是**可观测**的：这里照做，
    // 否则 join 里那个 `!continues` 判据喂进来的两种取值一模一样，断言就恒真了。
    translateToString: (trimRight?: boolean) => (trimRight === true ? text.replace(/\s+$/u, '') : text)
  }
}

/** 造一个缓冲区。`viewportY` 默认 0（没往回滚）。 */
function buffer(lines: readonly TerminalBufferLine[], viewportY = 0): TerminalBufferSnapshot {
  return {
    length: lines.length,
    viewportY,
    getLine: (index) => lines[index]
  }
}

describe('joinBufferLines：折行不是换行', () => {
  it('普通行之间插换行', () => {
    expect(joinBufferLines([line('first'), line('second')])).toBe('first\nsecond')
  })

  it('续行直接接在前一行后面，不插换行', () => {
    // 本文件最承重的一条。天真的 `lines.join('\n')` 会在折行处插入一个原文里不存在的换行——
    // 复制一条长命令再粘回终端，它被切成两半执行。这是会改变粘贴语义的数据损坏，不是显示瑕疵，
    // 而且宽终端上很难撞见。把 `!line.isWrapped` 改成 `true`（即无条件换行）这条会红。
    expect(joinBufferLines([line('npm run '), line('build', true)])).toBe('npm run build')
  })

  it('折行段的行尾空白原样保留，非折行段裁掉', () => {
    // 两个方向一起钉：右边界正是终端宽度的那一段，空白属于内容，裁掉就吃掉了真实字符；
    // 而没被写满的行拖着 xterm 填充的空白单元，不裁则每行拖一串空格。
    // 把 `!continues` 写成常数（无论 true 还是 false）都会让其中一侧变红。
    expect(joinBufferLines([line('wide   '), line('tail', true)])).toBe('wide   tail')
    expect(joinBufferLines([line('padded   ')])).toBe('padded')
  })

  it('第一行即使带 isWrapped 也不在开头插换行', () => {
    // 从缓冲区中间切片时第一行可能恰好是一条续行（它的前半截在切片之外）。`index > 0` 那个
    // 合取项就是为这个而在：删掉它，输出会以一个凭空的换行开头。
    expect(joinBufferLines([line('continued', true), line('next')])).toBe('continued\nnext')
  })

  it('空数组得到空串', () => {
    expect(joinBufferLines([])).toBe('')
  })
})

describe('terminalViewportText：跟着视口，不是跟着缓冲区底', () => {
  it('取 viewportY 开始的 rows 行', () => {
    const lines = [line('zero'), line('one'), line('two'), line('three')]
    expect(terminalViewportText(buffer(lines, 1), 2)).toBe('one\ntwo')
  })

  it('用户往回滚之后，取的是看见的那一屏', () => {
    // 起点若取 baseY（缓冲区底那一屏）而不是 viewportY，滚动之后复制到的是**另一段内容**——
    // 剪贴板里是一段合法文本，只是不是用户指的那段，完全静默。把 viewportY 换成 0 这条会红。
    const lines = [line('scrolled away'), line('visible top'), line('visible bottom')]
    expect(terminalViewportText(buffer(lines, 1), 2)).toBe('visible top\nvisible bottom')
  })

  it('屏幕比内容长时不越界', () => {
    expect(terminalViewportText(buffer([line('only')], 0), 50)).toBe('only')
  })

  it('掐掉末尾空行，保留开头空行', () => {
    // 两侧一起判：末尾那片未写过的屏不该跟着走；而开头的空行可能是程序自己排的版，删掉就改了内容。
    const lines = [line(''), line('body'), line('   '), line('')]
    expect(terminalViewportText(buffer(lines, 0), 4)).toBe('\nbody')
  })
})

describe('terminalScrollbackText：整个回滚缓冲', () => {
  it('从第 0 行取到 length，不受 viewportY 影响', () => {
    // viewportY 故意设成非 0：整段复制说的是「这个会话的全部输出」，与用户滚到哪儿无关。
    // 若这里误用了 viewportY 作起点，回滚过的会话会静默丢掉上半段。
    const lines = [line('oldest'), line('middle'), line('newest')]
    expect(terminalScrollbackText(buffer(lines, 2))).toBe('oldest\nmiddle\nnewest')
  })

  it('折行在整段复制里同样不被拆开', () => {
    const lines = [line('a very long '), line('command line', true), line('done')]
    expect(terminalScrollbackText(buffer(lines))).toBe('a very long command line\ndone')
  })

  it('空缓冲区得到空串', () => {
    expect(terminalScrollbackText(buffer([]))).toBe('')
  })
})

describe('alternate buffer：两档范围读的不是同一块缓冲区', () => {
  /**
   * 全屏 TUI 会把终端切到 alternate buffer（DECSET ?1049）。那块缓冲**按定义只有一屏、没有回滚**，
   * 而 `terminal.buffer.active` 此刻正指着它；会话历史原封不动留在 normal buffer 里。
   *
   * 这是 #638 修复漏掉的半条：取值源从选区换到了缓冲区（对的），但「全部输出」跟着 active 走
   * （错的）。于是同一个菜单项，在不占 alternate buffer 的 Agent 上工作、在全屏 TUI 上缩水成一屏
   * 甚至直接取空——而且静默取空，用户只看见点了没反应。
   *
   * 判据是**缓冲区模型**，不是哪个 Agent：任何占用 alternate buffer 的程序都适用。
   */
  const history = [line('run 1 output'), line('run 2 output'), line('run 3 output')]
  const oneScreen = [line('┌ full-screen TUI ┐'), line('└ one screen only ┘')]

  it('active 指向 alternate 时，整段复制仍拿到 normal 的全部历史', () => {
    // 这条就是用户报的那个缺陷的正面判据。把生产代码里 scrollback 的取值源改回 active，
    // 它拿到的是 oneScreen 那两行，这条当场红。
    const normal = buffer(history)
    expect(terminalScrollbackText(normal)).toBe('run 1 output\nrun 2 output\nrun 3 output')
  })

  it('同一时刻，可见输出读 alternate，拿到的正是那一屏', () => {
    // 反向的一半：两档**不能**都读 normal。都读 normal 的话，TUI 开着时「复制可见输出」会复制到
    // 屏幕上根本没有的旧内容——同样静默、同样错，而上一条判据看不出来。
    const alternate = buffer(oneScreen)
    expect(terminalViewportText(alternate, 2)).toBe('┌ full-screen TUI ┐\n└ one screen only ┘')
  })

  it('两档在同一时刻得到的文本互不相同', () => {
    // 前两条各自钉死一档的期望值；这一条钉死它们**不是同一段**。若哪天两个调用点被接成同一块
    // 缓冲区，前两条里至少一条会红——但这条说得更直接，读失败信息的人一眼知道病在哪。
    expect(terminalScrollbackText(buffer(history))).not.toBe(terminalViewportText(buffer(oneScreen), 2))
  })

  it('alternate 已被 TUI 清空时，整段复制仍拿得到历史', () => {
    // 第二种触发形态（原则 13：不能过拟合到单一场景）。上面那组是「alternate 有内容」；
    // 这里是「alternate 是空的」——TUI 刚清屏、或内容已滚出那一屏。跟着 active 走会取到空串，
    // 于是静默 return，用户什么都拿不到，而历史其实好好地躺在 normal 里。
    expect(terminalViewportText(buffer([]), 24)).toBe('')
    expect(terminalScrollbackText(buffer(history))).toBe('run 1 output\nrun 2 output\nrun 3 output')
  })
})

describe('terminalCopyOutcome：取到空不静默，说清哪一档空了', () => {
  it('有文本时原样交出去写剪贴板', () => {
    expect(terminalCopyOutcome('hello', 'visible')).toEqual({ kind: 'copy', text: 'hello' })
  })

  it('空串时不写剪贴板，改为给出一条提示', () => {
    // 往剪贴板写空串会清掉用户原有的内容，所以 empty 支必须**没有** text 可写。
    const outcome = terminalCopyOutcome('', 'all')
    expect(outcome.kind).toBe('empty')
    expect(outcome).not.toHaveProperty('text')
  })

  it('两档的提示各不相同，且都点名了另一档', () => {
    // 提示的全部价值在于「现在该怎么办」。两档取值源不同（可见读 active、全部读 normal），
    // 一档空着另一档往往正好有内容——所以必须点名另一档，而不是只说「没有内容」。
    const visible = terminalCopyOutcome('', 'visible')
    const all = terminalCopyOutcome('', 'all')
    expect(visible.kind === 'empty' && visible.notice).toBeTruthy()
    expect(all.kind === 'empty' && all.notice).toBeTruthy()
    const visibleNotice = visible.kind === 'empty' ? visible.notice : ''
    const allNotice = all.kind === 'empty' ? all.notice : ''
    expect(visibleNotice, '两档提示相同——用户分不出是哪一档空了').not.toBe(allNotice)
    expect(visibleNotice, '可见输出为空时没有指向「全部输出」这条出路').toContain('Copy all output')
    expect(allNotice, '全部输出为空时没有指向「可见输出」这条出路').toContain('Copy visible output')
  })

  it('两档提示都说明 Agent 没受影响（原则 11 第 2 类）', () => {
    // 取空是**我们这一步**没取到，不是 Agent 坏了。不说这句，用户会以为自己的 Agent 出了问题。
    for (const scope of ['visible', 'all'] as const) {
      const outcome = terminalCopyOutcome('', scope)
      const notice = outcome.kind === 'empty' ? outcome.notice : ''
      expect(notice, `${scope} 档的提示没说明 Agent 未受影响`).toContain('Agent is unaffected')
      expect(notice, `${scope} 档的提示没说明剪贴板未被改动`).toContain('clipboard')
    }
  })

  it('只有空串才走 empty；一个空格不是空', () => {
    // 判据是「取到了没有」，不是「看起来像不像空」。若这里放宽成 trim 后为空，复制一行缩进
    // （合法内容）就会被当成失败而不写剪贴板。
    expect(terminalCopyOutcome(' ', 'visible').kind).toBe('copy')
    expect(terminalCopyOutcome('\n', 'all').kind).toBe('copy')
  })
})

describe('自证：假 buffer 真的能分辨被测的那几件事', () => {
  it('trimRight 在这个替身上是可观测的', () => {
    // 没有这一条，「折行段不裁、非折行段裁」那条可能只是因为替身对两种取值返回同一个串而恒真
    // （记忆 fixture-wrong-shape-blinds-the-test）。
    const probe = line('text   ')
    expect(probe.translateToString(true)).toBe('text')
    expect(probe.translateToString(false)).toBe('text   ')
  })

  it('getLine 越界返回 undefined，切片据此跳过', () => {
    // 夹取逻辑依赖这个形状；替身若对越界返回一个空行对象，越界那条断言就证不出东西。
    expect(buffer([line('x')]).getLine(9)).toBeUndefined()
  })
})
