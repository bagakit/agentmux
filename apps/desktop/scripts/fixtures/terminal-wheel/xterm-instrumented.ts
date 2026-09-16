// Constructor observation only: every parser, mode, encoder and viewport method stays native.
import { Terminal as EsmTerminal } from '@xterm/xterm/lib/xterm.mjs'
import type { ITerminalOptions } from '@xterm/xterm'
declare const __TERMINAL_WHEEL_UMD_URL__: string
let constructor = EsmTerminal as typeof import('@xterm/xterm').Terminal
export async function installUmd(distribution: string): Promise<void> {
  if (distribution === 'esm') { constructor = EsmTerminal; return }
  if (distribution !== 'umd') throw new Error('Unknown distribution')
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = __TERMINAL_WHEEL_UMD_URL__
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Published UMD did not load'))
    document.head.append(script)
  })
  constructor = (window as unknown as { Terminal: typeof import('@xterm/xterm').Terminal }).Terminal
  if (typeof constructor !== 'function') throw new Error('Public UMD Terminal missing')
}
export const Terminal = function (options?: ITerminalOptions) {
  const terminal = new constructor(options)
  ;(window as unknown as { terminals: import('@xterm/xterm').Terminal[] }).terminals.push(terminal)
  return terminal
} as unknown as typeof import('@xterm/xterm').Terminal
