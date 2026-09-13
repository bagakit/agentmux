import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isVanishedAgentRunError } from '../src/renderer/src/lib/terminal-attach-recovery.js'

describe('terminal attach recovery', () => {
  it('recognizes a vanished Run without treating it as a terminal attach failure', () => {
    expect(isVanishedAgentRunError({ code: 'CTXMUX_run_not_found', message: 'Run is gone' })).toBe(true)
    expect(isVanishedAgentRunError(new Error('AgentMuxError: Run bf96 does not exist'))).toBe(true)
    expect(isVanishedAgentRunError(new Error('Provider executable is unavailable'))).toBe(false)
  })

  it('routes the production attach catch through Session recovery', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/renderer/src/components/TerminalView.tsx'), 'utf8')
    expect(source).toContain('isVanishedAgentRunError(error)')
    expect(source).toContain('recoverSession(session.id)')
  })
})
