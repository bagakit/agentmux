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
  win = new BrowserWindow({ width: 1180, height: 850, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
  const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
  const panel = 'document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'
  const editor = panel + '.querySelector(".mote-composer-surface .tiptap")'
  await win.loadFile(html, { query: { phase: restoring ? 'restore' : 'seed', retained: '1', zoneSelection: '1', initialUnbound: '1', readingHeld: '1' } })
  await until('window.moteComposerCapture?.ready && ' + editor)
  await read('window.__connectionsTrustedEvents=window.moteComposerCapture.facts().trustedEvents')
  app.focus({ steal: true }); win.show(); win.focus(); win.webContents.focus(); await settle()
  const facts = () => read('window.moteComposerCapture.facts()')
  async function capture(name, motion = false) {
    if (!motion) await settle()
    const current = await facts(); assert.deepEqual(current.writes, [])
    const frame = await read('(()=>{const e=' + editor + ';return {text:e.innerText,bounds:e.getBoundingClientRect().toJSON(),same:e===window.originalComposer,selection:window.getSelection()?.toString(),animations:document.getAnimations().filter(a=>Number.isFinite(a.effect?.getTiming().iterations)).map(a=>({name:a.animationName,time:a.currentTime,duration:a.effect.getTiming().duration,state:a.playState}))}})()')
    const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
    result.images.push(file); result.operations.push({ name, facts: current, frame, text: await read('document.body.innerText') })
  }
  result.initial = await facts()
  if (restoring) {
    await until(editor + '.innerText.includes("继续写下一个问题")')
    assert.equal(result.initial.bootstrap.initialization.seedApplied, false)
    await read('window.moteComposerCapture.release()')
    await until('!' + panel + '.querySelector(".mote-start[data-mode=reading]")')
    await capture('06-restart-original-mote-and-session-drafts')
    result.final = await facts(); result.passed = true; return
  }
  await click('js:' + editor)
  await win.webContents.insertText('保留这个想法，先把问题写下来。')
  await read('window.originalComposer=' + editor + ';(()=>{const text=window.originalComposer.querySelector("p").firstChild;const r=document.createRange();r.setStart(text,3);r.setEnd(text,7);getSelection().removeAllRanges();getSelection().addRange(r)})()')
  await capture('01-reading-fixed-input-dark')
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Animation.enable')
  await win.webContents.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: 0.05 })
  await read('window.moteComposerCapture.release()')
  await until('!' + panel + '.querySelector(".mote-start[data-mode=reading]")')
  const animations = await read('(()=>{const as=document.getAnimations().filter(a=>a.animationName==="mote-body-arrive");for(const a of as){a.pause();a.currentTime=Number(a.effect.getTiming().duration)/2}return as.length})()')
  assert.ok(animations > 0, 'The actual body transition is present at its intermediate frame')
  assert.equal(await read(editor + '===window.originalComposer'), true)
  await capture('02-main-body-transition-midframe', true)
  await read('document.getAnimations().filter(a=>a.animationName==="mote-body-arrive").forEach(a=>a.finish())')
  await win.webContents.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: 1 })
  await capture('03-main-fixed-input-dark')
  for (const dimension of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(result.operations[0].frame.bounds[dimension] - result.operations[2].frame.bounds[dimension]) <= 1,
    'The editing anchor stays fixed as Main controls arrive: ' + dimension)
  assert.equal(await read('getSelection().toString()'), '个想法，')
  await click('js:' + editor); win.webContents.selectAll(); await win.webContents.insertText('继续写下一个问题，原草稿仍在这里。')
  assert.equal(await read(editor + '===window.originalComposer'), true)
  win.setContentSize(760, 720); await read('window.moteComposerCapture.theme(true)')
  await capture('04-main-narrow-light-continued-typing')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  win.setContentSize(760, 480); await capture('05-main-short-reduced-motion')
  await read('window.moteComposerCapture.checkpoint()')
  result.final = await facts()
  assert.deepEqual(result.final.identities, result.initial.identities)
  assert.deepEqual(result.final.runs, result.initial.runs)
  assert.deepEqual(result.final.sessionDrafts, result.initial.sessionDrafts)
  result.passed = true
 } catch (error) {
  result.failure = { message: error.message, stack: error.stack }
  if (win) { result.dom = await win.webContents.executeJavaScript('document.body.innerText').catch(() => null); await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {}) }
 } finally { await fs.writeFile(path.join(evidence, restoring ? 'renderer-restart-result.json' : 'renderer-result.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.quit() }
})
