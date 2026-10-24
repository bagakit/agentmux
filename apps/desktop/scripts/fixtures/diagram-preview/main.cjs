const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const [html, profile, evidence, mode, nativeModule, engineFile] = process.argv.slice(2)
app.setPath('userData', profile)
app.on('window-all-closed', () => {})
const report = { passed: false, mode, scenarios: [], userRunTouched: false, renders: [], cancellations: [] }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const { FileDiagramRenderer } = await import(pathToFileURL(nativeModule).href)
  const { cases } = await import(pathToFileURL(path.join(__dirname, 'cases.mjs')).href)
  const renderer = new FileDiagramRenderer({ rendererFile: engineFile })
  ipcMain.handle('diagram-proof:render', (_event, request) => { report.renders.push({ id: request.id, kind: request.kind, page: request.page, theme: request.theme }); return renderer.render(request) })
  ipcMain.handle('diagram-proof:cancel', (_event, id) => { report.cancellations.push(id); renderer.cancel(id) })
  const win = new BrowserWindow({ width: 1100, height: 860, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const evaluate = code => win.webContents.executeJavaScript(code, true)
  const facts = () => evaluate('diagramPreviewProbe.facts()')
  async function until(expression, message, timeout = 45000) {
    const deadline = Date.now() + timeout
    while (!await evaluate(expression)) { assert.ok(Date.now() < deadline, message); await delay(25) }
    await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  }
  const capture = async name => { await delay(70); await fs.writeFile(path.join(evidence, `${mode}-${name}.png`), (await win.webContents.capturePage()).toPNG()) }
  const click = async selector => {
    const box = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)} })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', ...box, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...box, button: 'left', clickCount: 1 })
    await delay(30)
  }
  try {
    await win.loadFile(html)
    await until('Boolean(window.diagramPreviewProbe)', 'The production Markdown fixture must mount')
    for (const item of cases) {
      win.setContentSize(item.width, item.height)
      await evaluate(`diagramPreviewProbe.set(${JSON.stringify(item)})`)
      await until(`Boolean(document.querySelector('[data-scenario="${item.slug}"] .md-diagram-image__thumb')?.naturalWidth)`, `${item.slug}: the real engine image must decode`)
      const scenario = { slug: item.slug, language: item.language, theme: item.theme, before: await facts() }
      report.scenarios.push(scenario)
      const f = scenario.before, image = f.image
      assert.equal(f.appearance, item.theme, 'The real theme runtime must project the requested palette')
      const source = await evaluate('diagramPreviewProbe.source()')
      await fs.writeFile(path.join(evidence, `${mode}-${item.slug}.svg`), source)
      const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/.exec(source)?.[1].trim().split(/[\s,]+/).map(Number)
      scenario.svgViewBox = viewBox
      assert.ok(image && image.naturalWidth > 0 && image.naturalHeight > 0, 'The renderer must produce a real decoded vector')
      await capture(item.slug)
      assert.ok(image.height <= Math.min(300, item.height / 2) + 1, 'Thumbnail must obey 300px and 50dvh height cap')
      assert.ok(image.width <= f.preview.clientWidth + 1, 'Thumbnail must fit the reading width')
      assert.ok(image.width <= image.naturalWidth + 1 && image.height <= image.naturalHeight + 1, 'Small diagrams must not upscale')
      const aspect = viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0 ? viewBox[2] / viewBox[3] : image.naturalWidth / image.naturalHeight
      assert.ok(Math.abs(image.height - image.width / aspect) <= 1, 'Thumbnail must retain the complete SVG viewport aspect ratio within CSS pixel rounding')
      assert.ok(f.preview.scrollHeight <= f.preview.clientHeight + 1 && f.preview.scrollWidth <= f.preview.clientWidth + 1, 'The diagram must fit without a nested clipping scrollport')
      assert.ok(f.reading.scrollWidth <= f.reading.clientWidth + 1, 'The document must not widen outside a narrow reading Region')
      for (const label of item.labels ?? []) assert.ok(source.includes(label), `${item.slug}: original source label must reach the actual SVG`)
      scenario.svgBytes = Buffer.byteLength(source)
      if (item.small) assert.ok(image.height < 150 && image.width < 300, 'draw.io small page must keep its actual scale')
      await evaluate("document.querySelector('.file-markdown-preview').scrollTop = 40")
      const baseline = await facts(), renders = report.renders.length
      assert.ok(baseline.reading.scrollTop > 0, 'Focus restoration must be checked at an actual nonzero document reading position')
      await click('.md-diagram-image')
      await until("Boolean(document.querySelector('.md-conversation-image__full')?.naturalWidth)", 'The enlargement must use a decoded image')
      scenario.open = await facts()
      assert.deepEqual(scenario.open.controls.map(control => control.label), ['Close image', 'Zoom out', 'Zoom in', 'Fit image'])
      assert.ok(scenario.open.controls.every(control => control.icon), 'The real theme sprite must supply every discoverable image control')
      assert.equal(scenario.open.full.src, baseline.image.src, 'Enlargement must reuse the exact object URL')
      assert.equal(report.renders.length, renders, 'Opening the viewer must not render another engine job')
      assert.equal(scenario.open.workers, baseline.workers, 'Opening the viewer must not start another DOT Worker')
      const full = scenario.open.full, viewport = scenario.open.imageViewport
      assert.ok(full.left >= viewport.left - 1 && full.top >= viewport.top - 1 && full.right <= viewport.right + 1 && full.bottom <= viewport.bottom + 1, 'Fit must show all four image edges inside the modal viewport')
      assert.ok(scenario.open.modal.width <= item.width - 30 && scenario.open.modal.height <= item.height - 30, 'Viewer controls must stay inside the current viewport')
      await capture(`${item.slug}-open`)
      if (item.interact) {
        for (let i = 0; i < 8; i++) await click('[aria-label="Zoom in"]')
        scenario.zoomed = await facts()
        assert.ok(parseInt(scenario.zoomed.zoom) > 100, 'Zoom controls must enlarge the current image')
        assert.ok(scenario.zoomed.full.width > viewport.width || scenario.zoomed.full.height > viewport.height, 'The interaction fixture must really require panning')
        const center = { x: Math.round((viewport.left + viewport.right) / 2), y: Math.round((viewport.top + viewport.bottom) / 2) }
        const drag = async sign => {
          // Keep each trusted pointer sweep inside the native window. Moving a hidden
          // Electron pointer outside its bounds can become a platform leave/cancel.
          for (let i = 0; i < 8; i++) {
            const end = { x: Math.round(center.x + sign * (viewport.width / 2 - 12)), y: Math.round(center.y + sign * (viewport.height / 2 - 12)) }
            win.webContents.sendInputEvent({ type: 'mouseMove', ...center })
            win.webContents.sendInputEvent({ type: 'mouseDown', ...center, button: 'left', clickCount: 1 })
            win.webContents.sendInputEvent({ type: 'mouseMove', ...end, button: 'left' })
            win.webContents.sendInputEvent({ type: 'mouseUp', ...end, button: 'left', clickCount: 1 })
            await delay(20)
          }
          return facts()
        }
        scenario.leadingEdge = await drag(1)
        scenario.trailingEdge = await drag(-1)
        if (scenario.zoomed.full.width > viewport.width) {
          assert.ok(Math.abs(scenario.leadingEdge.full.left - viewport.left) < 2, 'Pan must reach the original left edge')
          assert.ok(Math.abs(scenario.trailingEdge.full.right - viewport.right) < 2, 'Pan must reach the original right edge')
        }
        if (scenario.zoomed.full.height > viewport.height) {
          assert.ok(Math.abs(scenario.leadingEdge.full.top - viewport.top) < 2, 'Pan must reach the original top edge')
          assert.ok(Math.abs(scenario.trailingEdge.full.bottom - viewport.bottom) < 2, 'Pan must reach the original bottom edge')
        }
        await capture(`${item.slug}-pan`)
        await click('[aria-label="Fit image"]')
        assert.equal((await facts()).zoom, '100%', 'Fit must restore the complete diagram')
      }
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await until("!document.querySelector('.md-conversation-image__lightbox')", 'Escape must close the enlargement')
      await delay(50)
      scenario.closed = await facts()
      assert.equal(scenario.closed.activeTrigger, true, 'Escape must restore the original diagram trigger focus')
      assert.equal(scenario.closed.reading.scrollTop, baseline.reading.scrollTop, 'Escape must preserve the document reading position')
      assert.equal(scenario.closed.image.src, baseline.image.src, 'Closing must keep the original thumbnail source')
      assert.equal(report.renders.length, renders, 'Opening, panning and closing must not invoke another engine job')
      assert.equal(scenario.closed.workers, baseline.workers, 'Opening, panning and closing must not invoke another Worker')
      if (item.nextPage) {
        assert.equal(scenario.closed.page, '1 / 2')
        const old = scenario.closed.image.src
        await click('[aria-label="Next diagram page"]')
        await until(`Boolean(document.querySelector('.md-diagram-image__thumb')?.naturalWidth && document.querySelector('.md-diagram-image__thumb').src !== ${JSON.stringify(old)})`, 'The second draw.io page must decode')
        assert.equal((await facts()).page, '2 / 2')
        assert.ok((await evaluate('diagramPreviewProbe.source()')).includes('Second page'), 'Next page must use the actual second page source')
        scenario.nextPage = await facts()
        await capture(`${item.slug}-second-page`)
      }
    }
    report.passed = true
  } catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    renderer.dispose(); win.destroy()
    report.remainingWindows = BrowserWindow.getAllWindows().length
    await fs.writeFile(path.join(evidence, `${mode}.render.json`), JSON.stringify(report, null, 2))
    app.exit(report.passed ? 0 : 1)
  }
}).catch(async error => { report.failure = { name: error.name, message: error.message, stack: error.stack }; await fs.writeFile(path.join(evidence, `${mode}.render.json`), JSON.stringify(report, null, 2)); app.exit(1) })
