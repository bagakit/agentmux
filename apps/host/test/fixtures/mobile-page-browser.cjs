const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto')
const input = JSON.parse(process.env.MOBILE_ENTRY_BROWSER_INPUT)
app.setPath('userData', path.join(input.evidence, 'profile'))
const lines = [], waiters = []
require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const accept = waiters.shift(); if (accept) accept(line); else lines.push(line) })
const next = () => lines.length ? Promise.resolve(lines.shift()) : new Promise(resolve => waiters.push(resolve))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, boundary: 'Private Electron Chromium using the real HTTP owner; no mobile-device claim or business request', cases: [], images: {}, downloads: [] }
app.whenReady().then(async () => {
  let win
  try {
    await fs.mkdir(input.evidence, { recursive: true }); Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 390, height: 720, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.session.on('will-download', (_event, item) => { result.downloads.push({ name: item.getFilename(), type: item.getMimeType() }); item.cancel() })
    const read = source => win.webContents.executeJavaScript(source)
    const until = async source => { const end = Date.now() + 8000; while (Date.now() < end) { try { if (await read(source)) return } catch {} await sleep(25) }; assert.fail('Browser consumer condition: ' + source) }
    const load = async url => { try { await win.loadURL(url) } catch (error) { if (!String(error.message).includes('ERR_HTTP_RESPONSE_CODE_FAILURE')) throw error } }
    await load(input.origin + '/?original=kept#offer-original')
    assert.equal(await read('!!document.querySelector("#retry")'), true)
    assert.deepEqual(result.downloads, [])
    await win.webContents.debugger.attach('1.3')
    for (const width of [320, 390]) for (const theme of ['dark', 'light']) {
      win.setContentSize(width, 640)
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
      await sleep(60)
      const geometry = await read(`(()=>{const r=document.querySelector('#retry').getBoundingClientRect(),b=document.querySelector('#back').getBoundingClientRect();return {width:r.width,height:r.height,backWidth:b.width,backHeight:b.height,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
      assert.ok(geometry.width >= 44 && geometry.height >= 44 && geometry.backWidth >= 44 && geometry.backHeight >= 44 && !geometry.overflow)
      const file = path.join(input.evidence, `recovery-${width}-${theme}.png`), bytes = (await win.webContents.capturePage()).toPNG()
      await fs.writeFile(file, bytes); result.images[file] = crypto.createHash('sha256').update(bytes).digest('hex')
    }
    await read(`sessionStorage.setItem('original-handoff',JSON.stringify({operationId:'original-unknown',device:'original-device'}));localStorage.setItem('original-draft','keep this draft')`)
    console.log('RECOVERY_READY'); await next()
    const p = await read(`(()=>{const r=document.querySelector('#retry').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p })
    await until('document.body.dataset.build === "browser-a"')
    assert.equal(await read('location.hash'), '#offer-original'); assert.equal(await read('location.search'), '?original=kept')
    assert.equal(await read('JSON.parse(sessionStorage.getItem("original-handoff")).operationId'), 'original-unknown')
    assert.equal(await read('localStorage.getItem("original-draft")'), 'keep this draft')
    result.cases.push('retry-original-fragment')
    const original = await read('location.href'); console.log('ORIGINAL_LOADED'); await next()
    assert.equal(await read('document.body.dataset.build'), 'browser-a'); assert.equal(await read('location.href'), original)
    result.cases.push('original-document-not-reloaded-by-publish')
    win.webContents.reload()
    await until('document.body.dataset.build === "browser-c"')
    assert.equal(await read('location.hash'), '#offer-original'); assert.equal(await read('location.search'), '?original=kept')
    result.cases.push('unretained-offer')
    await load(original.replace('#offer-original', '#amux-update'))
    await until('document.body.dataset.build === "browser-c"')
    assert.equal(await read('location.hash'), '#amux-update')
    assert.equal(await read('JSON.parse(sessionStorage.getItem("original-handoff")).device'), 'original-device')
    assert.equal(await read('localStorage.getItem("original-draft")'), 'keep this draft')
    result.cases.push('unretained-update-handoff'); assert.deepEqual(result.downloads, [])
    result.passed = true
  } catch (error) { result.error = error.stack; console.error(error.stack) }
  finally {
    await fs.mkdir(input.evidence, { recursive: true }); await fs.writeFile(path.join(input.evidence, 'receipt.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
}).catch(error => { console.error(error); app.exit(1) })
