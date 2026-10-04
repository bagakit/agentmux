const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, profile, evidence, mode] = process.argv.slice(2)
app.setPath('userData', profile)
const report = { passed: false, mode, scenarios: [], userRunTouched: false }
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    await win.loadFile(html)
    const evaluate = code => win.webContents.executeJavaScript(code)
    const readyUntil = Date.now() + 10000
    while (!await evaluate("Boolean(document.querySelector('.md-table-scroll') && document.querySelector('img')?.naturalWidth > 0)")) {
      assert.ok(Date.now() < readyUntil, 'Production Markdown and local image must mount')
      await new Promise(done => setTimeout(done, 25))
    }
    for (const [name, width, height] of [['normal', 900, 580], ['narrow', 320, 420], ['short', 900, 220]]) {
      await evaluate(`markdownLayoutProbe.resize(${width},${height})`)
      await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
      // Hidden test windows still need the compositor to publish the completed frame.
      await new Promise(done => setTimeout(done, 70))
      const facts = await evaluate('markdownLayoutProbe.facts()')
      report.scenarios.push({ name, width, height, facts })
      await fs.writeFile(path.join(evidence, `${mode}-${name}.png`), (await win.webContents.capturePage()).toPNG())
      assert.deepEqual(facts.rows, [['Format', 'Reader', 'Source'], ['Markdown', 'Document', 'Editable'], ['CSV', 'Table', 'Editable'], ['PDF', 'Pages', 'Original bytes']], 'The actual three-column GFM table must exist')
      assert.ok(facts.image.naturalWidth > 0, 'A real decoded document image must create content pressure')
      assert.ok(facts.tableScroll.width > 0 && facts.tableScroll.height >= facts.table.height, 'The table scroll container must preserve intrinsic table height')
      assert.ok(facts.tableScroll.bottom <= facts.nextHeading.top, 'The following heading must remain after the visible table')
      assert.ok(facts.code.clientHeight >= facts.code.scrollHeight - 1, 'Code must retain full content height instead of vertical clipping')
      assert.ok(facts.root.scrollHeight > facts.root.clientHeight, 'A bounded reading Region must scroll vertically over the full document')
    }
    report.passed = true
  } catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    await fs.writeFile(path.join(evidence, `${mode}.render.json`), JSON.stringify(report, null, 2))
    win.destroy(); app.exit(report.passed ? 0 : 1)
  }
})
