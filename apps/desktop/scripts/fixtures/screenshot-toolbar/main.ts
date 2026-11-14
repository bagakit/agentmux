import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SystemScreenshotEditor } from '../../../src/main/system-screenshot-editor'

const out = process.env.AGENTMUX_SCREENSHOT_TOOLBAR_OUT!
app.setPath('userData', join(import.meta.dirname, 'user-data'))
app.on('window-all-closed', () => {})
const receipt: any = { passed: false, cases: [], screenshots: [], failure: null }
let editor: SystemScreenshotEditor, window: BrowserWindow
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(name: string, read: () => Promise<T> | T): Promise<NonNullable<T>> {
  const start = performance.now()
  while (performance.now() - start < 10000) { const value = await read(); if (value) return value as NonNullable<T>; await wait(20) }
  throw new Error('Timed out: ' + name)
}
async function run() {
  await app.whenReady()
  const pixels = Buffer.alloc(920 * 560 * 4, 255)
  const png = nativeImage.createFromBitmap(pixels, { width: 920, height: 560 }).toPNG()
  const image = { mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,' + png.toString('base64'), width: 920, height: 560, byteLength: png.length }
  for (const theme of ['dark', 'light'] as const) {
    editor = new SystemScreenshotEditor(() => ({ terminalTheme: 'graphite', appAppearance: theme }))
    const closed = editor.edit(image, false, async () => {})
    window = await until('production editor window', () => BrowserWindow.getAllWindows()[0])
    await until('production editor rendered', async () => { try { return await window.webContents.executeJavaScript("Boolean(document.querySelector('.image-annotation-toolbar') && document.querySelector('canvas')?.width)") } catch { return false } })
    window.webContents.debugger.attach('1.3')
    for (const width of [420, 640, 740, 741]) {
      window.setContentSize(width, width === 640 ? 340 : 570)
      await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const state = await window.webContents.executeJavaScript(`(()=>{const toolbar=document.querySelector('.image-annotation-toolbar');const buttons=[...toolbar.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect(),s=getComputedStyle(b);const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {name:b.getAttribute('aria-label')||b.textContent.trim(),left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible:r.width>0&&r.height>0&&s.visibility!=='hidden',hit:hit?.closest('button')===b}}).filter(b=>b.visible);return {width:innerWidth,buttons,canvasHeight:document.querySelector('canvas').getBoundingClientRect().height}})()`)
      receipt.cases.push({ theme, width, state })
      assert.ok(state.canvasHeight > 0, 'the image canvas remains visible')
      for (const [index, a] of state.buttons.entries()) {
        assert.ok(a.left >= 0 && a.right <= state.width, 'toolbar controls remain inside the window')
        assert.ok(a.hit, 'toolbar controls remain independently hittable')
        for (const b of state.buttons.slice(index + 1)) assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, 'toolbar controls never overlap')
      }
      if (width <= 740) assert.ok(state.buttons.some((button: any) => button.name === 'Markup tool'), 'the compact tool menu remains available')
      else assert.ok(state.buttons.some((button: any) => button.name === 'Erase'), 'the full tool row remains available when it fits')
      if (width === 640) {
        const trigger = state.buttons.find((button: any) => button.name === 'Markup tool')
        const x = (trigger.left + trigger.right) / 2, y = (trigger.top + trigger.bottom) / 2
        await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
        await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
        const menu = await until('actual tool menu opened', async () => await window.webContents.executeJavaScript(`(()=>{const m=document.querySelector('.image-annotation-tools-menu');if(!m)return null;const r=m.getBoundingClientRect();return {x:r.left+20,y:r.top+20}})()`))
        await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: menu.x, y: menu.y, deltaX: 0, deltaY: 1200 })
        await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        const last = await window.webContents.executeJavaScript(`(()=>{const b=document.querySelector('[role=menuitemradio][aria-label="Erase"]'),r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {top:r.top,bottom:r.bottom,height:innerHeight,hit:hit?.closest('[role=menuitemradio]')===b}})()`)
        assert.ok(last.top >= 0 && last.bottom <= last.height && last.hit, 'the last tool remains within the viewport and hittable after scrolling')
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      }
      if (width === 640 || width === 420) {
        const file = (width === 640 ? 'short-' : 'narrow-') + theme + '.png'
        await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG()); receipt.screenshots.push(file)
      }
    }
    window.close(); await closed; editor.dispose()
  }
  receipt.passed = true
}
void run().catch(error => { receipt.failure = { name: error.name, message: error.message }; process.exitCode = 1 }).finally(async () => {
  if (window && !window.isDestroyed()) window.destroy()
  editor?.dispose()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
