import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultAgentMuxRuntimeDirectory,
  defaultCtxmuxSocketPath
} from '../src/runtime-paths.js'

describe('AgentMux runtime paths', () => {
  const originalRuntimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY

  afterEach(() => {
    if (originalRuntimeDirectory === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    else process.env.AGENTMUX_RUNTIME_DIRECTORY = originalRuntimeDirectory
  })

  it.runIf(process.platform === 'darwin')('keeps the CtxMux endpoint below the Darwin Unix socket limit', () => {
    delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    expect(defaultAgentMuxRuntimeDirectory()).toMatch(/^\/private\/tmp\/amx-[^/]+$/u)
    expect(Buffer.byteLength(defaultCtxmuxSocketPath())).toBeLessThan(104)
  })

  it('supports an absolute isolated runtime root for packaging and parallel clients', () => {
    process.env.AGENTMUX_RUNTIME_DIRECTORY = '/private/tmp/agentmux-isolated-runtime/../runtime'

    expect(defaultAgentMuxRuntimeDirectory()).toBe('/private/tmp/runtime')
    expect(defaultCtxmuxSocketPath()).toBe('/private/tmp/runtime/ctxmux.sock')
  })

  it('rejects relative runtime root overrides', () => {
    process.env.AGENTMUX_RUNTIME_DIRECTORY = 'relative/runtime'

    expect(() => defaultAgentMuxRuntimeDirectory()).toThrow(
      'AGENTMUX_RUNTIME_DIRECTORY must be an absolute path.'
    )
  })
})
