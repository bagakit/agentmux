import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CtxmuxClient, RunSpec } from '@ctxmux/sdk'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { AgentMuxClient } from '../src/client.js'

const exec = promisify(execFile)
afterEach(() => vi.unstubAllEnvs())

describe('local Run environment', () => {
  it('sends current exports on every start, with explicit Run overrides authoritative', async () => {
    const adapter = new CtxmuxRunAdapter()
    const captured: RunSpec[] = []
    const start = vi.fn(async (spec: RunSpec) => {
      captured.push(spec)
      throw new Error('captured at SDK boundary')
    })
    ;(adapter as unknown as { client: Pick<CtxmuxClient, 'start'> }).client = { start }
    vi.stubEnv('AGENTMUX_TEST_ENV', 'before-daemon')
    vi.stubEnv('NO_COLOR', '1')
    vi.stubEnv('FORCE_COLOR', '0')
    vi.stubEnv('CI', 'true')
    vi.stubEnv('CODEX_CI', '1')
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1')
    // Only the wire is replaced. AgentMuxClient → adapter → SDK Run spec is the production path.
    const client = new AgentMuxClient()
    Object.assign(client, { kernel: adapter, connected: true })
    try {
      vi.stubEnv('AGENTMUX_TEST_ENV', 'after-daemon')
      await expect(client.createTerminal({ workspacePath: '/tmp', command: '/bin/sh', env: {
        NO_COLOR: '1', FORCE_COLOR: '0', CLICOLOR: '0'
      } }))
        .rejects.toThrow('captured at SDK boundary')
      vi.stubEnv('AGENTMUX_TEST_ENV', 'changed-again')
      await expect(client.createTerminal({ workspacePath: '/tmp', command: '/bin/sh', env: { AGENTMUX_TEST_OVERRIDE: 'run', EMPTY: '' } }))
        .rejects.toThrow('captured at SDK boundary')
      vi.stubEnv('AGENTMUX_TEST_OVERRIDE', 'inherited')
      await expect(client.createTerminal({ workspacePath: '/tmp', command: '/bin/sh', env: { AGENTMUX_TEST_OVERRIDE: 'explicit' } }))
        .rejects.toThrow('captured at SDK boundary')
      expect(captured[0]!.env.AGENTMUX_TEST_ENV).toBe('after-daemon')
      expect(captured[1]!.env.AGENTMUX_TEST_ENV).toBe('changed-again')
      expect(captured[2]!.env.AGENTMUX_TEST_OVERRIDE).toBe('explicit')
      expect(captured[0]!.env.NO_COLOR).toBeUndefined()
      expect(captured[0]!.env.FORCE_COLOR).toBeUndefined()
      expect(captured[0]!.env.CLICOLOR).toBeUndefined()
      expect(captured[0]!.env.CI).toBeUndefined()
      expect(captured[0]!.env.CODEX_CI).toBeUndefined()
      expect(captured[0]!.env.CLAUDECODE).toBeUndefined()
      expect(captured[0]!.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
      expect(captured[0]!.env.TERM_PROGRAM).toBe('AgentMux')
      const child = await exec(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.AGENTMUX_TEST_ENV, process.env.AGENTMUX_TEST_OVERRIDE, process.env.EMPTY]))'], { env: captured[1]!.env })
      expect(JSON.parse(child.stdout)).toEqual(['changed-again', 'run', ''])
    } finally {
      Object.assign(adapter, { client: null })
      await client.dispose()
    }
  })
})
