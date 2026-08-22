import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('keeps executor avatar customization across a fresh ConfigStore instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'avatar-config-')); roots.push(root)
  const path = join(root, 'config.json')
  const avatars = { codex: { tint: '#ee7755', badge: 'spark' as const }, review: { tint: '#6688dd', badge: 'shield' as const } }
  const store = new ConfigStore(path)
  await store.save({ ...DEFAULT_CONFIG, executors: {
    ...DEFAULT_CONFIG.executors,
    codex: { ...DEFAULT_CONFIG.executors.codex!, avatar: avatars.codex },
    review: { ...DEFAULT_CONFIG.executors.codex!, label: 'Review', avatar: avatars.review }
  } })
  const restored = await new ConfigStore(path).get()
  expect(restored.executors.codex?.avatar).toEqual(avatars.codex)
  expect(restored.executors.review?.avatar).toEqual(avatars.review)
  expect(restored.executors.review?.providerId).toBe(restored.executors.codex?.providerId)
  await store.save({ ...restored, executors: { ...restored.executors, codex: DEFAULT_CONFIG.executors.codex! } })
  const reset = await new ConfigStore(path).get()
  expect(reset.executors.codex?.avatar).toBeUndefined()
  expect(reset.executors.review?.avatar).toEqual(avatars.review)
})
it('retains a legacy Appearance avatar while the Executor settings surface is adopted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'avatar-config-')); roots.push(root)
  const path = join(root, 'config.json')
  const legacy = {
    ...DEFAULT_CONFIG,
    appearance: { ...DEFAULT_CONFIG.appearance, agentAvatars: { codex: { tint: '#ee7755', badge: 'spark' } } }
  }
  await writeFile(path, `${JSON.stringify(legacy)}\n`)
  const restored = await new ConfigStore(path).get()
  expect(restored.appearance.agentAvatars?.codex).toEqual({ tint: '#ee7755', badge: 'spark' })
  const rewritten = JSON.parse(await readFile(path, 'utf8')) as typeof legacy
  expect(rewritten.appearance.agentAvatars?.codex).toEqual({ tint: '#ee7755', badge: 'spark' })
})
it('retains an orphaned legacy avatar instead of guessing a new Executor owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'avatar-config-')); roots.push(root)
  const path = join(root, 'config.json')
  const legacy = {
    ...DEFAULT_CONFIG,
    appearance: { ...DEFAULT_CONFIG.appearance, agentAvatars: { retired: { tint: '#ee7755', badge: 'spark' } } }
  }
  const bytes = `${JSON.stringify(legacy)}\n`
  await writeFile(path, bytes)
  const restored = await new ConfigStore(path).get()
  expect(restored.appearance.agentAvatars?.retired).toEqual({ tint: '#ee7755', badge: 'spark' })
  const persisted = JSON.parse(await readFile(path, 'utf8')) as typeof legacy
  expect(persisted.appearance.agentAvatars?.retired).toEqual({ tint: '#ee7755', badge: 'spark' })
})
it.each([{ tint: 'red; display:none' }, { badge: 'custom-text' }])('rejects malformed avatar customization %j without overwriting durable settings', async (avatar) => {
  const root = await mkdtemp(join(tmpdir(), 'avatar-config-')); roots.push(root)
  const path = join(root, 'config.json')
  const store = new ConfigStore(path)
  await store.save(DEFAULT_CONFIG)
  await expect(store.save({ ...DEFAULT_CONFIG, executors: { ...DEFAULT_CONFIG.executors, codex: { ...DEFAULT_CONFIG.executors.codex!, avatar: avatar as never } } })).rejects.toThrow()
  expect((await new ConfigStore(path).get()).executors.codex?.avatar).toBeUndefined()
})
