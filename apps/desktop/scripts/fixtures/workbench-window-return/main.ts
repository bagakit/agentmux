import { app, BrowserWindow, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
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
  const debug = window.webContents.debugger
  const settle = () => window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  ipcMain.handle('window-proof:snapshot', async (_event, name, width, height, reducedMotion) => {
    if (!debug.isAttached()) debug.attach('1.3')
    window.setContentSize(width, height)
    await debug.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] })
    await settle()
    const geometry = await window.webContents.executeJavaScript(`(() => {
      const notice = [...document.querySelectorAll('.detached-workface')].find(node => node.checkVisibility())
      return { title: notice?.querySelector('[role=status]')?.textContent, theme: document.documentElement.dataset.appearance,
        animations: notice?.getAnimations({subtree:true}).map(animation=>({name:animation.animationName, time:animation.currentTime, state:animation.playState})),
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        buttons: [...(notice?.querySelectorAll('button') ?? [])].map(button => {
          const box=button.getBoundingClientRect()
          return { label:button.textContent, hit:button.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)) }
        }) }
    })()`)
    await writeFile(join(dirname(receipt!), name), (await window.webContents.capturePage()).toPNG())
    return geometry
  })
  ipcMain.handle('window-proof:click', async (_event, selector) => {
    if (!debug.isAttached()) debug.attach('1.3')
    const point = await window.webContents.executeJavaScript(`(() => {
      const button=document.querySelector(${JSON.stringify(selector)})
      const box=button.getBoundingClientRect(),x=box.x+box.width/2,y=box.y+box.height/2
      if(!button.contains(document.elementFromPoint(x,y))) throw Error('Exact visible original action is not hittable')
      return {x,y}
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) await debug.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    await settle()
  })
  window.webContents.setWindowOpenHandler(details => owner.windowOpen(details, () => { throw new Error('External navigation is outside the private proof') }))
  window.webContents.on('did-create-window', (child, details) => owner.createdWindow(child, details))
  ipcMain.handle('window-proof:done', async (_event, result) => {
    if (!result.passed) {
      await writeFile(receipt!, JSON.stringify({ ...result, phase, pid: process.pid }, null, 2))
      app.exit(1)
      return
    }
    await owner.prepareQuit()
    const expected = BrowserWindow.getAllWindows().filter(native => native !== window).map(native => native.id)
    const closed: number[] = []
    for (const native of BrowserWindow.getAllWindows()) if (native !== window) native.once('closed', () => closed.push(native.id))
    const record = (reachedWillQuit: boolean) => {
      const confirmed = reachedWillQuit && expected.length >= 1 && expected.every(id => closed.includes(id))
      writeFileSync(receipt!, JSON.stringify({ ...result, passed: confirmed, phase, pid: process.pid, expected, closed, reachedWillQuit,
        channels: [WORKBENCH_WINDOW_REQUEST, WORKBENCH_WINDOW_CHANGED] }, null, 2))
    }
    const timer = setTimeout(() => { record(false); app.exit(1) }, 6000)
    app.once('will-quit', () => { clearTimeout(timer); record(true) })
    owner.dispose()
    setImmediate(() => app.quit())
  })
  await window.loadFile(join(directory!, 'renderer/index.html'), { query: { phase: phase! } })
}).catch(async error => { await writeFile(receipt!, JSON.stringify({ passed: false, error: String(error), pid: process.pid })); app.exit(1) })
