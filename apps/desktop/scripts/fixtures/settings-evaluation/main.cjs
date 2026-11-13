const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const out = process.env.SETTINGS_EVALUATION_OUT
const options = JSON.parse(process.env.SETTINGS_EVALUATION_OPTIONS)
// This private preview cannot read or mutate the real App's profile, configuration or Sessions.
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(out, key), { recursive: true }); app.setPath(key, join(out, key)) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { scope: 'real-settings-renderer-with-preview-api', captureOnly: true, aestheticReview: 'not-performed', registered: [], rows: [], errors: [], businessState: 'unverified' }
// These actual preview API owners return fixture values or explicitly refuse native operations.
const unavailable = {
  agents: 'Executor discovery and Host liveness are preview data, not the real CLI installations.',
  'browser-profiles': 'Browser Profile resources and native Browsers are preview data.',
  capsule: 'The preview API explicitly refuses Capsule and its runtime management.',
  survey: 'The system default Browser association requires the real Desktop.',
  hosts: 'Host connections and maintenance require their original Host owners.',
  'remote-execution': 'The preview has no original execution/resource binding or remote Agent.',
  mobile: 'Mobile hosting and trusted device access require their original owners.',
  lark: 'Application authentication and connector hosting require their original owners.',
  discord: 'Application authentication and connector hosting require their original owners.'
}
app.whenReady().then(async () => {
  const analysis = await import(pathToFileURL(join(__dirname, 'analysis.mjs')).href)
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true } })
  win.webContents.debugger.attach('1.3')
  const evaluate = async expression => {
    const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await win.loadFile(join(out, 'compiled/index.html'))
  for (let attempts = 0; !(await evaluate('Boolean(window.settingsEvaluation)')); attempts++) {
    if (attempts >= 200) throw new Error('The Settings Renderer did not become available.')
    await wait(100)
  }
  report.registered = await evaluate('settingsEvaluation.registered')
  const selected = analysis.selectSections(report.registered, options.sections)
  const variants = options.modes.flatMap(mode => options.sizes.map(([width, height]) => ({ mode, width, height })))
  for (const variant of variants) {
    const { mode, width, height } = variant
    win.setContentSize(width, height)
    await evaluate(`settingsEvaluation.appearance(${JSON.stringify(mode)})`)
    await wait(100)
    for (const section of selected) {
      try {
        await evaluate(`settingsEvaluation.show(${JSON.stringify(section.id)})`)
        await wait(450)
        const facts = await evaluate(`settingsEvaluation.measure(${JSON.stringify(section.id)})`)
        const screenshot = `${mode}-${width}x${height}-${section.id}.jpg`
        const image = (await win.webContents.capturePage()).resize({ width, height, quality: 'best' })
        let bytes = image.toJPEG(75)
        for (let quality = 65; bytes.length > 60 * 1024 && quality >= 25; quality -= 10) bytes = image.toJPEG(quality)
        if (bytes.length > 60 * 1024) throw new Error('The complete screenshot exceeds the review image budget.')
        writeFileSync(join(out, screenshot), bytes)
        report.rows.push({ section: section.id, title: section.title, archetype: section.archetype, mode, viewport: { width, height },
          status: unavailable[section.id] ? 'state-unavailable' : 'measured', ...(unavailable[section.id] ? { stateUnavailable: unavailable[section.id] } : {}),
          screenshot, facts, issues: analysis.presentationIssues(section, facts, { width, height }) })
      } catch (error) {
        report.rows.push({ section: section.id, mode, viewport: { width, height }, status: 'render-failed', error: String(error.stack ?? error) })
      }
    }
  }
  analysis.validateCapture(report, selected, variants)
  const failures = report.rows.flatMap(row => row.issues.filter(issue => options.assertions.includes(issue.dimension)).map(issue => ({ section: row.section, mode: row.mode, viewport: row.viewport, ...issue })))
  report.assertions = options.assertions
  report.assertionFailures = failures
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ sections: selected.length, measurements: report.rows.length, stateUnavailable: selected.filter(section => unavailable[section.id]).map(section => section.id), presentationFailures: failures.length }))
  app.exit(failures.length ? 1 : 0)
}).catch(error => {
  report.errors.push(String(error.stack ?? error))
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(report, null, 2))
  console.error(report.errors.at(-1))
  app.exit(1)
})
