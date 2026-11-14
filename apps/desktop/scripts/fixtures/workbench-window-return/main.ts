import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'
import { WORKBENCH_WINDOW_REQUEST, WORKBENCH_WINDOW_CHANGED } from '../../../src/shared/workbench-windows'

const [directory, phase, receipt] = process.argv.slice(2)
app.setPath('userData', join(directory!, 'data'))
app.setPath('sessionData', join(directory!, 'session'))
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 960, height: 680, webPreferences: {
    preload: join(directory!, 'preload.cjs'), contextIsolation: true, sandbox: true
  } })
  window.webContents.on('console-message', (_event, ...details) => process.stdout.write('renderer: ' + JSON.stringify(details) + '\n'))
  window.webContents.on('did-fail-load', (_event, code, description) => process.stderr.write('load failure: ' + code + ' ' + description + '\n'))
  const owner = new WorkbenchWindows(window, new WorkbenchWindowStore(join(directory!, 'windows.json')), () => [{ x: 0, y: 0, width: 1600, height: 1000 }])
  owner.setNativeOwner({ beforeClosing: async () => {} }) // No native page/Run is created by this isolated input fixture.
  ipcMain.handle('window-proof:call', (_event, method, input) => owner.call(method, input, { actor: { kind: 'user', id: 'private-proof' } }))
  ipcMain.handle('window-proof:ready', event => owner.rendererReady(event))
  ipcMain.on('window-proof:response', (event, response) => owner.accept(event, response))
  window.webContents.setWindowOpenHandler(details => owner.windowOpen(details, () => { throw new Error('External navigation is outside the private proof') }))
  window.webContents.on('did-create-window', (child, details) => owner.createdWindow(child, details))
  ipcMain.handle('window-proof:done', async (_event, result) => {
    await owner.prepareQuit()
    await writeFile(receipt!, JSON.stringify({ ...result, phase, pid: process.pid, channels: [WORKBENCH_WINDOW_REQUEST, WORKBENCH_WINDOW_CHANGED] }, null, 2))
    owner.dispose(); app.exit(result.passed ? 0 : 1)
  })
  await window.loadFile(join(directory!, 'renderer/index.html'), { query: { phase: phase! } })
}).catch(async error => { await writeFile(receipt!, JSON.stringify({ passed: false, error: String(error), pid: process.pid })); app.exit(1) })
