import { Terminal as NativeTerminal } from '@xterm/xterm/lib/xterm.mjs'
import type { ITerminalOptions } from '@xterm/xterm'
// Observe native constructor/disposal without replacing parsing, options, buffers or input.
export const Terminal = function (options?: ITerminalOptions) {
  const terminal = new NativeTerminal(options)
  const proof = (window as any).terminalThemeProof
  proof.terminals.push(terminal)
  const dispose = terminal.dispose.bind(terminal)
  terminal.dispose = () => { proof.disposals++; dispose() }
  return terminal
} as unknown as typeof import('@xterm/xterm').Terminal
