const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const [page, profile, output] = process.argv.slice(2)
for (const [key, path] of Object.entries({ home: process.env.HOME, appData: join(profile, 'app-data'), userData: profile, sessionData: join(profile, 'session') })) {
  mkdirSync(path, { recursive: true }); app.setPath(key, path)
  if (app.getPath(key) !== path) throw new Error('Private decoder fixture path was not applied: ' + key)
}
app.whenReady().then(async () => {
  let result = { passed: false }
  try {
    const window = new BrowserWindow({ show: false, width: 900, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    window.webContents.on('console-message', event => { if (/Error|Failed|WARNING/.test(event.message)) console.error(event.message) })
    await window.loadFile(page)
    const deadline = Date.now() + 20000
    while (!(await window.webContents.executeJavaScript('globalThis.__pageDecoderProof?.ready === true'))) {
      if (Date.now() > deadline) throw new Error('The real decoder fixture did not become ready')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const status = await window.webContents.executeJavaScript('globalThis.__pageDecoderProof')
    if (status.failure) throw new Error(status.failure)
    await window.webContents.executeJavaScript('globalThis.__repeatPages(12)')
    const memory = () => Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(window.webContents.getOSProcessId())], { encoding: 'utf8' }).trim())
    const warm = memory()
    await window.webContents.executeJavaScript('globalThis.__repeatPages(24)')
    const repeated = memory()
    result = await window.webContents.executeJavaScript('globalThis.__finishPages()')
    result.memory = { warmRssKiB: warm, repeatedRssKiB: repeated, growthKiB: repeated - warm }
    if (!Number.isFinite(warm) || !Number.isFinite(repeated) || repeated - warm > 48 * 1024) throw new Error('Repeated page visits did not stabilize within 48 MiB of the warmed renderer')
    window.destroy()
  } catch (error) { result = { ...result, passed: false, failure: String(error) } }
  writeFileSync(output, JSON.stringify(result, null, 2)); app.exit(result.passed ? 0 : 1)
})
