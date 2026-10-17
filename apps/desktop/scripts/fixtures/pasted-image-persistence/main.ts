import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'
import { createDesktopApplicationAccessOwner } from '../../../src/main/application-access-owner'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { registerIpc } from '../../../src/main/ipc'
import { pastedDirectory } from '../../../src/main/pasted-directory'
import type { AppConfig } from '../../../src/shared/contracts'

const root = process.env.AGENTMUX_PASTED_PROOF_ROOT!, node = process.env.AGENTMUX_PASTED_PROOF_NODE!
const report: any = { schema: 'agentmux.pasted-image-persistence.native.v1', passed: false, ipc: [],
  boundary: 'Private hidden Electron actual Composer/Store/File paste → production sandbox preload/trusted registerIpc → original pasted writer/read/decoded thumbnail. Presentation-only Session seeds; no Agent Runtime, OS clipboard, focus or user workface is operated.' }
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
const sha = createHash('sha256').update(bytes).digest('hex')
let window: BrowserWindow, runtime: RuntimeController, dispose: (() => Promise<void>) | undefined
let lost = true, hold = false, release!: () => void
async function run() {
  await app.whenReady()
  runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => { throw new Error('No Runtime is needed for a pasted file') })
  runtime.prepare = async () => ({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const store = new ConfigStore(join(root, 'config.json'))
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Private storage Host' }],
    workspaces: [{ id: 'pasted-workspace', hostId: 'local', kind: 'folder' as const, name: 'Paste proof', path: root }],
    executors: { codex: { providerId: 'codex', label: 'Paste reader', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } } }
  window = new BrowserWindow({ show: false, width: 1000, height: 700,
    webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.on('console-message', (event: any) => { if (event.level === 'error') console.error('Renderer:', event.message) })
  window.webContents.on('preload-error', (_event, _path, error) => { console.error('Preload:', error) })
  const windows = new WorkbenchWindows(window, new WorkbenchWindowStore(join(root, 'windows.json')), () => [{ x: 0, y: 0, width: 1200, height: 800 }])
  const applicationAccess = createDesktopApplicationAccessOwner(runtime, join(root, 'access.sqlite'))
  const register = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) => register(channel, async (event, ...args) => {
    if (channel === 'ui:savePastedImage' || channel === 'ui:readPastedImage') {
      const invocation: any = { channel, sender: event.sender === window.webContents,
        ...(channel === 'ui:savePastedImage' ? { bytes: Buffer.from(args[0].bytes).toString('base64'), extension: args[0].extension } : { path: args[0] }) }
      report.ipc.push(invocation)
      const result = await handler(event, ...args); invocation.result = result
      if (channel === 'ui:savePastedImage') {
        if (lost) { lost = false; throw new Error('Original save reply lost; keep the image and draft, then retry the same image.') }
        if (hold) await new Promise<void>(resolve => { release = resolve })
      }
      return result
    }
    return await handler(event, ...args)
  })
  dispose = await registerIpc({ window, workbenchWindows: windows, runtime, configStore: store, initialConfig: config,
    applicationAccess, scratchTopics: new ScratchTopics(), progressLoops: { subscribe: () => () => {}, pauseTarget: async () => {} } as never })
  await window.loadFile(join(root, 'renderer/index.html'))
  const evaluate = (expression: string) => window.webContents.executeJavaScript(expression)
  const until = async (expression: string) => {
    for (let attempt = 0; attempt < 200; attempt++) { const result = await evaluate(expression); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)) }
    throw new Error('The private consumer did not settle: ' + expression)
  }
  await until('Boolean(window.pastedProof)')
  await evaluate(`pastedProof.setup(${JSON.stringify(config)})`)
  await until('Boolean(document.querySelector(".tiptap"))')
  await evaluate(`pastedProof.paste(${JSON.stringify(bytes.toString('base64'))})`)
  await until('pastedProof.facts().failures.length > 0')
  let facts = await evaluate('pastedProof.facts()')
  assert.equal(facts.drafts['pasted-agent'], 'Original draft', 'unknown save must preserve the original draft')
  assert.equal(facts.images.length, 0, 'unknown save must not insert an unconfirmed reference')
  assert.equal(report.ipc.filter((item: any) => item.channel === 'ui:savePastedImage').length, 1)
  await evaluate('pastedProof.retry()')
  await until('pastedProof.facts().images.some(image => image.width > 0)')
  const saves = report.ipc.filter((item: any) => item.channel === 'ui:savePastedImage')
  assert.equal(saves.length, 2)
  assert.equal(saves[0].sender && saves[1].sender, true, 'actual paste must use the original trusted Renderer')
  assert.equal(saves[1].bytes, saves[0].bytes, 'explicit retry must preserve original image bytes')
  assert.equal(typeof saves[1].result, 'string', 'the existing IPC result must remain a path string')
  assert.equal(saves[1].result, saves[0].result, 'actual IPC retry must return the same original pasted object')
  const originalPath = join(pastedDirectory(app.getPath('home')), sha + '.png')
  assert.equal(saves[1].result, originalPath, 'actual IPC must consume the content-addressed writer')
  assert.equal((await readFile(originalPath)).equals(bytes), true)
  facts = await evaluate('pastedProof.facts()')
  assert.ok(facts.drafts['pasted-agent'].includes('@' + originalPath), 'actual Composer must insert the confirmed original path')
  assert.ok(report.ipc.some((item: any) => item.channel === 'ui:readPastedImage' && item.path === originalPath), 'actual preview must consume the original pasted reader')
  const foreign = new BrowserWindow({ show: false, webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true } })
  try {
    await foreign.loadURL('data:text/html,<title>Untrusted paste source</title>')
    const error = await foreign.webContents.executeJavaScript(`window.agentmux.ui.savePastedImage({bytes:new Uint8Array([1]),extension:'png'}).then(()=>null,error=>error.message)`)
    assert.match(error, /Untrusted pasted image sender/u, 'foreign Renderer must not gain the trusted paste writer')
  } finally { foreign.destroy() }
  hold = true
  await evaluate(`pastedProof.paste(${JSON.stringify(bytes.toString('base64'))})`)
  for (let attempt = 0; !release && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(typeof release, 'function')
  await evaluate('pastedProof.switch()')
  await until('pastedProof.facts().current === "other-agent" && document.querySelector(".tiptap")?.textContent === "Other draft"')
  release(); await new Promise(resolve => setTimeout(resolve, 100))
  facts = await evaluate('pastedProof.facts()')
  assert.equal(facts.drafts['other-agent'], 'Other draft', 'late save must not insert into a successor editor')
  assert.deepEqual(facts.queues, {}, 'saving an image must never send Agent input')
  const child = JSON.parse(execFileSync(node, ['--input-type=module', '-e', `
    import {savePastedImage,readPastedImage} from ${JSON.stringify(new URL('./storage.mjs', 'file://' + root + '/').href)};
    const bytes=Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64');
    const receipt=await savePastedImage(${JSON.stringify(app.getPath('home'))},{bytes,extension:'png'});
    const read=await readPastedImage(${JSON.stringify(app.getPath('home'))},receipt.path);
    console.log(JSON.stringify({receipt,image:read?.dataUrl,pid:process.pid}));`], { encoding: 'utf8' }))
  assert.notEqual(child.pid, process.pid)
  assert.equal(child.receipt.path, originalPath, 'second ordinary process must reconcile the same original artifact')
  assert.equal(child.image, 'data:image/png;base64,' + bytes.toString('base64'))
  assert.deepEqual(await readdir(pastedDirectory(app.getPath('home'))), [sha + '.png'])
  report.secondProcess = child; report.consumer = facts; report.passed = true
  await evaluate('pastedProof.dispose()')
}
run().catch(error => { report.failure = { name: error.name, message: error.message, stack: error.stack }; console.error(error) })
  .finally(async () => {
    try { await dispose?.(); await runtime?.dispose() } catch (error) { report.cleanupFailure = String(error); report.passed = false }
    if (window && !window.isDestroyed()) window.destroy()
    await writeFile(join(root, 'native-receipt.json'), JSON.stringify(report, null, 2)); app.exit(report.passed ? 0 : 1)
  })
