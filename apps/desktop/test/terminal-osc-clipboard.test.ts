import { describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_OSC_CLIPBOARD_MAX_PAYLOAD,
  terminalOscClipboardWrite
} from '../src/shared/terminal-osc-clipboard.js'
import { installTerminalOscHandlers } from '../src/renderer/src/lib/terminal-capability-replies.js'

/** base64 一个 UTF-8 字符串，构造测试载荷用。 */
function body(text: string, selection = 'c'): string {
  const bytes = new TextEncoder().encode(text)
  let latin1 = ''
  for (const byte of bytes) latin1 += String.fromCharCode(byte)
  return `${selection};${btoa(latin1)}`
}

describe('OSC 52 往剪贴板写的载荷解析', () => {
  it('解出 base64 里的文本', () => {
    expect(terminalOscClipboardWrite(body('hello'))).toEqual({ text: 'hello' })
  })

  it('非 ASCII 按 UTF-8 解，而不是每字符一字节', () => {
    // 这一条钉住 atob 之后必须再解一次 UTF-8。少了那一步，'中' 会变成两个乱码字符——
    // 而不是抛错，所以只测 ASCII 的话这个 bug 会静默活下来。
    expect(terminalOscClipboardWrite(body('中文 🎉'))).toEqual({ text: '中文 🎉' })
  })

  it('读请求解不出文本，因此写不了剪贴板', () => {
    // `?` 不在 base64 字母表里，所以它和坏帧走同一个出口。这一条只钉「读请求确实到不了剪贴板」，
    // 不声称有一道专门挡它的门——实测加过那道门，删掉它 14 条全绿，它不可能改变结果。
    // 真正防外泄的性质在下面「52 不许回送任何字节」那条守卫里。
    expect(terminalOscClipboardWrite('c;?')).toBeNull()
    expect(terminalOscClipboardWrite('s;?')).toBeNull()
  })

  it('只接系统剪贴板与默认选区，不接 X11 primary', () => {
    expect(terminalOscClipboardWrite(body('x', 'c'))).toEqual({ text: 'x' })
    expect(terminalOscClipboardWrite(body('x', 's'))).toEqual({ text: 'x' })
    expect(terminalOscClipboardWrite(body('x', ''))).toEqual({ text: 'x' })
    // p = primary（选中即粘贴）。mac 上没有对应物，写它等于偷偷改系统剪贴板。
    expect(terminalOscClipboardWrite(body('x', 'p'))).toBeNull()
    expect(terminalOscClipboardWrite(body('x', 'pc'))).toBeNull()
  })

  it('空载荷不算写——静默清掉用户剪贴板是不可逆的', () => {
    expect(terminalOscClipboardWrite('c;')).toBeNull()
  })

  it('坏 base64 给 null，而不是把原始字节当文本', () => {
    // 这三种都能骗过一个只判「非空」的实现。
    expect(terminalOscClipboardWrite('c;not base64!!')).toBeNull()
    expect(terminalOscClipboardWrite('c;aGVsbG8')).toBeNull() // 长度不是 4 的倍数
    expect(terminalOscClipboardWrite('c;////')).toBeNull() // 合法 base64，但解出来不是合法 UTF-8
  })

  it('没有分号的载荷不认——那不是 OSC 52 的形状', () => {
    expect(terminalOscClipboardWrite('aGVsbG8=')).toBeNull()
  })

  it('长载荷里内嵌的空白不影响解析', () => {
    const encoded = body('hello').slice(2)
    expect(terminalOscClipboardWrite(`c;${encoded.slice(0, 4)}\n${encoded.slice(4)}`))
      .toEqual({ text: 'hello' })
  })

  it('体积上限就是 128KiB 整帧，不是别的数——这个值本身有人守', () => {
    // 直接钉住字面量。若只用 MAX 去构造样本，样本会跟着常量一起漂：实测把上限改成 256KiB，那样的
    // 测试 15 条全绿（越界样本自己也变大了，照旧越界）。这是「期望值不能由被测对象算出」的形状。
    expect(TERMINAL_OSC_CLIPBOARD_MAX_PAYLOAD).toBe(131072)
  })

  it('超过体积上限直接拒，不进 base64 解码', () => {
    // 载荷必须是**合法 base64 且长度 %4===0**，否则拒它的是字母表/补齐那两道门，不是体积上限——
    // 实测用 `'A'.repeat(MAX+1)`（长度 %4===1）时，把整道体积上限删掉 15 条照旧全绿。
    // 'QUJD' 是 'ABC' 的 base64，重复它得到的仍是合法 base64。长度写死 131072（= 上一条钉住的
    // 128KiB），不用 MAX 算：用 MAX 算的话上限被改大时样本一起变大，这条会假绿。
    const huge = 'QUJD'.repeat(32768) // 131072 字符
    expect(huge.length).toBe(131072)
    // 上限量的是**整帧**（选区 + `;` + base64），所以 `c;` 这两个字符也算：这个载荷本身恰好等于上限，
    // 加上前缀就越界。这一条同时钉住"量整帧"这个口径——若改成只量 body，它就不再越界，本条会红。
    expect(terminalOscClipboardWrite(`c;${huge}`)).toBeNull()
  })

  it('恰好落在上限上的整帧要过——边界是 > 而不是 >=', () => {
    // 需要一个 `data.length` **恰好等于** 131072 的合法帧。直接拼 base64 凑不出来：整帧 131072 时
    // body 是 131070，而 131070 % 4 === 2，不可能是合法 base64。解法是利用实现会先剥空白这一点，
    // 用两个换行把长度补齐：compact 后仍是 131068 个 base64 字符（%4===0）。
    const frame = `c;${'QUJD'.repeat(32767)}\n\n`
    expect(frame.length).toBe(131072) // 恰好等于上限
    // `>` 让它过，`>=` 会拒它。实测把实现改成 `>=` 时本条红，这是这条断言存在的唯一理由。
    expect(terminalOscClipboardWrite(frame)).toEqual({ text: 'ABC'.repeat(32767) })
  })
})

