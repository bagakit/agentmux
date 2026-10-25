const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { app, BrowserWindow } = require('electron')
const [html, temporary, evidence, candidate] = process.argv.slice(2)
app.setPath('userData', path.join(temporary, 'user-data'))
app.setPath('sessionData', path.join(temporary, 'session-data'))
const report = { passed: false, candidate, cases: [], frames: [], console: [],
  boundary: 'Original GlobalRecallSurface → NotebookHome → NotebookGraph → NoteCanvas, full Desktop CSS and original Preview Graph API. Controlled directory metadata; no successful Host graph, live Runtime, OS focus, physical IME, durable restart or installation claim.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1200, height: 820, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) report.console.push(String(message)) })
    const read = code => { report.lastOperation = code; return win.webContents.executeJavaScript(code) }
    const paint = () => read('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
    const until = async (label, code) => {
      const end = Date.now() + 12000
      do { if (await read(code)) return; await new Promise(done => setTimeout(done, 40)) } while (Date.now() < end)
      throw Error('Original consumer did not settle: ' + label)
    }
    const click = async selector => {
      await read(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',inline:'nearest'})`)
      await paint()
      const point = await read(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw Error('Missing original control'); const r = n.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2; if (!n.contains(document.elementFromPoint(x,y))) throw Error('Original control obscured'); return {x,y} })()`)
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      await paint()
    }
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('directory', 'window.graphTitleProbe?.ready && document.querySelectorAll(".notebook-page-directory [data-note-id]").length === 3')
    await read(`window.graphTitleEvents=[];document.addEventListener('click',e=>graphTitleEvents.push({trusted:e.isTrusted,label:e.target.closest('button')?.getAttribute('aria-label')||e.target.textContent}),true)`)
    report.before = await read('graphTitleProbe.facts()')
    assert.equal(await read(`document.querySelector('.conversation-native-thread, .wf-native-process') === null`), true, 'Unrelated Workbench conversation readers are not mounted in this scene')
    assert.ok(report.before.sessions.length > 0, 'Controlled original Sessions exist before presentation changes')
    await click('[aria-label="Graph view"]')
    await until('original Graph unavailable receipt', 'graphTitleProbe.calls().length===1 && document.querySelector(".note-canvas-notice")?.textContent.includes(graphTitleProbe.calls()[0].error)')
    await read(`window.originalGraphTitle=document.querySelector('.survey-notebook-home > header input');window.originalGraphCanvas=document.querySelector('.survey-notebook-home > .note-canvas');window.originalGraphMode=document.querySelector('[aria-label="Graph view"]')`)
    for (const [width, height, appearance] of [[1200, 820, 'dark'], [420, 760, 'light'], [420, 560, 'light']]) {
      win.setContentSize(width, height)
      await read(`graphTitleProbe.theme(${JSON.stringify(appearance)})`)
      await until('theme and original responsive surface', `document.documentElement.dataset.appearance===${JSON.stringify(appearance)} && document.querySelector('.global-recall-surface').dataset.navigationStacked===${JSON.stringify(String(width === 420))}`)
      await read(`document.querySelector('.survey-notebook-home').scrollTop=0`)
      await paint()
      const geometry = await read(`(() => {
        const home=document.querySelector('.survey-notebook-home'), header=home.querySelector(':scope > header'), title=header.querySelector('h1'), canvas=home.querySelector(':scope > .note-canvas'), picker=home.querySelector(':scope > .recall-view-picker')
        const box=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
        const titleBox=box(title), hit=[.15,.5,.85].map(y=>header.contains(document.elementFromPoint(titleBox.x+Math.min(30,titleBox.width/2),titleBox.y+titleBox.height*y)))
        const modes=[...picker.querySelectorAll('button')].map(n=>{const r=box(n);return {mode:n.dataset.surfaceMode,selected:n.getAttribute('aria-selected'),hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),box:r}})
        return {width:innerWidth,height:innerHeight,appearance:document.documentElement.dataset.appearance,documentOverflow:document.documentElement.scrollWidth-innerWidth,
          home:box(home),header:box(header),title:titleBox,canvas:box(canvas),picker:box(picker),titleHits:hit,modes,
          gridRows:getComputedStyle(home).gridTemplateRows,canvasAlignment:getComputedStyle(canvas).alignSelf,
          titleValue:header.querySelector('input').value,notice:canvas.querySelector('.note-canvas-notice')?.textContent,
          originalNodes:window.originalGraphTitle===header.querySelector('input')&&window.originalGraphCanvas===canvas&&window.originalGraphMode===picker.querySelector('[aria-label="Graph view"]')}
      })()`)
      report.cases.push(geometry)
      assert.ok(geometry.canvas.y >= geometry.header.bottom && geometry.canvas.y >= geometry.picker.bottom, 'Original Notebook title and mode row remain above their Graph canvas')
      assert.deepEqual(geometry.titleHits, [true, true, true], 'Original Notebook title is fully hit-testable')
      assert.ok(geometry.modes.every(mode => mode.hit), 'Original mode controls are fully hit-testable')
      assert.equal(geometry.modes.find(mode => mode.mode === 'graph').selected, 'true')
      assert.equal(geometry.titleValue, 'Research notebook')
      assert.equal(geometry.originalNodes, true, 'Original title, mode and canvas nodes stay mounted')
      assert.ok(geometry.documentOverflow <= 1)
      assert.ok(geometry.notice.includes((await read('graphTitleProbe.calls()'))[0].error), 'Complete original failure reason is retained')
      assert.equal((await read('graphTitleProbe.calls()')).length, 1, 'Resizing and theme changes do not observe Graph again')
      if (candidate === 'green' && height !== 560) {
        const file = width === 1200 ? 'graph-wide-dark.png' : 'graph-narrow-light.png'
        await new Promise(done => setTimeout(done, 120))
        const bytes = (await win.webContents.capturePage()).toPNG()
        await fs.writeFile(path.join(evidence, file), bytes)
        report.frames.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), width, height, appearance })
      }
      // Downward overflow remains in the original scroll owner; the original caption is reachable.
      await read(`document.querySelector('.note-canvas-caption').scrollIntoView({block:'nearest'})`)
      await paint()
      assert.equal(await read(`(() => {const caption=document.querySelector('.note-canvas-caption'),home=document.querySelector('.survey-notebook-home'),r=caption.getBoundingClientRect(),h=home.getBoundingClientRect();return r.bottom<=h.bottom+1&&r.top>=h.top-1})()`), true, 'Original canvas caption remains reachable through its original scroll owner')
    }
    const requests = []
    for (const selector of ['[aria-label="Refresh saved graph"]', '.note-canvas-empty button']) {
      const before = (await read('graphTitleProbe.calls()')).length
      await click(selector)
      await until('same original Graph recovery port', `graphTitleProbe.calls().length===${before + 1} && !document.querySelector('[aria-label="Refresh saved graph"]').matches('[aria-busy="true"]')`)
      requests.push({ selector, calls: await read('graphTitleProbe.calls()') })
    }
    report.recovery = requests
    report.after = await read('graphTitleProbe.facts()')
    assert.deepEqual(report.after, report.before, 'Original Notebook, Session/Run, input drafts, workfaces and canvas viewport/layout are retained')
    report.events = await read('graphTitleEvents')
    assert.ok(report.events.length >= 3 && report.events.every(event => event.trusted), 'All external actions are trusted pointer input')
    const calls = await read('graphTitleProbe.calls()')
    assert.equal(calls.length, 3)
    assert.ok(calls.every(call => call.signal && call.error === calls[0].error))
    assert.deepEqual(calls.map(call => call.input), [{}, {}, {}], 'Graph and both recovery actions retain the original request')
    report.passed = true
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      report.failure.dom = await win.webContents.executeJavaScript('document.body.innerText').catch(() => null)
      await fs.writeFile(path.join(evidence, candidate + '-failure.png'), (await win.webContents.capturePage()).toPNG())
    }
  } finally {
    await fs.writeFile(path.join(evidence, candidate + '.json'), JSON.stringify(report, null, 2) + '\n')
    app.exit(report.passed ? 0 : 1)
  }
})
