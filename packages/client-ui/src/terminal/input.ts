import type { AgentMuxAgentWriteInput, AgentMuxRunInputData } from '@agentmux/core'

/**
 * 旧式鼠标上报的字节，从 latin1 语义的字符串还原成 Uint8Array。
 *
 * xterm 有两个输入事件源：SGR 编码（程序开了 DECSET ?1006）的上报是 ASCII，走
 * `triggerDataEvent → onData`；而只开了旧式协议（?1000/?1002/?1003 或 ?9 而没开 ?1006）时，
 * 坐标字节可能 ≥128，为了不被 UTF-8 破坏，xterm 走 `triggerBinaryEvent → onBinary`，送出的
 * 字符串是 **latin1 语义**——每个 char code 就是一个字节（见 @xterm/xterm CoreService，实读坐实）。
 *
 * 关键：这条字节**不能**再当文本经 UTF-8 编码上线。实测 ctxmux SDK 的入站编码是
 * `typeof data === 'string' ? new TextEncoder().encode(data) : data`——字符串走 UTF-8、
 * Uint8Array 原样透传。若把 0x80 这种 latin1 字节当字符串上线，UTF-8 会把它拆成 0xC2 0x80，
 * 坐标就毁了、而且凭空多一个字节。所以这里在源头就编成字节，让它以 Uint8Array 的身份透传。
 */
export function encodeTerminalBinaryInput(report: string): Uint8Array {
  return Uint8Array.from(report, (ch) => ch.charCodeAt(0) & 0xff)
}

/**
 * 终端的两个输入事件源。抽成接口是为了让下面的接线**跑得到、断言得着**——它本来长在 attach
 * effect 里，本仓跑不了 effect（renderToStaticMarkup 对 effect 完全失明），删掉 onBinary 订阅
 * 不会让任何断言变红。
 */
export type TerminalInputEventSource = {
  onUserInput: (listener: () => void) => { dispose(): void }
  onData: (listener: (data: string) => void) => { dispose(): void }
  onBinary: (listener: (data: string) => void) => { dispose(): void }
}

/**
 * 把两个输入事件源接到**同一个** `send` 出口。
 *
 * onData 与 onBinary 是同一件事（用户输入）的两个编码面，必须共用同一把 accepts 闸——就是
 * 调用方传进来的那个 `terminalInputSender({ accepts, write })`。绝不给 onBinary 复制第二份判据、
 * 也绝不给它开第二个 write 出口：那样 accepts 的极性就有了第二个说法，下一次改闸必漏一处。
 *
 * 差别只在编码，且只发生在**源头**：onData 是合法文本（键盘、SGR 鼠标上报都是 ASCII/Unicode），
 * 原样交给 send 走 UTF-8；onBinary 是 latin1 字节，先 `encodeTerminalBinaryInput` 成 Uint8Array
 * 再交给 send，从而以字节身份透传、不被 UTF-8 二次编码毁掉坐标。
 *
 * 返回一个合并的 disposable：两个订阅都挂在它上面，cleanup 里一次 dispose 跟上 onData 原来那条
 * 清理路径，绝不各自散落。
 */
export function subscribeTerminalInput(
  source: TerminalInputEventSource,
  send: (data: AgentMuxRunInputData, source: AgentMuxAgentWriteInput['source']) => void
): { dispose(): void } {
  // xterm emits its existing user-input fact immediately before onData, including
  // asynchronous IME text. Parser-generated DA/DSR and focus replies do not emit it.
  let userInput = false
  const user = source.onUserInput(() => { userInput = true })
  const data = source.onData((report) => {
    const origin = userInput ? 'user' : 'terminal-protocol'
    userInput = false
    send(report, origin)
  })
  // xterm's binary channel carries legacy mouse reports, not parser replies.
  const binary = source.onBinary((report) => send(encodeTerminalBinaryInput(report), 'user'))
  return {
    dispose() {
      user.dispose()
      data.dispose()
      binary.dispose()
    }
  }
}

