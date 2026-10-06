import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { describe, expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { SessionControl } from '../src/shared/contracts.js'

describe('Desktop storage observation preserves original Session authority', () => {
  it('uses only the selected Host and Run and retains unknown observer errors without changing lifecycle', async () => {
    const control: SessionControl = { kind: 'agent', hostId: 'right', agentSessionId: 'original-agent', run: { runId: 'original-run' } }
    const agentSession = vi.fn(() => ({ run: control.run })), stop = vi.fn(), attach = vi.fn()
    const observeRunStorage = vi.fn(async () => ({ status: 'unsupported', run: control.run,
      runtime: { hostId: 'local', instanceId: 'original-runtime', processId: 10, buildIdentity: 'private', protocolVersion: 22 }, observedAt: _reshape_fixtureEpoch(0, 0, 3),
      message: 'Storage metrics are unknown.' }))
    const connectedClient = vi.fn(async () => ({ agentSession, observeRunStorage, stop, attach }))
    const controller = { connectedClient } as unknown as RuntimeController
    const result = await RuntimeController.prototype.observeStorage.call(controller, control)
    expect(connectedClient).toHaveBeenCalledExactlyOnceWith('right', 'runtime')
    expect(agentSession).toHaveBeenCalledExactlyOnceWith('original-agent')
    expect(observeRunStorage).toHaveBeenCalledExactlyOnceWith(control.run)
    expect(result.runtime).toMatchObject({ hostId: 'right', instanceId: 'original-runtime' })
    observeRunStorage.mockRejectedValueOnce(new Error('Original storage owner unavailable'))
    await expect(RuntimeController.prototype.observeStorage.call(controller, control)).rejects.toThrow('Original storage owner unavailable')
    expect(stop).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled()
  })

  it('rejects a stale Agent binding and conflicting Terminal identities without retargeting', async () => {
    const observeRunStorage = vi.fn(), connectedClient = vi.fn(async () => ({
      agentSession: vi.fn(() => ({ run: { runId: 'replacement-run' } })), observeRunStorage
    }))
    const controller = { connectedClient } as unknown as RuntimeController
    await expect(RuntimeController.prototype.observeStorage.call(controller, {
      kind: 'agent', hostId: 'right', agentSessionId: 'original-agent', run: { runId: 'original-run' }
    })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION_BINDING' })
    expect(observeRunStorage).not.toHaveBeenCalled(); connectedClient.mockClear()
    await expect(RuntimeController.prototype.observeStorage.call(controller, {
      kind: 'terminal', hostId: 'right', runId: 'foreign-run', run: { runId: 'original-run' }
    })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(connectedClient).not.toHaveBeenCalled(); expect(observeRunStorage).not.toHaveBeenCalled()
  })
})
