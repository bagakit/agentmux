import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CTXMUX_MANIFEST_SHA256,
  defaultAgentMuxRuntimeDirectory,
  defaultCtxmuxSocketPath
} from '../src/runtime-paths.js'

describe('AgentMux runtime paths', () => {
  const originalRuntimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY

  afterEach(() => {
    if (originalRuntimeDirectory === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    else process.env.AGENTMUX_RUNTIME_DIRECTORY = originalRuntimeDirectory
  })

  it('derives the CtxMux endpoint from the pinned artifact manifest so a version bump claims a fresh socket root', () => {
    delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    // These literals must move together with the pinned CtxMux artifact. The endpoint id is the
    // first 24 hex chars of sha256(pinned manifest sha); if a manifest bump leaves the endpoint
    // stale, a fresh build collides with the previous version's detached daemon on the same
    // socket, fails owner-receipt verification, and takes the app down via app.exit(1). Bumping
    // the manifest sha makes the endpoint assertions below go red on purpose — forcing whoever
    // bumps the artifact to re-pin the endpoint here and confirm the version isolation is intended.
    expect(CTXMUX_MANIFEST_SHA256).toBe(
      '1dfe2c94d089a5ba4248c34abbeccbc61300e59308bcb6c3e96967503fee4711'
    )
    const expectedRuntimeId = '1e19b1caf5c6ddd1aa8b5cac'
    expect(createHash('sha256').update(CTXMUX_MANIFEST_SHA256).digest('hex').slice(0, 24)).toBe(
      expectedRuntimeId
    )
    expect(defaultAgentMuxRuntimeDirectory().endsWith(`-${expectedRuntimeId}`)).toBe(true)
    expect(defaultCtxmuxSocketPath().endsWith(`-${expectedRuntimeId}/ctxmux.sock`)).toBe(true)
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
