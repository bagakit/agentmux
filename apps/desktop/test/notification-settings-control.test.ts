import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => { const { tmpdir } = await import('node:os'); return { app: { getPath: () => tmpdir() } } })
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { resolveNotificationModeId, resolveNotificationSound } from '../src/shared/notification-presentation.js'
import { a2aNotificationPresentation } from '../src/shared/a2a-preferences.js'

it('the executable settings CLI discovers and saves banner preferences through the public socket and isolated durable ConfigOwner', async () => {
  const f = await configOwnerFixture(), before = f.owner.current
  const server = new AgentMuxControlServer({ execute: request => executeSettingsControl(request as never, f.owner) }, join(f.store.filePath, '..', 'control.sock'))
  await server.start()
  try {
    const call = async (parts: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../../../packages/core/bin/amux', import.meta.url)), '--endpoint', `unix:${server.path}`, 'settings', ...parts],
      { timeout: 10000, env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined, AGENTMUX_ENV: undefined } })).stdout).result
    expect((await call(['inspect', 'notifications'])).entries.map((entry: { key: string }) => entry.key)).toEqual(['notifications.mode', 'notifications.sound'])
    expect((await call(['set', 'notifications.mode', 'off'])).entry.value).toBe('off')
    expect((await call(['set', 'notifications.sound', 'true'])).entry.value).toBe(true)
    const saved = await new ConfigStore(f.store.filePath).get()
    expect(resolveNotificationModeId(saved)).toBe('off')
    expect(resolveNotificationSound(saved)).toBe(true)
    expect(a2aNotificationPresentation(saved)).toBeNull()
    expect(saved.a2a).toEqual(before.a2a)
    expect(saved.hosts).toEqual(before.hosts)
    expect((await call(['set', 'notifications.mode', 'patient'])).entry.value).toBe('patient')
    expect((await call(['inspect', 'notifications.mode'])).entries[0].value).toBe('patient')
    const reopened = await new ConfigStore(f.store.filePath).get()
    expect(a2aNotificationPresentation(reopened)).toEqual({ mode: 'patient', sound: true })
    const bytes = await f.bytes()
    await expect(call(['set', 'notifications.mode', 'invalid-tier'])).rejects.toMatchObject({ code: 1 })
    expect(await f.bytes()).toBe(bytes)
  } finally { await server.stop() }
}, 45000)
