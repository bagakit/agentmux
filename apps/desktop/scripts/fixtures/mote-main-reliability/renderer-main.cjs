const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2), restoring = process.argv.includes('--restore')
app.setPath('userData', path.join(privateRoot, 'userData')); app.setPath('sessionData', path.join(privateRoot, 'sessionData'))
const result = { passed: false, captureOnly: true, images: [], operations: [], interactions: [], errors: [] }
let win
app.whenReady().then(async () => {
 try {
  Menu.setApplicationMenu(null)
  win = new BrowserWindow({ width: 1180, height: 850, useContentSize: true, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
  const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
  const panel = 'document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'
  await win.loadFile(html, { query: { phase: restoring ? 'restore' : 'seed', retained: '1', zoneSelection: '1', initialUnbound: '1' } })
  await until('window.moteReliabilityCapture?.ready && ' + panel + '?.querySelector(".mote-start .tiptap")')
  await read('window.__connectionsTrustedEvents=window.moteReliabilityCapture.facts().trustedEvents')
  app.focus({ steal: true }); win.show(); win.focus(); win.webContents.focus(); await settle()
  const facts = () => read('window.moteReliabilityCapture.facts()')
  async function capture(name) {
    await settle(); const current = await facts(); assert.deepEqual(current.writes, [])
    const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
    result.images.push(file); result.operations.push({ name, facts: current, text: await read('document.body.innerText') })
  }
  result.initial = await facts()
  const composer = panel + '.querySelector(".mote-start [contenteditable=true]")'
  if (restoring) {
    await until(panel + '.innerText.includes("最近在关注什么") && ' + composer + '.innerText.includes("较晚的草稿")')
    assert.equal(result.initial.bootstrap.initialization.seedApplied, false)
    assert.equal(result.initial.calls.some(value => value.method === 'agent.open' || value.method === 'setup.advance'), false)
    await capture('06-restart-original-input-and-later-draft'); result.final = await facts(); result.passed = true; return
  }
  await until(panel + '.querySelector("button[aria-label=Send]")')
  await click('js:' + composer); win.webContents.selectAll(); await win.webContents.insertText('最近在关注什么？')
  await until(panel + '.querySelector("button[aria-label=Send]")?.disabled===false')
  await read('window.moteReliabilityCapture.holdNext()')
  await click('js:' + panel + '.querySelector("button[aria-label=Send]")')
  await until('Object.values(window.moteReliabilityCapture.facts().references).some(value=>value.deferredInput?.prompt==="最近在关注什么？") && ' + composer + '.innerText.trim()===""')
  await capture('01-first-input-retained-once')
  await click('js:[...' + panel + '.querySelectorAll(".mote-first-message button")].find(node=>node.textContent.trim()==="核对")')
  await until(panel + '.querySelector(".mote-first-message")?.dataset.stage==="unconfirmed"')
  await click('js:' + composer); await win.webContents.insertText('较晚的草稿，先留在这里。')
  await capture('02-original-operation-unconfirmed-with-later-draft')
  win.setContentSize(760, 720); await read('window.moteReliabilityCapture.theme(true)'); await capture('03-narrow-light-input-custody')
  await win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  win.setContentSize(760, 480); await capture('04-short-reduced-motion-original-input')
  win.setContentSize(1180, 850); await read('window.moteReliabilityCapture.sourceFailure()'); await settle()
  const tools='[...document.querySelectorAll("[data-surface-tools-toggle]")].find(node=>node.checkVisibility())'
  await click('js:'+tools); await settle()
  if(!await read('document.querySelector(".workspace-files-source")?.checkVisibility()')) { await click('js:'+tools); await settle() }
  await until('document.querySelector(".workspace-files-source")?.innerText.includes("original Source directory is unconfirmed")')
  assert.equal(await read('[...document.querySelectorAll("button")].some(node=>node.checkVisibility()&&node.textContent.includes("Choose new folder"))'),false)
  await capture('05-original-files-service-window')
  result.final = await facts()
  assert.deepEqual(result.final.identities, result.initial.identities)
  assert.deepEqual(result.final.runs, result.initial.runs)
  assert.equal(result.final.calls.some(value => value.method === 'agent.open' || value.method === 'setup.advance'), false)
  await until('JSON.stringify(localStorage.getItem("agentmux-workbench-v1")).includes("最近在关注什么")')
  result.passed = true
 } catch (error) {
  result.failure = { message: error.message, stack: error.stack }
  if (win) { result.dom = await win.webContents.executeJavaScript('document.body.innerText').catch(() => null); await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {}) }
 } finally { await fs.writeFile(path.join(evidence, restoring ? 'renderer-restart-result.json' : 'renderer-result.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.quit() }
})
