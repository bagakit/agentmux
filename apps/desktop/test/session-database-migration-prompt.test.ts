import type { BrowserWindow, MessageBoxOptions } from 'electron'
import { mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { describe, expect, it, vi } from 'vitest'
import { offerSessionDatabaseMigration } from '../src/main/session-database-migration-prompt.js'

function fixture(legacy: boolean, response: number) {
  const window = { isDestroyed: () => false } as BrowserWindow
  const dialog = { showMessageBox: vi.fn(async (_window: BrowserWindow, _options: MessageBoxOptions) => ({ response, checkboxChecked: false })) }
  const store = { hasLegacyDatabaseName: vi.fn(async () => legacy), migrateDatabaseName: vi.fn(async () => {}) }
  return { dialog, store, start: () => offerSessionDatabaseMigration(window, dialog, store) }
}

describe('Desktop Session database upgrade prompt', () => {
  it('does not prompt when the database already has its current name', async () => {
    const f = fixture(false, 0)
    await f.start()
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(f.store.migrateDatabaseName).not.toHaveBeenCalled()
  })

  it('prompts for upgrade and preserves the old path when deferred', async () => {
    const f = fixture(true, 1)
    await f.start()
    expect(f.dialog.showMessageBox.mock.calls[0]?.[1].buttons).toEqual(['Upgrade', 'Later'])
    expect(f.store.migrateDatabaseName).not.toHaveBeenCalled()
  })

  it('invokes the original Store when the user approves', async () => {
    const f = fixture(true, 0)
    await f.start()
    expect(f.store.migrateDatabaseName).toHaveBeenCalledTimes(1)
  })

  it('reports an unconfirmed upgrade without retrying it', async () => {
    const f = fixture(true, 0)
    f.store.migrateDatabaseName.mockRejectedValueOnce(new Error('The Store is busy.'))
    await f.start()
    expect(f.store.migrateDatabaseName).toHaveBeenCalledTimes(1)
    expect(f.dialog.showMessageBox.mock.calls[1]?.[1]).toMatchObject({ type: 'warning', detail: 'The Store is busy.' })
  })

  it('leaves an actual legacy store usable when deferred, then migrates it through the upgrade action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-desktop-store-upgrade-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const original = JSON.stringify({ version: 5, sessions: [], reservations: [], retiredRuns: [], retiredAgentSessions: [] })
      await writeFile(path, original, { mode: 0o600 })
      const store = new AgentMuxFileAgentSessionStore(path)
      const window = { isDestroyed: () => false } as BrowserWindow
      const showMessageBox = vi.fn<Parameters<typeof offerSessionDatabaseMigration>[1]['showMessageBox']>()
      showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })

      await offerSessionDatabaseMigration(window, { showMessageBox }, store)
      await expect(readFile(path, 'utf8')).resolves.toBe(original)
      await expect(store.load()).resolves.toEqual([])
      await offerSessionDatabaseMigration(window, { showMessageBox }, store)
      await expect(readlink(path)).resolves.toBe('agent-sessions.sqlite')
      await expect(new AgentMuxFileAgentSessionStore(path).load()).resolves.toEqual([])
      expect(showMessageBox).toHaveBeenCalledTimes(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
