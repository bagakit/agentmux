import { dialog, type BrowserWindow } from 'electron'
import type { BrowserProfileStorageClearInput } from '@agentmux/core/control'

/** Only the original Main native dialog can grant approval for these frozen sites. */
export async function confirmProfileStorage(input: BrowserProfileStorageClearInput, window: BrowserWindow,
  profile: { id: string; revision: string; label: string } | undefined): Promise<boolean> {
  if (!profile || profile.id !== input.profileId || profile.revision !== input.expectedRevision || window.isDestroyed()) return false
  const count = input.sites.length
  const answer = await dialog.showMessageBox(window, {
    type: 'question',
    message: 'Clear offline cache?',
    detail: `${count} ${count === 1 ? 'site' : 'sites'} in “${profile.label}”. Your sign-in data will be kept.\n\nOffline copies and unsynced content may be lost.\n\nSites:\n${input.sites.map(site => site.origin).join('\n')}`,
    buttons: ['Cancel', 'Clear offline cache'],
    defaultId: 0,
    cancelId: 0
  })
  return answer.response === 1
}
