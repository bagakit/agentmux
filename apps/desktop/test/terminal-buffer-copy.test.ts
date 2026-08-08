import { describe, expect, it } from 'vitest'
import {
  joinBufferLines,
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
