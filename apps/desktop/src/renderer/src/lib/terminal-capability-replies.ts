import type { IDisposable, Terminal } from '@xterm/xterm'
import { terminalOscClipboardWrite } from '../../../shared/terminal-osc-clipboard'
import {
  terminalOscColorQueryReply,
  terminalOscColorQuerySlotsForBody
} from '../../../shared/terminal-osc-color-query'

// The main process answers live OSC color queries even when no Renderer is
// attached. Consume the same queries in xterm so replaying retained CtxMux
// output never injects a second answer into the current foreground process.
//
// OSC 52（往剪贴板写）和它共用这一个入口，是因为两者承重的是**同一个** replay 闸门：重放
// CtxMux 留存的输出时，历史里的 OSC 既不该再答一次颜色，也不该劫持用户当下的剪贴板。分成两个
// 安装函数就等于把这个判据做两次，早晚有一处传进不同的 `isReplaying`。
export function installTerminalOscHandlers(
  terminal: Pick<Terminal, 'options' | 'parser'>,
  options: {
    isReplaying: () => boolean
    respondFromRenderer: boolean
    sendInput: (data: string) => void
    /**
     * OSC 52 解析出文本之后往哪写。省略即不安装 52 的 handler——此时 xterm 保持它出厂的行为
     * （压根不认 52），序列作为未知 OSC 被丢掉。
     */
    writeClipboard?: (text: string) => void
  }
): IDisposable {
  const disposables = ([10, 11] as const).map((slot) => terminal.parser.registerOscHandler(
    slot,
    (data) => {
      const slots = terminalOscColorQuerySlotsForBody(slot, data.trim())
      if (!slots) return false
      if (options.respondFromRenderer && !options.isReplaying()) {
        for (const responseSlot of slots) {
          const reply = terminalOscColorQueryReply(terminal.options.theme ?? {}, responseSlot)
          if (reply) options.sendInput(reply)
        }
      }
      return true
    }
  ))
  const writeClipboard = options.writeClipboard
  if (writeClipboard) {
    disposables.push(terminal.parser.registerOscHandler(52, (data) => {
      const write = terminalOscClipboardWrite(data)
      // 返回 true = 「这一帧我处理了」，与是否真的写了剪贴板无关：读请求、坏 base64、不认的选区
      // 都已经被我们消费掉，绝不能落回 xterm 去当未知序列——那会把载荷当普通输出画到屏幕上。
      if (write && !options.isReplaying()) writeClipboard(write.text)
      return true
    }))
  }
  return {
    dispose() {
      for (const disposable of disposables) disposable.dispose()
    }
  }
}
