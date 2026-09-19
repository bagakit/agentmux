import { Terminal as NativeTerminal } from '@xterm/xterm/lib/xterm.mjs'
import type { ITerminalOptions } from '@xterm/xterm'
export const Terminal = function (options?: ITerminalOptions) { const t = new NativeTerminal(options); (window as any).terminals.push(t); return t } as unknown as typeof import('@xterm/xterm').Terminal
