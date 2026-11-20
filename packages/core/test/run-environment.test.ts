import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunSpec } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'

afterEach(() => vi.unstubAllEnvs())

describe('local Run environment', () => {
  it('prepares current exports for each start, with explicit Run overrides authoritative', async () => {
    vi.stubEnv('AGENTMUX_TEST_ENV', 'before-daemon')
    vi.stubEnv('NO_COLOR', '1')
    vi.stubEnv('FORCE_COLOR', '0')
    vi.stubEnv('CI', 'true')
    vi.stubEnv('CODEX_CI', '1')
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1')
    vi.stubEnv('TMUX', 'outer-multiplexer')
    vi.stubEnv('KITTY_WINDOW_ID', '17')
    const client = new AgentMuxClient()
    const prepare = async (env: Record<string, string> = {}): Promise<RunSpec> => {
      const prepared = await client.prepareTerminal({ workspacePath: fixturePath('temporary'), command: '/bin/sh', env })
      return JSON.parse(prepared.launch).request
    }
    try {
      vi.stubEnv('AGENTMUX_TEST_ENV', 'after-daemon')
      const initial = await prepare({ NO_COLOR: '1', FORCE_COLOR: '0', CLICOLOR: '0' })
      vi.stubEnv('AGENTMUX_TEST_ENV', 'changed-again')
      const current = await prepare({ AGENTMUX_TEST_OVERRIDE: 'run', EMPTY: '' })
      vi.stubEnv('AGENTMUX_TEST_OVERRIDE', 'inherited')
      const explicit = await prepare({ AGENTMUX_TEST_OVERRIDE: 'explicit', TMUX: 'explicit-multiplexer' })
      expect(initial.env.AGENTMUX_TEST_ENV).toBe('after-daemon')
      expect(current.env.AGENTMUX_TEST_ENV).toBe('changed-again')
      expect(explicit.env.AGENTMUX_TEST_OVERRIDE).toBe('explicit')
      for (const key of ['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CI', 'CODEX_CI', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'TMUX', 'KITTY_WINDOW_ID']) {
        expect(initial.env[key]).toBeUndefined()
      }
      expect(explicit.env.TMUX).toBe('explicit-multiplexer')
      expect(initial.env.TERM).toBe('xterm-256color')
      expect(initial.env.TERM_PROGRAM).toBe('AgentMux-Kitty')
      expect(current.env.AGENTMUX_TEST_OVERRIDE).toBe('run')
      expect(current.env.EMPTY).toBe('')
      expect(initial.program).toBe('/usr/bin/env')
      expect(initial.args.slice(-2)).toEqual(['--', '/bin/sh'])
      // Actual daemon inheritance is verified in long-lived-runtime-environment.integration.test.ts;
      // execFile({ env: captured.env }) replaces the whole environment and cannot prove that contract.
    } finally {
      await client.dispose()
    }
  })
})
