import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { BrowserRefLedgerStore } from '@agentmux/browser/browser-ref-ledger-store'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { registerBrowserTrafficIpc } from '../../../src/main/browser-traffic-ipc'
import { THEME_BOOTSTRAP_CHANNEL } from '../../../src/shared/theme-bootstrap'

const home = process.env.AGENTMUX_TRAFFIC_HOME!, fixture = process.env.AGENTMUX_TRAFFIC_RENDERER!
const output = process.env.AGENTMUX_TRAFFIC_OUTPUT!, fixtureUrl = process.env.AGENTMUX_TRAFFIC_URL!
const report: { passed: boolean; cases: string[]; failure?: string; cleanup: string[] } = { passed: false, cases: [], cleanup: [] }
const wait = async <T>(action: () => Promise<T>, accepts: (value: T) => boolean, failure: string): Promise<T> => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const answer = await action()
    if (accepts(answer)) return answer
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(failure)
}
let window: BrowserWindow | undefined, browsers: BrowserViewManager | undefined, profiles: BrowserProfileManager | undefined
app.on('window-all-closed', () => {})
await app.whenReady()
app.setActivationPolicy?.('prohibited')
try {
  await mkdir(output, { recursive: true })
  window = new BrowserWindow({ width: 690, height: 720, show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(fixture, 'preload.cjs')
  } })
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(home, 'profiles.json')))
  await profiles.initialize()
  browsers = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(home, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => { throw new Error('Unexpected external navigation in this fixture.') } })
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      assert.equal(event.sender, window!.webContents)
      return listener(event, ...args)
    })
  ipcMain.on(THEME_BOOTSTRAP_CHANNEL, event => { event.returnValue = { status: 'unavailable', message: 'Private acceptance uses the shared theme runtime.' } })
  registerBrowserTrafficIpc({ handle, browsers })
  const first = 'traffic-main-page', second = 'traffic-other-page', third = 'traffic-excluded-page'
  await browsers.create(first, fixtureUrl + '/first', 'traffic-proof', profiles.defaultProfileId())
  await browsers.create(second, fixtureUrl + '/second', 'traffic-proof', profiles.defaultProfileId())
  await browsers.create(third, fixtureUrl + '/excluded', 'traffic-proof', profiles.defaultProfileId())
  const view = window.webContents
  view.on('console-message', details => console.log('Renderer:', details.message))
  view.on('preload-error', (_event, _file, error) => console.error('Preload:', error))
  await window.loadFile(join(fixture, 'renderer/index.html'))
  window.showInactive()
  console.log('Traffic Main targets:', browsers.trafficTargets().length)
  console.log('Traffic preload:', await view.executeJavaScript('Boolean(window.agentmux?.browser?.trafficTargets)'))
  view.debugger.attach('1.3')
  const read = async <T>(expression: string) => {
    const evaluated = await view.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text)
    return evaluated.result.value as T
  }
  const click = (expression: string) => read(`(()=>{ const item=${expression}; if (!item) return false; item.click(); return true })()`)
  const textButton = (label: string) => `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`
  await wait(() => read<number>("document.querySelectorAll('.browser-traffic__targets input').length"), length => length === 3, 'The original Traffic UI must list mounted native Browser targets.')
  console.log('Traffic targets rendered')
  await click("document.querySelector('.browser-traffic__targets summary')")
  assert.equal(await click("document.querySelector('input[name=traffic-source][value=traffic-other-page]')"), true)
  await new Promise(resolve => setTimeout(resolve, 150))
  await writeFile(join(output, 'sources.png'), (await view.capturePage()).toPNG())
  assert.equal(await click(textButton('Record requests')), true)
  await wait(() => read<string>("document.querySelector('.browser-traffic__receipt')?.textContent ?? ''"), text => text.startsWith('Recording') && !text.startsWith('Recording ended'), 'The actual Traffic UI did not start on its selected native targets.')
  report.cases.push('two selected original Browser pages arm native IPC')
  console.log('Traffic actual recording live')
  await Promise.all([browsers.navigate(first, fixtureUrl + '/redirect'), browsers.navigate(second, fixtureUrl + '/other'), browsers.navigate(third, fixtureUrl + '/outside')])
  await wait(() => read<string>("document.querySelector('.browser-traffic__requests')?.textContent ?? ''"), text => text.includes('/final') && text.includes('/other'), 'Two selected native navigation results were not visible in Traffic.')
  console.log('Traffic selected sources observed')
  assert.equal(await click(textButton('Stop')), true)
  console.log('Traffic Stop requested')
  await wait(() => read<boolean>(`Boolean(${textButton('Export HAR…')})`), Boolean, 'Stop did not retain the original capture for export.')
  console.log('Traffic Stop receipt visible')
  await browsers.navigate(first, fixtureUrl + '/after-stop')
  const originalExport = dialog.showSaveDialog
  const path = join(home, 'original.har')
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  try {
    assert.equal(await click(textButton('Export HAR…')), true)
    console.log('Traffic export requested')
    const archive = await wait(() => readFile(path, 'utf8').catch(() => ''), Boolean, 'Original trusted HAR export did not publish the selected new file.')
    const { log } = JSON.parse(archive)
    assert.equal(log.version, '1.2')
    assert.ok(log.entries.some((entry: any) => entry._browserId === first && entry.response.status === 302))
    assert.ok(log.entries.some((entry: any) => entry._browserId === first && entry.request.url.endsWith('/final')))
    assert.ok(log.entries.some((entry: any) => entry._browserId === second && entry.request.url.endsWith('/other')))
    assert.ok(!archive.includes('/after-stop'), 'The original Browser remains usable after recording and its next navigation is outside the HAR.')
    assert.ok(!archive.includes('/outside'), 'Unselected original Browser is outside the recording.')
  } finally { dialog.showSaveDialog = originalExport }
  report.cases.push('cross-page navigation, stop, original HAR file, selected scope')
  console.log('Traffic native archive saved')
  await click("document.querySelector('.browser-traffic__requests button')")
  await wait(() => read<boolean>("Boolean(document.querySelector('.browser-traffic__detail'))"), Boolean, 'A selected original request must expose its details.')
  await new Promise(resolve => setTimeout(resolve, 220))
  await view.capturePage()
  await writeFile(join(output, 'requests.png'), (await view.capturePage()).toPNG())
  window.setContentSize(365, 615)
  await new Promise(resolve => setTimeout(resolve, 280))
  await writeFile(join(output, 'requests-narrow.png'), (await view.capturePage()).toPNG())
  await read("document.querySelector('.browser-traffic__detail').scrollIntoView({block:'start'})")
  await new Promise(resolve => setTimeout(resolve, 220))
  await writeFile(join(output, 'requests-narrow-detail.png'), (await view.capturePage()).toPNG())
  report.passed = true
} catch (error) {
  report.failure = (error as Error).stack ?? String(error)
  console.error(report.failure)
  if (window && !window.isDestroyed()) {
    const body = await window.webContents.executeJavaScript('document.body.innerText').catch(() => '')
    console.log('Traffic renderer body:', body)
    await writeFile(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG()).catch(() => {})
  }
} finally {
  for (const dispose of [() => browsers?.dispose(), () => profiles?.dispose(), () => window?.destroy()])
    try { await dispose() } catch (error) { report.cleanup.push(String(error)) }
  report.passed &&= report.cleanup.length === 0
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2))
  app.exit(report.passed ? 0 : 1)
}
