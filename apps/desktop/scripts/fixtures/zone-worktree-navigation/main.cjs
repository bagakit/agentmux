const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const [url, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', join(privateRoot, 'profile'))
app.setPath('sessionData', join(privateRoot, 'session'))
app.commandLine.appendSwitch('disable-background-timer-throttling')
const actual = { passed: false, frames: [], operations: [], errors: [], loaded: [] }
let window
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds))
const evaluate = source => window.webContents.executeJavaScript(source)
const facts = () => evaluate('window.zoneNavigationFixture.facts()')
const visibleFunction = `element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'`
async function waitFor(expression, label = expression) {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await delay(50)
  }
  throw new Error('Timed out: ' + label)
}
async function settle() {
  await evaluate('document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))')
  await delay(160)
}
async function point(selector, text) {
  const result = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visibleFunction})
    const element = ${text === undefined ? 'nodes[0]' : 'nodes.find(element => element.textContent.trim() === ' + JSON.stringify(text) + ')'}
    if (!element) return null
    element.scrollIntoView({ block: 'nearest' })
    const box = element.getBoundingClientRect()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    return { x, y, hit: element.contains(document.elementFromPoint(x, y)), text: element.textContent, title: element.title }
  })()`)
  assert.ok(result?.hit, 'Visible, hittable control: ' + selector + (text ?? ''))
  return result
}
async function mouse(type, x, y, extra = {}) {
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...extra })
}
async function click(selector, text) {
  const target = await point(selector, text)
  await mouse('mouseMoved', target.x, target.y)
  await mouse('mousePressed', target.x, target.y, { button: 'left', clickCount: 1 })
  await mouse('mouseReleased', target.x, target.y, { button: 'left', clickCount: 1 })
  await settle()
  actual.operations.push({ kind: 'native-pointer', selector, text, target, facts: await facts() })
}
async function key(name) {
  const code = { ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, Enter: 13, ' ': 32, Tab: 9, Escape: 27 }[name]
  const params = { key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...params,
    ...(name === 'Enter' ? { text: '\r' } : name === ' ' ? { text: ' ' } : {}) })
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  await settle()
  actual.operations.push({ kind: 'native-key', key: name, focus: await focus(), facts: await facts() })
}
const focus = () => evaluate(`(() => { const element = document.activeElement; return { tag: element?.tagName,
  zoneId: element?.getAttribute('data-zone-id'), label: element?.getAttribute('aria-label'), focusVisible: element?.matches(':focus-visible') } })()`)
async function frame(name) {
  await settle()
  const dom = await evaluate(`(() => {
    const visible = ${visibleFunction}
    const panel = document.querySelector('.surface-tool-panel'), box = panel.getBoundingClientRect()
    return { width: box.width, height: box.height, theme: document.documentElement.dataset,
      focus: { zone: document.activeElement?.getAttribute('data-zone-id'), visible: document.activeElement?.matches(':focus-visible') },
      rows: [...document.querySelectorAll('[data-zone-id]')].filter(visible).map(element => ({ zoneId: element.dataset.zoneId,
        kind: element.dataset.zoneKind, name: element.querySelector('.workspace-zone-entry__name')?.textContent,
        branch: element.querySelector('.workspace-zone-entry__branch')?.textContent, metadata: element.querySelector('small')?.textContent,
        tooltip: element.querySelector('small')?.title, selected: element.getAttribute('aria-pressed'), title: element.title })),
      summaries: [...document.querySelectorAll('.workspace-changes-summary')].filter(visible).map(element => ({
        workspaceId: element.dataset.workspaceId, status: element.querySelector('strong')?.textContent, scope: element.querySelector('small')?.textContent, title: element.title })),
      geometry: ['.workspace-tool-explorer', '.workspace-zones-panel', '.workspace-zones-list'].map(selector => {
        const element = [...document.querySelectorAll(selector)].find(visible), rect = element?.getBoundingClientRect()
        return { selector, height: rect?.height, gridRows: element ? getComputedStyle(element).gridTemplateRows : null }
      }),
      git: [...document.querySelectorAll('[data-git-workspace]')].filter(visible).map(element => ({ workspaceId: element.dataset.gitWorkspace,
        path: element.querySelector('.workspace-git-path')?.textContent })), text: panel.innerText }
  })()`)
  const file = name + '.png'
  await writeFile(join(evidence, file), (await window.webContents.capturePage()).toPNG())
  actual.frames.push({ file, dom, facts: await facts() })
  await writeFile(join(evidence, 'actual.json'), JSON.stringify(actual, null, 2) + '\n')
  console.log('zone_capture_frame=' + file)
}
async function size(width, theme) {
  window.setContentSize(width + 32, 1000)
  await evaluate('window.zoneNavigationFixture.theme(' + JSON.stringify(theme) + ')')
  await settle()
  assert.equal(await evaluate("document.querySelector('.surface-tool-panel').getBoundingClientRect().width"), width)
}
async function selected(zoneId) {
  await waitFor('window.zoneNavigationFixture.facts().selectedZone === ' + JSON.stringify(zoneId), 'Exact selected Zone')
}
const zoneSelector = zoneId => '[data-zone-id=' + JSON.stringify(zoneId) + ']'

app.whenReady().then(async () => {
  app.dock?.hide()
  window = new BrowserWindow({ width: 332, height: 1000, show: false, frame: false, backgroundColor: '#17191d',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  window.webContents.on('render-process-gone', (_event, details) => actual.errors.push(details))
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) actual.errors.push({ message }) })
  await window.loadURL(url)
  window.showInactive()
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor('Boolean(window.zoneNavigationFixture && document.querySelector("[data-zone-id]"))', 'Actual Dock ready')
  const zones = await evaluate('window.zoneNavigationFixture.zones')
  await waitFor('document.querySelector(".workspace-changes-summary strong")?.textContent === "1 changed file"', 'Actual summary read')
  await size(300, 'dark')
  const handle = await point('.workspace-tools-resize-handle')
  await mouse('mouseMoved', handle.x, handle.y)
  await mouse('mousePressed', handle.x, handle.y, { button: 'left', clickCount: 1 })
  for (let step = 1; step <= 8; step++) await mouse('mouseMoved', handle.x, handle.y + (240 - handle.y) * step / 8, { button: 'left', buttons: 1 })
  await mouse('mouseReleased', handle.x, 240, { button: 'left', clickCount: 1 })
  actual.operations.push({ kind: 'native-splitter-drag', from: handle, toY: 240 })
  await frame('dock-300-dark')
  for (const [width, theme] of [[236, 'dark'], [300, 'light'], [236, 'light']]) {
    await size(width, theme); await frame('dock-' + width + '-' + theme)
  }
  await size(236, 'dark')
  await click('[data-space-tool="files-branches"]')
  for (let step = 0; step < 40 && (await focus()).zoneId !== zones.root; step++) await key('Tab')
  assert.equal((await focus()).zoneId, zones.root, 'Native Tab reaches original Zone button')
  const before = await facts()
  for (const [name, expected] of [['ArrowDown', zones.worktree], ['End', zones.unknown], ['Home', zones.root], ['ArrowDown', zones.worktree]]) {
    await key(name)
    assert.equal((await focus()).zoneId, expected)
    assert.equal((await facts()).selectedZone, before.selectedZone)
    for (const field of ['tabs', 'layouts', 'sessions', 'drafts', 'caret']) assert.deepEqual((await facts())[field], before[field], 'Arrow preserves ' + field)
  }
  assert.equal((await focus()).focusVisible, true)
  await frame('keyboard-focus-not-selection')
  await key('Enter'); await selected(zones.worktree)
  await waitFor('document.querySelector(".workspace-changes-summary")?.dataset.workspaceId === "worktree"')
  assert.equal((await facts()).resource.id, 'worktree')
  await frame('current-worktree')
  await key('ArrowDown'); await key(' '); await selected(zones.plain)
  await waitFor('document.querySelector(".workspace-changes-summary strong")?.textContent === "No Git repository"')
  assert.equal((await facts()).resource.id, 'plain')
  await frame('plain-folder')
  await click(zoneSelector(zones.home)); await selected(zones.home)
  assert.equal((await facts()).resource, null)
  assert.equal((await facts()).files.directoryPath, await evaluate('window.zoneNavigationFixture.expectedHomePath'))
  await frame('nested-home-scope')
  await click(zoneSelector(zones.worktree)); await selected(zones.worktree)
  const beforeManage = await facts()
  await click('[aria-label="Manage worktrees"]')
  await waitFor('window.zoneNavigationFixture.facts().tool === "git" && window.zoneNavigationFixture.facts().view === "branches"')
  await waitFor('[...document.querySelectorAll(".branch-row__open")].filter(' + visibleFunction + ').length === 3')
  assert.equal((await facts()).selectedZone, beforeManage.selectedZone)
  assert.deepEqual((await facts()).tabs, beforeManage.tabs)
  await frame('manage-worktrees-branches')
  await click('.branch-row__open', 'candidate/unbound-work')
  await waitFor('[...document.querySelectorAll(".branch-create-dialog")].some(' + visibleFunction + ')')
  await frame('create-worktree-form-no-write')
  await click('[aria-label="Close create worktree dialog"]')
  await click('[data-space-tool="files-branches"]')
  await click('.workspace-changes-summary')
  await waitFor('window.zoneNavigationFixture.facts().view === "changes"')
  const current = await facts()
  assert.equal(current.resource.id, 'worktree'); assert.equal(current.selectedZone, zones.worktree)
  await frame('changes-exact-worktree')
  await click('[data-space-tool="files-branches"]')
  await click(zoneSelector(zones.unknown)); await selected(zones.unknown)
  assert.equal((await facts()).resource, null)
  assert.equal(await evaluate('[...document.querySelectorAll(".workspace-changes-summary")].filter(' + visibleFunction + ').length'), 0)
  await frame('unknown-zone-kept')
  await click(zoneSelector(zones.root)); await selected(zones.root)
  const final = await facts()
  assert.equal(final.calls.some(call => call.method === 'forbidden-write'), false)
  for (const field of ['tabs', 'sessions', 'drafts']) assert.deepEqual(final[field], before[field], 'All actions preserve original ' + field)
  actual.loaded = await evaluate('performance.getEntriesByType("resource").map(entry => entry.name)')
  actual.final = final
  assert.deepEqual(actual.errors, [], 'Renderer errors are not a deliverable capture')
  actual.passed = true
}).catch(async error => {
  actual.failure = { name: error.name, message: error.message, stack: error.stack }
  if (window && !window.isDestroyed()) {
    try { actual.failureFacts = await facts(); await frame('failure') } catch (captureError) { actual.failureCaptureError = captureError.message }
  }
}).finally(async () => {
  if (window && !window.isDestroyed()) {
    try { actual.loaded = await evaluate('performance.getEntriesByType("resource").map(entry => entry.name)') } catch {}
  }
  await writeFile(join(evidence, 'actual.json'), JSON.stringify(actual, null, 2) + '\n')
  window?.destroy()
  app.exit(actual.passed ? 0 : 1)
})
