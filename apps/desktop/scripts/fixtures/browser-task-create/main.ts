import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../../../src/main/browser-task-assets.js'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserDemonstrationRecorder, BrowserDemonstrationFileStore } from '../../../src/main/browser-demonstration-recorder.js'

const home = process.env.TASK_CREATE_HOME!, out = process.env.TASK_CREATE_OUT!, page = process.env.TASK_CREATE_PAGE!
const report: any = { passed: false, cleanup: [], captures: [] }
let window: BrowserWindow | undefined
// Keep the private observer alive until its final receipt is flushed.
app.on('window-all-closed', () => {})
async function observed<T>(promise: Promise<T>, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Private task UI observation unavailable: ' + step)), 20_000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
async function waitFor(check: () => Promise<boolean>) {
  const until = performance.now() + 20_000
  while (!await check()) { if (performance.now() > until) throw new Error('Private task UI observation did not complete'); await new Promise(done => setTimeout(done, 25)) }
}
async function click(selector: string) {
  const point = await window!.webContents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`)
  assert.ok(point, 'Actual task UI control exists')
  await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}
try {
  await app.whenReady(); app.setActivationPolicy?.('prohibited'); console.error('task-stage: Main ready')
  const recordingPath = join(home, 'recordings.json'), assetPath = join(home, 'assets.json')
  const recording = { id: 'demonstration-proof', browserId: 'browser-proof', navigationId: 'document-proof', url: 'https://generic.invalid/form', revision: 2,
    status: 'stopped' as const, startedAt: 1, updatedAt: 2, steps: [{ id: 'step-proof', sequence: 1, navigationId: 'document-proof', recordedAt: 2,
      source: 'native-human' as const, method: 'fillInput', args: [], inputKey: 'fresh', url: 'https://generic.invalid/form', target: { role: 'text input', name: 'Field', ordinal: 1, count: 1 } }] }
  await new BrowserDemonstrationFileStore(recordingPath).save({ version: 1, drafts: [recording] })
  const recorder = new BrowserDemonstrationRecorder(new BrowserDemonstrationFileStore(recordingPath)), assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(assetPath))
  const manager = Object.create(BrowserViewManager.prototype) as BrowserViewManager
  Object.assign(manager, { taskAssets: assets, demonstrations: recorder })
  ipcMain.handle('task-proof:source', () => recorder.get(recording.browserId))
  ipcMain.handle('task-proof:state', () => assets.state(recording.browserId))
  ipcMain.handle('task-proof:create', (_event, input) => manager.importTaskAsset(recording.browserId, input))
  ipcMain.handle('task-proof:inspect', (_event, input) => manager.inspectTaskAssetCreation(recording.browserId, input))
  window = new BrowserWindow({ show: false, width: 1040, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: join(out, 'preload.cjs') } })
  window.webContents.on('console-message', event => console.error('task-ui:', event.message))
  await observed(window.loadFile(page), 'initial Renderer load'); console.error('task-stage: Renderer loaded'); window.webContents.debugger.attach('1.3')
  await waitFor(() => window!.webContents.executeJavaScript(`!!document.querySelector('.browser-task-asset-entry > button')`))
  await click('.browser-task-asset-entry > button')
  console.error('task-stage: trusted import dispatched')
  await waitFor(() => window!.webContents.executeJavaScript(`!!document.querySelector('[aria-label="Original task import"]') && document.body.textContent.includes('reply was not received')`))
  const frozen = await window.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('original-inputs'))`)
  assert.equal(frozen.length, 1); assert.equal((await assets.state(recording.browserId)).assets.length, 1)
  const before = JSON.parse(await readFile(assetPath, 'utf8'))
  assert.deepEqual(before.assets[0].creation, frozen[0]); assert.equal(before.assets[0].id, frozen[0].assetId)
  const screenshot = async (name: string) => {
    await observed(window!.webContents.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'), 'paint ' + name)
    const file = join(out, name + '.png'); await writeFile(file, (await window!.webContents.capturePage()).toPNG()); report.captures.push({ name, file })
  }
  await screenshot('reply-unconfirmed')
  window.setSize(620, 1000)
  await screenshot('reply-unconfirmed-narrow')
  window.setSize(1040, 1000)
  await window.webContents.reload()
  await waitFor(() => window!.webContents.executeJavaScript(`!!document.querySelector('[aria-label="Original task import"] button')`))
  assert.deepEqual(await window.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('original-inputs'))`), frozen)
  await screenshot('renderer-remounted')
  await click('[aria-label="Original task import"] button')
  await waitFor(() => window!.webContents.executeJavaScript(`!document.querySelector('[aria-label="Original task import"]') && !!document.querySelector('[data-task-asset-id]')`))
  const after = JSON.parse(await readFile(assetPath, 'utf8'))
  assert.deepEqual(after, before, 'Checking the original receipt does not create or rewrite any asset')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-task-asset-id]').dataset.taskAssetId`), frozen[0].assetId)
  assert.deepEqual(await window.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('original-inputs'))`), [])
  await screenshot('original-receipt-confirmed')
  report.input = frozen[0]; report.assets = after.assets.map((asset: any) => ({ id: asset.id, creation: asset.creation, reviewed: asset.draft.steps.map((step: any) => step.reviewed) }))
  report.passed = true
} catch (error) { report.failure = { message: (error as Error).message, stack: (error as Error).stack } }
finally {
  for (const channel of ['source', 'state', 'create', 'inspect']) ipcMain.removeHandler('task-proof:' + channel)
  // A client imported by this fixture may already own app window-close policy.
  // Flush the observation while its original Window still keeps this app alive.
  await writeFile(join(out, 'actual.json'), JSON.stringify(report, null, 2) + '\n')
  try { window?.destroy() } catch (error) { report.cleanup.push(String(error)) }
  if (report.cleanup.length) await writeFile(join(out, 'actual.json'), JSON.stringify(report, null, 2) + '\n')
  app.exit(report.passed && !report.cleanup.length ? 0 : 1)
}
