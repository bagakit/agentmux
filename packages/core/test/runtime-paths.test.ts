import { describe, expect, it } from 'vitest'
import {
  defaultAgentMuxRuntimeDirectory,
  defaultCtxmuxSocketPath
} from '../src/runtime-paths.js'

describe('AgentMux runtime paths', () => {
  it.runIf(process.platform === 'darwin')('keeps the CtxMux endpoint below the Darwin Unix socket limit', () => {
    expect(defaultAgentMuxRuntimeDirectory()).toMatch(/^\/private\/tmp\/amx-[^/]+$/u)
    expect(Buffer.byteLength(defaultCtxmuxSocketPath())).toBeLessThan(104)
  })
})
