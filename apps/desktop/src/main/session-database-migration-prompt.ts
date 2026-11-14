import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { AgentMuxFileAgentSessionStore } from '@agentmux/core'

export async function offerSessionDatabaseMigration(
  window: BrowserWindow,
  dialog: { showMessageBox(window: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue> },
  store: Pick<AgentMuxFileAgentSessionStore, 'hasLegacyDatabaseName' | 'migrateDatabaseName'>,
): Promise<void> {
  if (!await store.hasLegacyDatabaseName() || window.isDestroyed()) return
  const answer = await dialog.showMessageBox(window, {
    type: 'info',
    title: 'Upgrade Session database',
    message: 'Update the filename of your Session database?',
    detail: 'AgentMux will move the database to agent-sessions.sqlite, keeping your Sessions, history, and the original path available. You can also do this the next time you open AgentMux.',
    buttons: ['Upgrade', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (answer.response !== 0 || window.isDestroyed()) return
  try { await store.migrateDatabaseName() }
  catch (error) {
    if (!window.isDestroyed()) await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Session database upgrade',
      message: 'AgentMux could not confirm the filename upgrade.',
      detail: error instanceof Error ? error.message : String(error),
      buttons: ['OK'],
      noLink: true
    })
  }
}
