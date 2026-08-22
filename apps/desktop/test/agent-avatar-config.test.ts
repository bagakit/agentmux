import { mkdtemp, rm } from 'node:fs/promises'
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
  await store.save({ ...DEFAULT_CONFIG, executors: { ...DEFAULT_CONFIG.executors, review: { ...DEFAULT_CONFIG.executors.codex!, label: 'Review' } },
    appearance: { ...DEFAULT_CONFIG.appearance, agentAvatars: avatars } })
  const restored = await new ConfigStore(path).get()
  expect(restored.appearance.agentAvatars).toEqual(avatars)
  expect(restored.executors.review?.providerId).toBe(restored.executors.codex?.providerId)
  await store.save({ ...restored, appearance: { ...restored.appearance, agentAvatars: { review: avatars.review } } })
  expect((await new ConfigStore(path).get()).appearance.agentAvatars).toEqual({ review: avatars.review })
})
it.each([{ tint: 'red; display:none' }, { badge: 'custom-text' }])('rejects malformed avatar customization %j without overwriting durable settings', async (avatar) => {
  const root = await mkdtemp(join(tmpdir(), 'avatar-config-')); roots.push(root)
  const path = join(root, 'config.json')
  const store = new ConfigStore(path)
  await store.save(DEFAULT_CONFIG)
  await expect(store.save({ ...DEFAULT_CONFIG, appearance: { ...DEFAULT_CONFIG.appearance, agentAvatars: { codex: avatar } } })).rejects.toThrow()
  expect((await new ConfigStore(path).get()).appearance.agentAvatars).toBeUndefined()
})
