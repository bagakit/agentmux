import { join } from 'node:path'
import { mintObjectId } from '@agentmux/core/object-id'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state.js'
import { WorkbenchWindowStore } from '../src/main/workbench-window-store.js'

/** Establish the two original Desktop documents before the private Host creates Runtime identity. */
export async function initializeResourceWorkbench(userData: string) {
  const user = new WorkbenchUserStateStore(join(userData, 'workbench-user-state.json'))
  const windows = new WorkbenchWindowStore(join(userData, 'workbench-windows.json'))
  await Promise.all([
    user.write(JSON.stringify({ version: 1, state: {} })),
    windows.save({ mainWindowId: mintObjectId(), windows: [] })
  ])
}
