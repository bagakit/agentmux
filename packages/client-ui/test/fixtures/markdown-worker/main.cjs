const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, profile, output] = process.argv.slice(2)
app.setPath('userData', profile)
let win
const report = { passed: false, pid: process.pid, samples: [], console: [] }
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1100, height: 750, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, _level, message) => report.console.push(message))
    await win.loadFile(html)
    const evaluate = code => win.webContents.executeJavaScript(code, true)
    const until = Date.now() + 10_000
    while (!await evaluate('Boolean(window.mdWorkerProbe)')) { if (Date.now() > until) throw Error('Actual fixture did not mount'); await new Promise(resolve => setTimeout(resolve, 10)) }
    report.hidden = await evaluate('mdWorkerProbe.hidden()')
    assert.deepEqual(report.hidden, { workers: 0, katexCss: false })
    const code = size => 'const value = 123; // sample\n'.repeat(Math.ceil(size / 27)).slice(0, size)
    for (const [kind, source] of [['math','\\frac{1}{2}'], ['math','x+'.repeat(128)+'x'], ['math','x+'.repeat(360)+'x'], ['math','x+'.repeat(512)+'x'], ['math','x+'.repeat(2000)+'x'], ['math','x+'.repeat(8192)+'x'], ['code',code(1024)], ['code',code(16384)], ['code',code(65536)], ['code',code(1048576)], ['code','const html = "<img src=x onerror=alert(1)>";']]) {
      const result = await evaluate(`mdWorkerProbe.sample(${JSON.stringify(kind)},${JSON.stringify(source)})`)
      report.samples.push(result)
      assert.equal(result.activeMarkup, 0, 'Generated markup cannot activate source HTML')
      assert.ok(result.elements <= 3010, 'Actual mounted generated DOM stays bounded')
      assert.ok(result.ticks > 0 && result.maxTimerGap < 150, 'Main Renderer timer remains responsive: '+JSON.stringify(result))
      assert.equal(result.workers.every(job => job.terminated), true, 'Settled jobs release their Worker')
      if (!result.rendered) assert.equal(result.sourcePreserved, true, 'Budget/error fallback preserves exact original source')
    }
    assert.equal(report.samples[0].rendered, true)
    assert.equal(report.samples.find(sample => sample.kind === 'code').rendered, true)
    report.cancel = await evaluate('mdWorkerProbe.cancel()')
    assert.ok(report.cancel.jobs.length > 0); assert.equal(report.cancel.jobs.every(job => job.terminated), true); assert.equal(report.cancel.rendered, false)
    report.dense = await evaluate('mdWorkerProbe.dense()')
    assert.equal(report.dense.rendered, 100); assert.equal(report.dense.workersCreated, 2); assert.equal(report.dense.activeWorkers, 0); assert.ok(report.dense.peak <= 2); assert.ok(report.dense.maxTimerGap < 150)
    report.denseHidden = await evaluate('mdWorkerProbe.dense(true)')
    assert.equal(report.denseHidden.rendered, 0); assert.equal(report.denseHidden.activeWorkers, 0); assert.ok(report.denseHidden.peak <= 2); assert.equal(report.denseHidden.workersCreated, 2)
    assert.equal(report.console.some(message => message.includes('Content Security Policy') || message.includes('Refused to')), false)
    report.passed = true
  } catch (error) { report.failure = { message: error.message, stack: error.stack } }
  finally { await fs.writeFile(output, JSON.stringify(report,null,2)); app.exit(report.passed ? 0 : 1) }
})
