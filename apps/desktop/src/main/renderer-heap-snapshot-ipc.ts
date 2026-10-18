import { dialog, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { AgentMuxError, parseRendererHeapSnapshotInspectInput, sameRendererV8ProfileTarget,
  type RendererV8ProfileTarget } from '@agentmux/core/control'
import type { RendererHeapSnapshotOwner } from './renderer-heap-snapshot.js'

/** Trusted Desktop gestures only. The public capture accepts no server destination. */
export function registerHeapSnapshotFileIpc(owner: RendererHeapSnapshotOwner, window: BrowserWindow,
  currentTarget: () => RendererV8ProfileTarget | null,
  handle: (channel: string, listener: (event: IpcMainInvokeEvent, input: unknown) => unknown) => void): void {
  const exact = (raw: unknown) => {
    const input = parseRendererHeapSnapshotInspectInput(raw)
    if (!input.captureId) throw new AgentMuxError('Use the original heap captureId for this file action.', 'INVALID_CONTROL_REQUEST')
    return input
  }
  handle('metrics:saveHeapSnapshot', async (_event, raw) => owner.save(exact(raw), async defaultPath => {
    const chosen = await dialog.showSaveDialog(window, { title: 'Export original heap material and release pending copy', defaultPath,
      filters: [{ name: 'Heap material', extensions: defaultPath.endsWith('.json') ? ['json'] : ['heapsnapshot'] }] })
    return chosen.canceled ? null : chosen.filePath ?? null
  }))
  handle('metrics:revealHeapSnapshot', async (_event, raw) => {
    const artifact = await owner.artifact(exact(raw))
    shell.showItemInFolder(artifact.path)
  })
  handle('metrics:openHeapDevTools', async (_event, raw) => {
    const input = exact(raw), inspection = await owner.inspect(input)
    const target = currentTarget()
    if (inspection.status !== 'available' || !inspection.capture?.artifact || !target ||
      !sameRendererV8ProfileTarget(target, inspection.capture.target)) {
      throw new AgentMuxError('This original heap file belongs to another or unconfirmed Renderer. Save it for DevTools Memory Load.', 'CONTROL_OWNER_LOST')
    }
    owner.assertDebuggerAvailable()
    if (window.webContents.debugger.isAttached())
      throw new AgentMuxError('The original debugger is owned. No debugger was replaced.', 'CONTROL_OWNER_BUSY')
    // Explicit user gesture: existing DevTools remains its original owner. No private
    // frontend API, object-ID reset, hidden load or graph implementation is introduced.
    if (!window.webContents.isDevToolsOpened()) window.webContents.openDevTools({ mode: 'detach' })
  })
}
