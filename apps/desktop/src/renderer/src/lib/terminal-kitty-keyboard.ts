import type { Terminal } from '@xterm/xterm'

// The Kitty protocol gives the terminal a bounded stack per screen and evicts its oldest entry.
const KITTY_KEYBOARD_STACK_LIMIT = 16

export function installTerminalKittyInputMode(terminal: Pick<Terminal, 'buffer' | 'parser'>) {
  const stacks = { normal: [] as number[], alternate: [] as number[] }
  const activeStack = () => stacks[terminal.buffer.active.type]

  function register(prefix: '>' | '=' | '<', apply: (stack: number[], params: number[]) => void) {
    return terminal.parser.registerCsiHandler({ prefix, final: 'u' }, (params) => {
      if (params.every((param) => typeof param === 'number')) apply(activeStack(), params)
      return true
    })
  }

  // Observe the application's declarations for Shift+Enter. The Core still owns query replies.
  const handlers = [
    register('>', (stack, [flags = 0]) => {
      if (stack.length === KITTY_KEYBOARD_STACK_LIMIT) stack.shift()
      stack.push(flags)
    }),
    register('=', (stack, [flags = 0, mode = 1]) => {
      const index = Math.max(0, stack.length - 1)
      const current = stack[index] ?? 0
      switch (mode || 1) {
        case 1: stack[index] = flags; break
        case 2: stack[index] = current | flags; break
        case 3: stack[index] = current & ~flags; break
      }
    }),
    register('<', (stack, [count]) => {
      // xterm normalizes omitted parameters to zero. Match its native Kitty pop default.
      stack.length = Math.max(0, stack.length - (count || 1))
    }),
    terminal.parser.registerEscHandler({ final: 'c' }, () => {
      stacks.normal.length = 0
      stacks.alternate.length = 0
      return false // Keep xterm's native reset in the handler chain.
    })
  ]

  return {
    isActive: () => (activeStack().at(-1) ?? 0) > 0,
    dispose: () => {
      for (const handler of handlers) handler.dispose()
    }
  }
}
