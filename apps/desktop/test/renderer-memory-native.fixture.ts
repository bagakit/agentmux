import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { RendererMemoryInspector } from '../src/main/renderer-memory.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'

async function run(): Promise<void> {
  const directory = process.env.RENDERER_MEMORY_NATIVE_DIRECTORY!
  app.setPath('userData', join(directory, 'user-data'))
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  await app.whenReady()
  app.dock?.hide()
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  await window.loadURL('data:text/html,<title>Memory counter positive control</title><p>Original page retained</p>')
  const currentTarget = () => {
    if (window.isDestroyed()) return null
    const pid = window.webContents.getOSProcessId(), metric = app.getAppMetrics().find(item => item.pid === pid)
    return metric ? { windowId: window.id, webContentsId: window.webContents.id, generation: 1, pid, creationTime: metric.creationTime } : null
  }
  const commands: string[] = [], debuggerClient = window.webContents.debugger
  const send = debuggerClient.sendCommand.bind(debuggerClient)
  debuggerClient.sendCommand = (method, params, sessionId) => { commands.push(method); return send(method, params, sessionId) }
  const memory = new RendererMemoryInspector(window.webContents, currentTarget)
  const metrics = createResourceMetricsPort({ sampler: {} as never, currentWindow: currentTarget, memory })
  const owner = new AgentMuxControlServer({ coreClients: () => [], metrics }, process.env.RENDERER_MEMORY_NATIVE_SOCKET!)
  await owner.start()
  writeFileSync(join(directory, 'native-ready.json'), JSON.stringify({ target: currentTarget(), electron: process.versions.electron, chromium: process.versions.chrome }))
  console.log('ready')
  const input = createInterface({ input: process.stdin })
  input.on('line', async line => {
    if (line === 'allocate') {
      await window.webContents.executeJavaScript('globalThis.memoryPositiveControl = new Uint8Array(32 * 1024 * 1024); memoryPositiveControl.fill(37); memoryPositiveControl.byteLength')
      console.log('allocated')
    }
    if (line === 'quit') {
      writeFileSync(join(directory, 'native-debugger-commands.json'), JSON.stringify(commands))
      writeFileSync(join(directory, 'native-final.json'), JSON.stringify({ target: currentTarget(), attached: debuggerClient.isAttached(),
        title: window.getTitle(), visible: window.isVisible(), ownsBacking: await window.webContents.executeJavaScript('globalThis.memoryPositiveControl?.byteLength === 32 * 1024 * 1024 && memoryPositiveControl[0] === 37') }))
      input.close(); await owner.stop(); metrics.dispose(); window.destroy(); app.quit()
    }
  })
}
void run().catch(error => { console.error(error); app.exit(1) })
