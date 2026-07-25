import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import type { RuntimeController, RuntimePreparation } from '../src/main/runtime-controller.js'
import { saveRuntimeConfig } from '../src/main/runtime-config-transaction.js'

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function runtimeFixture(overrides: Partial<RuntimeController> = {}) {
  const preparation = {
    hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: []
  } as RuntimePreparation
  const runtime = {
    prepare: vi.fn(async () => preparation),
    commit: vi.fn(),
    discard: vi.fn(async () => {}),
    ...overrides
  } as unknown as RuntimeController
  return { runtime, preparation }
}

describe('Runtime config transaction', () => {
  it('does not persist config when Runtime preparation fails', async () => {
    const { runtime } = runtimeFixture({
      prepare: vi.fn(async () => { throw new Error('discovery failed') })
    })
    const configWriter = { save: vi.fn(async () => config) }

    await expect(saveRuntimeConfig({ runtime, configWriter, next: config })).rejects.toThrow('discovery failed')
    expect(configWriter.save).not.toHaveBeenCalled()
  })

  it('discards prepared hosts when persistence fails', async () => {
    const { runtime, preparation } = runtimeFixture()
    const configWriter = { save: vi.fn(async () => { throw new Error('disk failed') }) }

    await expect(saveRuntimeConfig({ runtime, configWriter, next: config })).rejects.toThrow('disk failed')
    expect(runtime.discard).toHaveBeenCalledWith(preparation)
    expect(runtime.commit).not.toHaveBeenCalled()
  })

  it('commits only after persistence succeeds', async () => {
    const { runtime, preparation } = runtimeFixture()
    const saved = structuredClone(config)
    const configWriter = { save: vi.fn(async () => saved) }

    await expect(saveRuntimeConfig({ runtime, configWriter, next: config })).resolves.toBe(saved)
    expect(runtime.commit).toHaveBeenCalledWith(preparation)
    expect(runtime.discard).not.toHaveBeenCalled()
    expect(configWriter.save.mock.invocationCallOrder[0]).toBeLessThan(runtime.commit.mock.invocationCallOrder[0]!)
  })
})
