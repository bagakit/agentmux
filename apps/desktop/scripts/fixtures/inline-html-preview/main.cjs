const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, profile, evidence, nativeModule, workspacePath] = process.argv.slice(2)
app.setPath('userData', path.join(profile, 'user-data'))
app.setPath('sessionData', path.join(profile, 'session-data'))
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private native host' }], executors: {},
  workspaces: [{ id: 'inline-html-private', name: 'Field Notes', hostId: 'local', path: workspacePath, kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const report = { schema: 'agentmux.inline-html-native-process.v1', passed: false, pid: process.pid, frames: [], reads: [], writes: [], opens: [], releases: [], consoleMessages: [], userRunTouched: false }
const observed = new Map()
let win, files, previews, failNext = false, gateNext = false, pending = null
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = code => win.webContents.executeJavaScript(code, true)
async function wait(code) {
  const until = Date.now() + 15000
  while (Date.now() < until) { if (await evaluate(code)) return; await sleep(50) }
  assert.fail('Missing actual Renderer fact: ' + code)
}
async function waitFor(predicate, name) {
  const until = Date.now() + 15000
  while (Date.now() < until) { if (await predicate()) return; await sleep(50) }
  assert.fail('Missing native fact: ' + name)
}
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await sleep(80) }
async function click(code) {
  const point = await evaluate(`(()=>{const e=${code};if(!e)throw Error('Control missing: '+${JSON.stringify(code)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await paint()
}
const active = selector => `inlineHtmlProbe.activeRegion()?.querySelector(${JSON.stringify(selector)})`
const button = title => active(`button[title="${title}"]`)
async function screenshot(name) {
  await paint()
  const geometry = await evaluate('inlineHtmlProbe.geometry()')
  assert.ok(geometry.controls.length > 0, 'Visible production File header has controls')
  for (const control of geometry.controls) {
    assert.ok(control.width > 0 && control.inside, 'Header control stays in original Region: ' + control.label)
    assert.equal(control.overlapsClose, false, 'Close split does not cover header: ' + control.label)
    if (!control.disabled) assert.equal(control.hitOwnControl, true, 'Pointer hits own header control: ' + control.label)
  }
  const file = name + '.png'
  await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
  report.frames.push({ file, geometry })
}
async function pageFrame() {
  const src = await evaluate(`${active('iframe')}?.src`)
  return src ? win.webContents.mainFrame.framesInSubtree.find(frame => frame.url === src) : null
}
async function readPage(code) {
  const frame = await pageFrame()
  assert.ok(frame, 'Production HTML iframe exists as a real Chromium frame')
  return frame.executeJavaScript(code, true)
}
async function ready() {
  await waitFor(async () => {
    try { return await readPage(`Boolean(window.inlineScriptRan && window.relativeModuleRan && document.querySelector('img')?.naturalWidth > 0)`) } catch { return false }
  }, 'inline script, relative module and image completion')
  const facts = await readPage(`(()=>({url:location.href,heading:document.querySelector('h1').textContent,inline:window.inlineScriptRan,module:window.relativeModuleRan,css:getComputedStyle(document.documentElement).getPropertyValue('--asset-proof').trim(),image:document.querySelector('img').naturalWidth,isolation:window.previewIsolation}))()`)
  assert.equal(facts.heading, 'Unsaved release')
  assert.equal(facts.inline, true)
  assert.equal(facts.module, true)
  assert.equal(facts.css, 'relative-css-loaded')
  assert.ok(facts.image > 0)
  assert.deepEqual(facts.isolation, { bridge: 'undefined', node: 'undefined', electron: 'undefined', parent: 'SecurityError' })
  assert.equal(await evaluate(`${active('iframe')}.getAttribute('sandbox')`), 'allow-scripts')
  return facts
}
function assertFilePreserved(before, after, name) {
  assert.deepEqual(after.tabs, before.tabs, name + ': original Tab and Region identities')
  assert.deepEqual(after.layouts, before.layouts, name + ': original spatial layout')
  assert.deepEqual(after.documents, before.documents, name + ': exact source documents')
  assert.deepEqual(after.dirtyDocuments, before.dirtyDocuments, name + ': dirty state')
  assert.deepEqual(after.issues, before.issues, name + ': file state')
}
async function assertReleased(open) {
  await waitFor(() => report.releases.includes(open.id), 'production release receipt for ' + open.id)
  const response = await fetch(open.url)
  assert.notEqual(response.status, 200, 'Released preview no longer serves a resource')
  return { id: open.id, status: response.status }
}
async function capture() {
  await wait(`Boolean(document.querySelector('[data-tree-path="index.html"]'))`)
  await click(`document.querySelector('[data-tree-path="index.html"]')`)
  await wait(`Boolean(${active('.monaco-editor')})`)
  const saved = await fs.readFile(path.join(workspacePath, 'index.html'), 'utf8'), draft = saved.replace('Saved release', 'Unsaved release')
  assert.notEqual(draft, saved)
  // A long source line makes .view-lines wider than the visible viewport.
  // Click the actual editor viewport, then require its real editable focus.
  await click(active('.monaco-editor'))
  await wait(`Boolean(document.activeElement?.closest('.monaco-editor'))`)
  // A small real edit avoids treating an entire multiline document as typed
  // keystrokes (Monaco correctly applies auto-indent to that input shape).
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 4 })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 4 })
  await wait(`Boolean(document.activeElement?.closest('.find-widget'))`)
  await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Saved release' })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await wait(`Boolean(document.activeElement?.closest('.monaco-editor')) && !document.activeElement?.closest('.find-widget')`)
  await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Unsaved release' })
  await wait(`inlineHtmlProbe.facts().documents[inlineHtmlProbe.key('index.html')]?.content===${JSON.stringify(draft)}`)
  const baseline = await evaluate('inlineHtmlProbe.facts()')
  assert.equal(baseline.dirtyDocuments[config.workspaces[0].id + '\0index.html'], true)
  await screenshot('html-source-current-draft')
  await click(button('Preview current content'))
  report.wide = await ready()
  assertFilePreserved(baseline, await evaluate('inlineHtmlProbe.facts()'), 'Source to preview')
  const point = await readPage(`(()=>{const r=document.querySelector('#save-idea').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const offset = await evaluate(`(()=>{const r=${active('iframe')}.getBoundingClientRect();return{x:r.x,y:r.y}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x + offset.x, y: point.y + offset.y, button: 'left', clickCount: 1 })
  await waitFor(async () => (await readPage(`document.querySelector('#interaction-status').textContent`)) === 'Idea saved in this preview.', 'Actual pointer interaction in HTML page')
  report.wide.interaction = await readPage(`document.querySelector('#interaction-status').textContent`)
  report.outside = await readPage(`fetch(new URL('../outside-private.txt',location.href)).then(async r=>({status:r.status,body:await r.text()}))`)
  assert.notEqual(report.outside.status, 200)
  assert.ok(!report.outside.body.includes('PRIVATE_OUTSIDE_SENTINEL'))
  await screenshot('html-preview-wide')
  const first = report.opens.at(-1)
  await click(button('Show source'))
  await wait(`Boolean(${active('.monaco-editor')}) && !${active('iframe')}`)
  report.sourceRelease = await assertReleased(first)
  assertFilePreserved(baseline, await evaluate('inlineHtmlProbe.facts()'), 'Preview to source')
  await screenshot('html-source-returned-draft')

  failNext = true
  await click(button('Preview current content'))
  await wait(`Boolean(${active('[role="alert"]')})`)
  assert.equal(await evaluate(`Boolean(${button('Show source')})`), true)
  assertFilePreserved(baseline, await evaluate('inlineHtmlProbe.facts()'), 'Retryable transport failure')
  await screenshot('html-preview-retryable-error')
  await click(`Array.from(inlineHtmlProbe.activeRegion().querySelectorAll('button')).find(button=>button.textContent.includes('Retry preview'))`)
  report.retry = await ready()
  assertFilePreserved(baseline, await evaluate('inlineHtmlProbe.facts()'), 'Retry same source')
  await screenshot('html-preview-recovered')

  await evaluate('inlineHtmlProbe.split()')
  win.setContentSize(1000, 800)
  await ready()
  await wait(`Boolean(document.querySelector('[data-workbench-region-id="preview-neighbor"] .monaco-editor'))`)
  report.narrow = await evaluate('inlineHtmlProbe.geometry()')
  assert.ok(report.narrow.region.width <= 400, 'Actual narrow dual split is at most 400 DIP')
  await screenshot('html-preview-narrow-dual-split')
  const splitFacts = await evaluate('inlineHtmlProbe.facts()'), hidden = report.opens.at(-1)
  await evaluate(`inlineHtmlProbe.open('notes.md')`)
  await wait(`Boolean(${active('.monaco-editor')}) && !document.querySelector('.file-html-preview iframe')`)
  report.backgroundRelease = await assertReleased(hidden)
  const background = await evaluate('inlineHtmlProbe.facts()')
  assert.deepEqual(background.tabs['file:inline-html-private:index.html'], splitFacts.tabs['file:inline-html-private:index.html'])
  assert.deepEqual(background.documents, splitFacts.documents)
  assert.deepEqual(background.dirtyDocuments, splitFacts.dirtyDocuments)
  await evaluate(`inlineHtmlProbe.open('index.html')`)
  await ready()
  await click(button('Show source'))
  await wait(`Boolean(${active('.monaco-editor')})`)
  const beforeLate = await evaluate('inlineHtmlProbe.facts()')
  gateNext = true
  await click(button('Preview current content'))
  await waitFor(() => pending !== null, 'delayed actual owner allocation')
  const late = report.opens.at(-1)
  await click(button('Show source'))
  pending.resolve(); pending = null
  report.lateRelease = await assertReleased(late)
  await wait(`Boolean(${active('.monaco-editor')}) && !${active('iframe')}`)
  assertFilePreserved(beforeLate, await evaluate('inlineHtmlProbe.facts()'), 'Late response cannot revive old preview')
  await screenshot('html-source-after-late-response')
  await click(button('Preview current content'))
  await ready()
  const unmounted = report.opens.at(-1)
  await evaluate('inlineHtmlProbe.unmount()')
  report.unmountRelease = await assertReleased(unmounted)
  assert.equal(report.writes.length, 0, 'Viewing and retrying never invoke the file save owner')
  assert.equal(await fs.readFile(path.join(workspacePath, 'index.html'), 'utf8'), saved, 'Saved HTML bytes remain unchanged')
  report.draft = { nativeMonacoInput: true, sourcePreserved: true, dirtyPreserved: true, tabAndRegionPreserved: true, writes: 0 }
}
app.whenReady().then(async () => {
  try {
    const { WorkspaceFiles, HtmlFilePreviews, WORKSPACE_FILE_INVALIDATED_CHANNEL } = await import(nativeModule)
    files = new WorkspaceFiles(() => ({ kind: 'local' }))
    const workspace = id => { const found = config.workspaces.find(item => item.id === id); if (!found) throw Error('Unknown private workspace'); return found }
    previews = new HtmlFilePreviews(files, id => config.workspaces.find(item => item.id === id))
    ipcMain.on('fixture:boot', event => { event.returnValue = { config } })
    ipcMain.handle('git:status', () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath }))
    for (const [channel, method] of [['files:readDirectory', 'readDirectory'], ['files:read', 'read'], ['files:readPreview', 'readPreview'], ['files:write', 'write']]) ipcMain.handle(channel, async (_event, id, input, options) => {
      const value = await files[method](workspace(id), input, options)
      if (method === 'read' || method === 'readPreview') report.reads.push({ method, workspaceId: id, path: input, status: value.status })
      if (method === 'write') report.writes.push({ workspaceId: id, path: input.path })
      return value
    })
    const trustedFrame = event => assert.equal(event.senderFrame, win.webContents.mainFrame, 'HTML preview requires original application frame')
    ipcMain.handle('files:openHtmlPreview', async (event, id, file, content) => {
      trustedFrame(event)
      if (failNext) { failNext = false; throw Error('Private fixture: first preview transport failed; source is retained.') }
      const value = await previews.open(workspace(id), file, content)
      report.opens.push({ ...value, workspaceId: id, path: file })
      if (gateNext) { gateNext = false; await new Promise(resolve => { pending = { resolve } }) }
      return value
    })
    ipcMain.handle('files:releaseHtmlPreview', (event, id) => { trustedFrame(event); previews.release(id); report.releases.push(id) })
    ipcMain.handle('files:observe', async (event, id, file) => { const key = id + '\0' + file; if (!observed.has(key)) observed.set(key, await files.observe(workspace(id), file, () => event.sender.send(WORKSPACE_FILE_INVALIDATED_CHANNEL, { workspaceId: id, path: file }))) })
    ipcMain.handle('files:unobserve', async (_event, id, file) => { const key = id + '\0' + file; await observed.get(key)?.(); observed.delete(key) })
    ipcMain.handle('files:reveal', () => { throw Error('Private capture does not open system UI') })
    ipcMain.handle('files:openSystem', () => { throw Error('Private capture does not open system applications') })
    win = new BrowserWindow({ show: false, width: 1260, height: 850, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload.cjs') } })
    win.webContents.on('console-message', (_event, _level, message) => { report.consoleMessages.push(message) })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await wait('Boolean(window.inlineHtmlProbe)')
    await capture()
    assert.equal(report.consoleMessages.some(message => message.includes('Refused to') && message.includes('Content Security Policy')), false, 'No blocked production iframe or asset request')
    report.passed = true
  } catch (error) {
    report.failure = { name: error.name, message: error.message, stack: error.stack }
    try { report.failureFacts = await evaluate('window.inlineHtmlProbe?.facts()') } catch { /* Initialization may be the failed step. */ }
    if (win) await fs.writeFile(path.join(evidence, 'failed-native-frame.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    pending?.resolve()
    for (const dispose of observed.values()) await dispose()
    await previews?.dispose()
    await files?.dispose()
    await fs.writeFile(path.join(evidence, 'native-render.json'), JSON.stringify(report, null, 2))
    if (!report.passed) console.error('file_editing_probe_failed=' + report.failure?.message)
    app.exit(report.passed ? 0 : 1)
  }
})
