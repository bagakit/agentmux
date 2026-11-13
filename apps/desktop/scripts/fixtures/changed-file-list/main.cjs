const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const directory = process.env.CHANGED_FILE_LIST_VISUAL_ROOT
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(done => setTimeout(done, ms))
const receipt = { captureOnly: true, aestheticReview: 'not-performed', realComponents: ['GitCommitDetails', 'ChangedFileList'], fixtureDataOnly: true, screenshots: [], measurements: {} }
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 760, height: 900, show: false, title: 'Changed file list · private review', webPreferences: { contextIsolation: true, nodeIntegration: false } })
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('Renderer:', event.message) })
    win.webContents.debugger.attach('1.3')
    const evaluate = async expression => {
      const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value
    }
    const ready = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(100) }
      const rows = await evaluate('document.querySelectorAll(".git-workbench__files > li").length')
      throw new Error('Private visual document not ready: ' + expression + ' · mounted rows: ' + rows)
    }
    const capture = async (name, width, height) => {
      win.setContentSize(width, height); await wait(400)
      await writeFile(join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG())
      receipt.screenshots.push({ name, file: name + '.png', width, height })
    }
    const mounted = () => evaluate('document.querySelectorAll(".git-workbench__files > li").length')
    // The real pointer would otherwise hover whatever row lies under it; park it, or put it on one row on purpose.
    const pointAt = async (x, y) => { await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await wait(150) }
    const hoverRow = async name => {
      const point = await evaluate(`(()=>{const row=[...document.querySelectorAll('.git-workbench__files button')].find(e=>e.querySelector('.git-workbench__file-name')?.textContent===${JSON.stringify(name)});const r=row.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
      await pointAt(point.x, point.y)
    }
    const type = async text => {
      await evaluate('document.querySelector(\'input[aria-label="Filter changed files"]\').focus()')
      await win.webContents.debugger.sendCommand('Input.insertText', { text }); await wait(300)
    }
    await win.loadFile(process.env.CHANGED_FILE_LIST_HTML)
    win.showInactive()
    await pointAt(1, 1)
    await ready('Boolean(document.querySelector(\'input[aria-label="Filter changed files"]\') && document.querySelectorAll(".git-workbench__files > li").length > 0)')
    await capture('large-commit-top-dark', 760, 900)
    await hoverRow('glyph-0005.svg')
    await capture('large-commit-selected-and-hover-dark', 760, 900)
    await pointAt(1, 1)
    receipt.measurements.mountedAtTop = await mounted()
    await evaluate('document.querySelector(".git-workbench__details").scrollTop = 36 * 2400')
    await wait(300)
    await capture('large-commit-scrolled-dark', 760, 900)
    receipt.measurements.mountedScrolled = await mounted()
    receipt.measurements.firstVisibleScrolled = await evaluate(`(()=>{const top=document.querySelector('.git-workbench__details').getBoundingClientRect().top;return [...document.querySelectorAll('.git-workbench__files > li')].filter(e=>e.getBoundingClientRect().top>=top).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0]?.querySelector('.git-workbench__file-name')?.textContent ?? null})()`)
    await evaluate('document.querySelector(".git-workbench__details").scrollTop = 0')
    await type('features/git/FileList')
    await capture('large-commit-filtered-dark', 760, 900)
    receipt.measurements.filterCount = await evaluate('document.querySelector(".changed-file-list__count")?.textContent ?? null')
    await type('zz-no-such-file')
    await capture('large-commit-no-match-dark', 760, 600)
    await evaluate('document.querySelector(\'button[aria-label="Clear file filter"]\').click()'); await wait(300)
    await evaluate('changedFileListVisual.appearance("light")')
    await capture('large-commit-top-light-narrow', 420, 820)
    await hoverRow('glyph-0005.svg')
    await capture('large-commit-selected-and-hover-light-narrow', 420, 820)
    await pointAt(1, 1)
    await win.loadFile(process.env.CHANGED_FILE_LIST_HTML, { search: 'scene=small' })
    await ready('document.querySelectorAll(".git-workbench__files > li").length === 3')
    receipt.measurements.smallCommitHasFilter = await evaluate('Boolean(document.querySelector(\'input[aria-label="Filter changed files"]\'))')
    await evaluate('changedFileListVisual.appearance("dark")')
    await capture('small-commit-dark', 760, 640)
    await evaluate('changedFileListVisual.appearance("light")')
    await capture('small-commit-light-narrow', 420, 640)
    receipt.complete = true
  } catch (error) { receipt.complete = false; receipt.failure = { message: error instanceof Error ? error.message : String(error) } }
  writeFileSync(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2))
  app.quit()
})
