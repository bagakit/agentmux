import { vi } from 'vitest'
import type { ScratchTopics } from '../../src/main/scratch-topics.js'
import type { BrowserWindow } from 'electron'
import type { registerIpc } from '../../src/main/ipc.js'
import type { WorkspaceFiles } from '../../src/main/workspace-files.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mintObjectId } from '@agentmux/core/object-id'

/** Unrelated startup services for tests that exercise the real Settings ConfigOwner. */
export function settingsScratchTopics(): ScratchTopics {
  return {
    setNameAudit: vi.fn(),
    normalizeDirectoryIdentities: vi.fn(async () => {})
  } as unknown as ScratchTopics
}

export class SettingsBrowserProfiles {
  storage = { setConfirmationHandler: vi.fn() }
  cookieFiles = { setFileOwner: vi.fn(), setConfirmationHandler: vi.fn() }
  extensions = { setConfirmationHandler: vi.fn() }
  listProfiles = vi.fn(() => [])
  sessions = { observe: vi.fn() }
  onChange = vi.fn(() => () => {})
  onEnvironmentApplicationChange = vi.fn(() => () => {})
  async initialize() {}
  async cleanupApprovedTrash() {}
  async dispose() {}
}

export class SettingsBrowserViews {
  async flushProfileActivity() {}
  setPresentationWindowOwner() {}
  async release() {}
  dispose() {}
}

export function settingsWorkbenchWindows(window: BrowserWindow): Parameters<typeof registerIpc>[0]['workbenchWindows'] {
  return {
    setNativeOwner: vi.fn(() => () => {}),
    windowForDocument: () => window,
    presentationWindow: () => window
  } as unknown as Parameters<typeof registerIpc>[0]['workbenchWindows']
}

export function settingsWorkspaceFiles(): WorkspaceFiles {
  const unavailable = vi.fn(async () => { throw new Error('This Settings fixture does not admit workspace file reads.') })
  return { read: unavailable, listFiles: unavailable, readDirectory: unavailable, dispose: async () => {} } as unknown as WorkspaceFiles
}

export class SettingsNotesStorage {
  constructor(_config: unknown, _spatial: unknown, _publish: unknown, readonly storage: unknown) {}
  async initialize() {}
  async inspect(): Promise<never> { throw new Error('This Settings fixture does not read the Notes location.') }
}

/** Seed unrelated journal metadata before Main starts, so its bootstrap has no pending write at cleanup. */
export async function prepareSettingsIpcDirectory(root: string) {
  const directory = join(root, 'client-delivery-attempts')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'journal-identity.json'), JSON.stringify({ schema: 'agentmux.delivery-journal.v1', journalId: mintObjectId() }))
}
