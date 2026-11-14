import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { AgentMuxControlServer } from '@agentmux/core'
import { RendererTimelineTracer } from '../src/main/renderer-trace.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'

async function run() {
  console.log('stage:imports-ready')
  const directory = process.env.ALLOCATOR_NATIVE_DIRECTORY!, namespace = process.env.ALLOCATOR_NATIVE_NAMESPACE!
  app.setPath('userData', join(namespace, 'user-data')); app.setPath('sessionData', join(namespace, 'session-data'))
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  await app.whenReady(); app.dock?.hide()
  console.log('stage:app-ready')
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
  await window.loadURL('data:text/html,<title>Private allocator positive control</title><main id="root"></main>')
  console.log('stage:page-ready')
  await window.webContents.executeJavaScript(`globalThis.allocatorPositiveControl = new Uint8Array(20 * 1024 * 1024);
    for (let i=0;i<allocatorPositiveControl.length;i+=4096) allocatorPositiveControl[i]=37;
    const root=document.getElementById('root'); for(let i=0;i<10000;i++){const node=document.createElement('span');node.textContent='private';root.appendChild(node)};true`)
  console.log('stage:control-ready')
  const current = () => {
    if (window.isDestroyed()) return null
    const pid = window.webContents.getOSProcessId(), source = app.getAppMetrics().find(metric => metric.pid === pid)
    return source ? { windowId: window.id, webContentsId: window.webContents.id, generation: 1, pid, creationTime: source.creationTime } : null
  }
  const debuggerClient = window.webContents.debugger, send = debuggerClient.sendCommand.bind(debuggerClient)
  const commands: Array<{ method: string; params: unknown }> = [], acknowledgements: unknown[] = [], chunks: Buffer[] = []
  let bytes = 0, rejectedNativePolicies = 0
  debuggerClient.sendCommand = async (method, params, sessionId) => {
    // A test-only boundary: unsafe policy mutations must never reach real Chromium.
    if (method === 'Tracing.requestMemoryDump' && JSON.stringify(params) !== JSON.stringify({ deterministic: false, levelOfDetail: 'light' })) {
      rejectedNativePolicies++; throw Error('Private native policy refused before dispatch')
    }
    commands.push({ method, params: params ?? null })
    const reply = await send(method, params, sessionId)
    if (method === 'Tracing.requestMemoryDump') acknowledgements.push(reply)
    if (method === 'IO.read') {
      const chunk = Buffer.from(reply.data, reply.base64Encoded ? 'base64' : 'utf8'); bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) throw Error('Private native byte witness exceeded original transport boundary')
      chunks.push(chunk)
    }
    return reply
  }
  const tracer = new RendererTimelineTracer(window.webContents, current)
  const metrics = createResourceMetricsPort({ sampler: {} as never, currentWindow: current, tracer })
  const server = new AgentMuxControlServer({ coreClients: () => [], metrics }, join(namespace, 'c.sock'))
  await server.start()
  writeFileSync(join(directory, 'native-ready.json'), JSON.stringify({ target: current(), mainPID: process.pid, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }))
  console.log('ready')
  const input = createInterface({ input: process.stdin })
  input.on('line', async line => {
    if (line !== 'quit') return
    try {
      const retained = await window.webContents.executeJavaScript('allocatorPositiveControl.byteLength===20*1024*1024&&allocatorPositiveControl[0]===37&&document.querySelectorAll("span").length===10000')
      writeFileSync(join(directory, 'native-original.gz'), Buffer.concat(chunks))
      writeFileSync(join(directory, 'native-proof.json'), JSON.stringify({ target: current(), commands, acknowledgements, rejectedNativePolicies,
        attached: debuggerClient.isAttached(), visible: window.isVisible(), title: window.getTitle(), retained, bytes }))
    } finally { input.close(); await server.stop(); metrics.dispose(); window.destroy(); app.quit() }
  })
}
void run().catch(error => { console.error(error); app.exit(1) })
