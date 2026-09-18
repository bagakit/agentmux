import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import type { AppConfig } from '../../src/shared/contracts.js'
import { ConfigStore, DEFAULT_CONFIG } from '../../src/main/config-store.js'
import { ConfigOwner } from '../../src/main/config-owner.js'
import { saveRuntimeConfig } from '../../src/main/runtime-config-transaction.js'
import type { RuntimeController, RuntimePreparation } from '../../src/main/runtime-controller.js'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

/** Real validation and durable writes; only Runtime host preparation is isolated. */
export async function configOwnerFixture(overrides: Partial<AppConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-config-owner-'))
  directories.push(directory)
  const store = new ConfigStore(join(directory, 'agentmux.config.json'))
  let current = await store.save({ ...structuredClone(DEFAULT_CONFIG), ...overrides })
  const preparation: RuntimePreparation = { hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] }
  const runtime = {
    prepare: vi.fn(async () => preparation), commit: vi.fn(), discard: vi.fn(async () => {})
  } as unknown as RuntimeController
  const publish = vi.fn((saved: AppConfig) => { current = saved })
  const save = vi.fn(async (next: AppConfig) => await saveRuntimeConfig({
    runtime, configWriter: store, next: store.validate(next)
  }))
  const owner = new ConfigOwner({ read: () => current, save, publish })
  return { owner, store, save, publish, runtime, bytes: () => readFile(store.filePath, 'utf8'),
    disk: async () => JSON.parse(await readFile(store.filePath, 'utf8')) as AppConfig }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
