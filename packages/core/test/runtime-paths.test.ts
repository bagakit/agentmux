import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultAgentMuxRuntimeDirectory,
  defaultAgentMuxStateDirectory,
  defaultCtxmuxSocketPath,
  defaultCtxmuxStateDirectory,
  defaultAgentMuxControlSocketPath
} from '../src/runtime-paths.js'

describe('AgentMux runtime paths', () => {
  const originalRuntimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY
  const originalStateDirectory = process.env.AGENTMUX_STATE_DIRECTORY

  afterEach(() => {
    if (originalRuntimeDirectory === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    else process.env.AGENTMUX_RUNTIME_DIRECTORY = originalRuntimeDirectory
    if (originalStateDirectory === undefined) delete process.env.AGENTMUX_STATE_DIRECTORY
    else process.env.AGENTMUX_STATE_DIRECTORY = originalStateDirectory
  })

  it('keeps the deployed short endpoint namespace and a separate user durable namespace', () => {
    delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    delete process.env.AGENTMUX_STATE_DIRECTORY
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
    const runtimeRoot = join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(),
      `amx-${uid}-1e19b1caf5c6ddd1aa8b5cac`)
    const stateRoot = join(homedir(), '.agentmux', 'state', `amx-${uid}-1e19b1caf5c6ddd1aa8b5cac`)
    expect([defaultAgentMuxRuntimeDirectory(), defaultAgentMuxStateDirectory(), defaultCtxmuxSocketPath(),
      defaultCtxmuxStateDirectory(), defaultAgentMuxControlSocketPath()]).toEqual([
      runtimeRoot, stateRoot, join(runtimeRoot, 'ctxmux.sock'), join(stateRoot, 'ctxmux'),
      join(runtimeRoot, 'control.sock')
    ])
  })

  it.runIf(process.platform === 'darwin')('keeps the CtxMux endpoint below the Darwin Unix socket limit', () => {
    delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    expect(defaultAgentMuxRuntimeDirectory()).toMatch(/^\/private\/tmp\/amx-[^/]+$/u)
    expect(Buffer.byteLength(defaultCtxmuxSocketPath())).toBeLessThan(104)
  })

  it('supports an absolute isolated runtime root for packaging and parallel clients', () => {
    process.env.AGENTMUX_RUNTIME_DIRECTORY = '/tmp/agentmux-isolated-runtime/../runtime'

    expect(defaultAgentMuxRuntimeDirectory()).toBe('/tmp/runtime')
    expect(defaultCtxmuxSocketPath()).toBe('/tmp/runtime/ctxmux.sock')
  })

  it('rejects relative runtime root overrides', () => {
    process.env.AGENTMUX_RUNTIME_DIRECTORY = 'relative/runtime'

    expect(() => defaultAgentMuxRuntimeDirectory()).toThrow(
      'AGENTMUX_RUNTIME_DIRECTORY must be an absolute path.'
    )
  })

  it('selects independent absolute state and endpoint roots without inferring one from the other', () => {
    process.env.AGENTMUX_STATE_DIRECTORY = '/tmp/private-state/../durable'
    process.env.AGENTMUX_RUNTIME_DIRECTORY = '/tmp/private-endpoints'
    expect(defaultAgentMuxStateDirectory()).toBe('/tmp/durable')
    expect(defaultCtxmuxStateDirectory()).toBe('/tmp/durable/ctxmux')
    expect(defaultCtxmuxSocketPath()).toBe('/tmp/private-endpoints/ctxmux.sock')
    delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    expect(defaultCtxmuxStateDirectory()).toBe('/tmp/durable/ctxmux')
  })

  it('rejects a relative state override', () => {
    process.env.AGENTMUX_STATE_DIRECTORY = 'relative/state'
    expect(() => defaultAgentMuxStateDirectory()).toThrow('AGENTMUX_STATE_DIRECTORY must be an absolute path.')
  })
})
