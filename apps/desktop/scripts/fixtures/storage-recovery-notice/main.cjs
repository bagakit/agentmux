const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, root, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(root, 'user-data')); app.setPath('sessionData', path.join(root, 'session-data'))
let win
const result = { passed: false, screenshots: [], calls: [], boundary: 'Private hidden Electron; real GlobalSystemNotices, storage notice hook, notice feed and current styles; controlled external backup DTO, no user App/Runtime/Provider.' }
const read = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(expression) { for (let index = 0; index < 200; index++) { if (await read(expression)) return; await delay(25) } throw Error('Private Renderer fact absent: ' + expression) }
async function frame(name) {
  await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await delay(100)
  const bounds = await read('(()=>{const e=document.querySelector(".global-system-notices__details"),r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight,open:e.matches(":popover-open")}})()')
  if (bounds.open) { assert.ok(bounds.top >= 0); assert.ok(bounds.bottom <= bounds.viewport + 1) }
  const image = await win.webContents.capturePage(); assert.equal(image.isEmpty(), false); await fs.writeFile(path.join(evidence, name + '.png'), image.toPNG()); result.screenshots.push(name + '.png')
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 920, height: 640, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    await win.loadFile(html)
    await wait('window.recoveryNoticeGallery && document.querySelector(".global-system-notices__trigger")')
    await read('document.querySelector(".global-system-notices__trigger").click()')
    await wait('document.querySelector("[data-notice-id=storage-recovery]")')
    await frame('backup-failure')
    await read('document.querySelector("[data-notice-id=storage-recovery] details").open=true')
    await frame('backup-failure-details')
    await read('[...document.querySelectorAll("[data-notice-id=storage-recovery] button")].find(e=>e.textContent.includes("Retry backup")).click()')
    await wait('recoveryNoticeGallery.facts().calls.includes("storage.backup.create") && !document.querySelector("[data-notice-id=storage-recovery]")')
    await read('document.querySelector(".global-system-notices__trigger").click()')
    await frame('backup-recovered')
    result.calls = await read('recoveryNoticeGallery.facts().calls')
    assert.equal(result.calls.filter(value => value === 'storage.backup.create').length, 1)
    result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack } }
  finally { await fs.writeFile(path.join(evidence, 'visual.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
