import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultAgentMuxRuntimeDirectory,
  defaultCtxmuxSocketPath,
  defaultCtxmuxStateDirectory,
  defaultAgentMuxControlSocketPath
} from '../src/runtime-paths.js'

describe('AgentMux runtime paths', () => {
  const originalRuntimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY

  afterEach(() => {
    if (originalRuntimeDirectory === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    else process.env.AGENTMUX_RUNTIME_DIRECTORY = originalRuntimeDirectory
  })

  it('keeps the deployed Runtime namespace for its listener, state and control channel', () => {
    delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
    const runtimeRoot = join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(),
      `amx-${uid}-1e19b1caf5c6ddd1aa8b5cac`)
    expect([defaultAgentMuxRuntimeDirectory(), defaultCtxmuxSocketPath(),
      defaultCtxmuxStateDirectory(), defaultAgentMuxControlSocketPath()]).toEqual([
      runtimeRoot, join(runtimeRoot, 'ctxmux.sock'), join(runtimeRoot, 'state'),
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
})
