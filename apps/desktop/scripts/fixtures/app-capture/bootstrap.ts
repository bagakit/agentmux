import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../../../../../packages/core/src/public-rpc-server.js'
import { WorkbenchWindows } from '../../../src/main/workbench-windows.js'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store.js'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { AppCaptureSource } from '../../../src/main/app-capture.js'
import { AppRecordingOwner } from '../../../src/main/app-recording.js'
import { createAppCapturePort } from '../../../src/main/app-capture-owner.js'

// The fixture owns explicit exit after its cleanup receipt reaches disk.
app.on('window-all-closed', () => {})
const exec = promisify(execFile)
export type CaptureProof = Awaited<ReturnType<typeof createCaptureProof>>

async function createCaptureProof() {
  const root = process.env.AGENTMUX_CAPTURE_PROOF_ROOT!, socket = join(root, 'capture.sock')
  assert.equal(app.getPath('home'), process.env.HOME)
  assert.equal(app.getPath('userData'), join(root, 'profile'))
  assert.equal(app.getPath('appData'), join(root, 'profile/appData'))
  assert.equal(app.getPath('sessionData'), join(root, 'profile/sessionData'))
  await app.whenReady()
  const window = new BrowserWindow({ width: 960, height: 700, show: false, focusable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const region = { kind: 'region' as const, displayWorkspaceId: 'proof-workspace', groupId: 'proof-group', tabId: 'proof-tab', regionId: 'proof-region' }
  const reference = `primary:${JSON.stringify([region.displayWorkspaceId, region.groupId, region.tabId, region.regionId])}`
  await window.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><style>
    body{margin:0;background:rgb(22,28,40);color:white;font:24px system-ui} #region{position:absolute;left:40px;top:80px;width:720px;height:500px;background:rgb(210,40,80)}
    </style><div id="region">Original workface <input id="draft" value="unsent original draft"></div>
    <script>document.getElementById('region').dataset.workbenchRegionReference=${JSON.stringify(reference)};</script>`))
  window.showInactive()
  const windows = new WorkbenchWindows(window, new WorkbenchWindowStore(join(root, 'windows.json')), () => [])
  await windows.rendererReady({ sender: window.webContents, senderFrame: window.webContents.mainFrame } as never)
  const profiles = new BrowserProfileManager(new BrowserProfileStore(join(root, 'profiles.json')))
  await profiles.initialize()
  const browsers = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(root, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('No external handoff belongs to this proof') } })
  // A real HTTP native Browser page and a data: Renderer provide distinct native sources.
  const { createServer } = await import('node:http')
  const http = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><style>body{margin:0;background:rgb(20,80,220);color:white;font:28px system-ui}</style><p>Native Browser</p>') })
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done))
  const port = (http.address() as { port: number }).port
  const browserId = 'proof-browser'
  await browsers.create(browserId, `http://127.0.0.1:${port}/`)
  browsers.setBounds(browserId, { x: 300, y: 180, width: 400, height: 260 })
  const nativePage = browsers.captureWorkbenchViews(window).find(entry => entry.browserId === browserId)!.view.webContents
  // Wait for this actual private page's first presentation, without focus emulation.
  nativePage.setBackgroundThrottling(false)
  await nativePage.executeJavaScript(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Private native page did not paint')),2000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true)}))})`)

  const source = new AppCaptureSource(windows, browsers)
  const directory = join(root, 'recordings'), recordings = new AppRecordingOwner({ directory, capture: target => source.capture(target) })
  const captures = createAppCapturePort(source, recordings)
  const server = new AgentMuxControlServer({ windows, captures }, socket)
  await server.start()
  let sequence = 0
  async function cli(method: string, params: unknown, output?: string) {
    const input = join(root, `input-${++sequence}.json`)
    await writeFile(input, JSON.stringify(params))
    const args = [process.env.AGENTMUX_CAPTURE_PROOF_CLI!, '--endpoint', `unix:${socket}`, ...method.split('.'), '--input', input, ...(output ? ['--output', output] : [])]
    try {
      const result = await exec(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 32 * 1024 * 1024 })
      return { ...JSON.parse(result.stdout), cliExitCode: 0 }
    } catch (error) {
      const original = error as Error & { stdout?: string; stderr?: string; code?: number }
      if (original.stderr?.trim().startsWith('{')) return { ...JSON.parse(original.stderr), cliExitCode: original.code }
      if (original.stdout?.trim().startsWith('{')) return { ...JSON.parse(original.stdout), cliExitCode: original.code }
      throw error
    }
  }
  const page = await server.callRpc('app.window.ls', {}, { principal: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` } })
  assert.equal(page.windows.length, 1)
  const descriptor = page.windows[0]!
  assert.ok(descriptor.documentGeneration)
  const target = { windowId: descriptor.windowId, documentGeneration: descriptor.documentGeneration }
  const report: Record<string, any> = { passed: false, sources: ['actual-cli', 'Core public RPC', 'WorkbenchWindows', 'AppCaptureSource', 'native Browser WebContentsView', 'real Chromium pixels'], checks: [] }
  return { root, window, windows, source, recordings, captures, server, target, region, browserId, browsers, directory, cli, report,
    async close() { await recordings.dispose(); await server.stop(); await browsers.dispose(); await profiles.dispose(); await windows.dispose();
      await new Promise<void>((done, reject) => http.close(error => error ? reject(error) : done())); if (!window.isDestroyed()) window.destroy() } }
}
export async function withCaptureProof(run: (context: CaptureProof) => Promise<void>) {
  let context: CaptureProof | undefined
  let report: Record<string, any> = { passed: false }
  try { context = await createCaptureProof(); report = context.report; await run(context); report.passed = true }
  catch (error) { report.error = error instanceof Error ? error.stack : String(error) }
  finally {
    try { await context?.close() } catch (error) { report.passed = false; report.cleanupError = String(error) }
    await writeFile(process.env.AGENTMUX_CAPTURE_PROOF_RESULT!, JSON.stringify(report))
    app.exit(report.passed ? 0 : 1)
  }
}

export function pixel(png: string, x: number, y: number): number[] {
  const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64')), { width } = image.getSize()
  return [...image.toBitmap({ scaleFactor: 1 }).subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
}
export async function readPng(path: string) { return (await readFile(path)).toString('base64') }
