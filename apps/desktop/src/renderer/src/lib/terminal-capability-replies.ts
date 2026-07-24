import type { IDisposable, Terminal } from '@xterm/xterm'
import {
  terminalOscColorQueryReply,
  terminalOscColorQuerySlotsForBody
} from '../../../shared/terminal-osc-color-query'

// The main process answers live OSC color queries even when no Renderer is
// attached. Consume the same queries in xterm so replaying retained CtxMux
// output never injects a second answer into the current foreground process.
export function installTerminalColorQueryReplyHandlers(
  terminal: Pick<Terminal, 'options' | 'parser'>,
  options: {
    isReplaying: () => boolean
    respondFromRenderer: boolean
    sendInput: (data: string) => void
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
  return {
    dispose() {
      for (const disposable of disposables) disposable.dispose()
    }
  }
}