/**
 * 一个只实现 `parser.registerOscHandler` 的假终端。
 *
 * 为什么要它：上面那组测的是「载荷解析对不对」，而缺陷的另一半是「handler 有没有装上、replay 时
 * 有没有闸住」。只测纯函数的话，把 registerOscHandler(52, ...) 整段删掉，前面每一条照旧全绿。
 */
function fakeTerminal() {
  const handlers = new Map<number, (data: string) => boolean>()
  const disposed: number[] = []
  return {
    handlers,
    disposed,
    terminal: {
      // 主题要给真颜色：`terminalOscColorQueryReply` 取不到色值时不回送，空 theme 会让
      // 「颜色查询会回送」那条对照分支自己不成立，从而掩盖它想证明的事。
      options: { theme: { foreground: '#ffffff', background: '#282c34' } },
      parser: {
        registerOscHandler(ident: number, handler: (data: string) => boolean) {
          handlers.set(ident, handler)
          return { dispose: () => disposed.push(ident) }
        }
      }
    } as never
  }
}

describe('OSC 52 的接线', () => {
  it('52 永远不回送任何字节给 PTY——这才是防剪贴板外泄的那道守卫', () => {
    // 这一条守的是结构性质，不是某一道 if：只要 52 的 handler 拿不到回送通道，读请求就无法把
    // 用户剪贴板送进 PTY。用行为断言而不是源码文本，因为「有没有 sendInput 这个词」证明不了
    // 它有没有被调用。
    const fake = fakeTerminal()
    const sendInput = vi.fn()
    installTerminalOscHandlers(fake.terminal, {
      // respondFromRenderer: true 是刻意的——让 10/11 处在**会**回送的配置下，
      // 从而证明 52 的沉默不是因为整个入口都不回送。
      isReplaying: () => false,
      respondFromRenderer: true,
      sendInput,
      writeClipboard: () => {}
    })
    for (const payload of ['c;?', 's;?', 'p;?', body('written'), 'c;', 'c;garbage!!']) {
      fake.handlers.get(52)!(payload)
    }
    expect(sendInput, '52 的任何形态都不许往 PTY 回送字节').not.toHaveBeenCalled()
    // 对照：同一个入口装的颜色查询**会**回送。少了这一条，上面那句可能只是因为
    // sendInput 在这套配置下压根没接通。
    fake.handlers.get(11)!('?')
    expect(sendInput).toHaveBeenCalledTimes(1)
  })

  it('装上 52 的 handler，把解出的文本交给剪贴板出口', () => {
    const fake = fakeTerminal()
    const writeClipboard = vi.fn()
    installTerminalOscHandlers(fake.terminal, {
      isReplaying: () => false,
      respondFromRenderer: true,
      sendInput: () => {},
      writeClipboard
    })
    expect(fake.handlers.has(52), '52 没有注册——xterm 5.5.0 自己不认它，不装就是没有这个能力')
      .toBe(true)
    expect(fake.handlers.get(52)!(body('copied'))).toBe(true)
    expect(writeClipboard).toHaveBeenCalledWith('copied')
  })

  it('重放留存输出时不写剪贴板——历史里的 OSC 不许劫持用户当下的剪贴板', () => {
    const fake = fakeTerminal()
    const writeClipboard = vi.fn()
    let replaying = true
    installTerminalOscHandlers(fake.terminal, {
      isReplaying: () => replaying,
      respondFromRenderer: true,
      sendInput: () => {},
      writeClipboard
    })
    expect(fake.handlers.get(52)!(body('from history'))).toBe(true)
    expect(writeClipboard, '重放期间不许写剪贴板').not.toHaveBeenCalled()
    // 对照：闸门抬起后同一帧会写。证明上面那次没写是 isReplaying 挣来的，不是 handler 压根不工作。
    replaying = false
    fake.handlers.get(52)!(body('live'))
    expect(writeClipboard).toHaveBeenCalledWith('live')
  })

  it('即使不写剪贴板也要返回 true，否则载荷会被画到屏幕上', () => {
    const fake = fakeTerminal()
    installTerminalOscHandlers(fake.terminal, {
      isReplaying: () => true,
      respondFromRenderer: true,
      sendInput: () => {},
      writeClipboard: () => {}
    })
    // 读请求、重放期、坏 base64 三种都必须「已消费」。返回 false 会让 xterm 当未知序列处理。
    expect(fake.handlers.get(52)!('c;?')).toBe(true)
    expect(fake.handlers.get(52)!('c;garbage!!')).toBe(true)
  })

  it('不给 writeClipboard 就不装 52——不留一个什么都不做的 handler 吞掉序列', () => {
    const fake = fakeTerminal()
    installTerminalOscHandlers(fake.terminal, {
      isReplaying: () => false,
      respondFromRenderer: true,
      sendInput: () => {}
    })
    expect(fake.handlers.has(52)).toBe(false)
    // 颜色查询照旧装上：52 缺席不影响这个入口原本的职责。
    expect(fake.handlers.has(10)).toBe(true)
    expect(fake.handlers.has(11)).toBe(true)
  })

  it('dispose 把 52 一起摘掉', () => {
    const fake = fakeTerminal()
    installTerminalOscHandlers(fake.terminal, {
      isReplaying: () => false,
      respondFromRenderer: true,
      sendInput: () => {},
      writeClipboard: () => {}
    }).dispose()
    expect(fake.disposed).toEqual([10, 11, 52])
  })
})
