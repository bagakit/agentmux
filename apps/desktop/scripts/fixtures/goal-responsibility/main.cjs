const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const [html, preload, sourcePath, privateRoot, evidence, phase] = process.argv.slice(2)
assert.ok(phase === 'capture' || phase === 'restore', 'Choose one private process phase.')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
const result = { schema: 'agentmux.goal-responsibility-visual-render.v1', phase, passed: false, frames: [],
  interactions: [], consoleErrors: [], rendererFailures: [], userRunTouched: false, windowShown: false,
  windowFocused: false, windowFacts: [], activationPolicy: process.platform === 'darwin' ? 'prohibited' : 'platform-default' }
let win
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const evaluate = expression => win.webContents.executeJavaScript(expression)
function observePrivateWindow(stage) {
  const fact = { stage, windowId: win.id, visible: win.isVisible(), focused: win.isFocused(), focusable: win.isFocusable(),
    focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null, bounds: win.getContentBounds(),
    windows: BrowserWindow.getAllWindows().map(window => ({ id: window.id, visible: window.isVisible(), focused: window.isFocused() })) }
  result.windowFacts.push(fact)
  assert.equal(fact.visible, false, 'The private proof Window must remain hidden.')
  assert.equal(fact.focused, false, 'CDP Renderer focus must not focus the OS Window.')
  assert.equal(fact.focusable, false, 'The private proof Window must not acquire OS focus.')
  assert.equal(fact.focusedWindowId, null, 'No Window in this private Electron process may take OS focus.')
  assert.equal(fact.windows.length, 1, 'The proof must not open another Window.')
  assert.equal(result.windowShown, false)
  assert.equal(result.windowFocused, false, 'A transient Window focus event cannot qualify.')
  return fact
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await evaluate(expression)) return
    await delay(25)
  }
  throw new Error('Timed out while observing the original private Renderer: ' + expression)
}
async function paint() {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await delay(90)
}
const visible = expression => `(${expression} && ${expression}.getBoundingClientRect().width > 0 && ${expression}.getBoundingClientRect().height > 0)`
const button = (label, within = 'document') => `([...${within}.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(label)} || node.getAttribute('aria-label') === ${JSON.stringify(label)}))`
async function click(expression, purpose) {
  observePrivateWindow('before-pointer:' + purpose)
  const point = await evaluate(`(() => { const element = ${expression};
    if (!element || element.disabled) throw new Error('The actual target is unavailable.');
    element.scrollIntoView({block:'nearest',inline:'nearest'}); const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error('The actual target is hidden.');
    const x=rect.x+rect.width/2,y=rect.y+rect.height/2;
    if(!element.contains(document.elementFromPoint(x,y)))throw new Error('Another surface covers the actual target.');
    return {x,y}; })()`)
  for (const type of ['mousePressed', 'mouseReleased'])
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  result.interactions.push({ purpose, kind: 'actual-cdp-pointer', point })
  await paint()
  observePrivateWindow('after-pointer:' + purpose)
}
async function dimensions(width, mode) {
  // BrowserWindow remains hidden and cannot acquire the person's OS focus.
  win.setContentSize(width, 900)
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`goalResponsibilityVisual.appearance(${JSON.stringify(mode)})`)
  await paint()
  await waitFor(`document.documentElement.dataset.appearance === ${JSON.stringify(mode)}`)
}
async function capture(name, width, mode) {
  observePrivateWindow('before-frame:' + name)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await paint()
  const image = await win.webContents.capturePage(), bytes = image.toPNG(), size = image.getSize()
  assert.equal(size.width, width)
  assert.equal(size.height, 900)
  assert.ok(bytes.length > 4096 && !image.isEmpty(), 'A blank or missing frame cannot qualify.')
  const bitmap = image.toBitmap(), colors = new Set()
  for (let offset = 0; offset < bitmap.length; offset += 4 * 37)
    colors.add(bitmap.subarray(offset, offset + 3).toString('hex'))
  assert.ok(colors.size > 24, 'A uniform frame cannot qualify as an actual product surface.')
  const file = name + '.png'
  await fs.writeFile(path.join(evidence, file), bytes)
  const dom = await evaluate(`({ responsibility: [...document.querySelectorAll('[data-goal-responsibility]')].map(e=>({goalId:e.dataset.goalResponsibility,text:e.textContent})),
    patrol: [...document.querySelectorAll('.goal-patrol')].map(e=>e.textContent),
    regions: [...document.querySelectorAll('[data-current-demand-state]')].map(e=>({state:e.dataset.currentDemandState,text:e.textContent})),
    mote: [...document.querySelectorAll('[data-mote-goal]')].map(e=>({goalId:e.dataset.moteGoal,text:e.textContent})),
    viewport: {width:innerWidth,height:innerHeight}, appearance: document.documentElement.dataset.appearance })`)
  assert.equal(dom.appearance, mode, 'The production theme owner must apply the requested brightness.')
  assert.ok(dom.responsibility.length || dom.regions.length, 'The complete frame must contain an actual responsibility consumer.')
  const window = observePrivateWindow('after-frame:' + name)
  result.frames.push({ name, width, height: 900, mode, file, sha256: hash(bytes), distinctSampleColors: colors.size, dom, window,
    rendererDocumentHasFocus: await evaluate('document.hasFocus()') })
}
const facts = () => evaluate('goalResponsibilityVisual.facts()')
const preserved = value => ({ sessions: value.sessions.map(item => ({ id: item.id, control: item.control, workspacePath: item.workspacePath })),
  workbench: value.workbench, drafts: value.drafts, notes: value.notes })
async function openDetail() {
  await evaluate('goalResponsibilityVisual.surface("list")')
  await waitFor('Boolean(document.querySelector("[data-demand-id]"))')
  await click('document.querySelector("[data-demand-id] .goals-row__copy > strong")', 'open-original-goal-detail')
  await waitFor('Boolean(document.querySelector("[data-goal-detail-id] .goal-patrol"))')
}
async function detailFrames(prefix) {
  for (const mode of ['light', 'dark']) for (const width of [1280, 620]) {
    await dimensions(width, mode)
    const responsibility = 'document.querySelector("[data-goal-detail-id] [data-goal-responsibility]")'
    await evaluate(`${responsibility}.scrollIntoView({block:'start'})`)
    await capture(`${prefix}-${width}-${mode}`, width, mode)
  }
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'))
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    win = new BrowserWindow({ show: false, focusable: false, width: 1280, height: 900,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
        additionalArguments: ['--goal-responsibility-source=' + sourcePath] } })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('console-message', details => {
      if (details.level === 'error') result.consoleErrors.push({ message: details.message, line: details.lineNumber, source: details.sourceId })
    })
    win.webContents.on('render-process-gone', (_event, details) => result.rendererFailures.push(details))
    win.on('show', () => { result.windowShown = true })
    win.on('focus', () => { result.windowFocused = true })
    observePrivateWindow('created')
    await win.loadFile(html)
    observePrivateWindow('loaded')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    result.rendererFocusEmulation = { enabled: true, window: observePrivateWindow('renderer-focus-emulation') }
    await waitFor('Boolean(window.goalResponsibilityVisual) && Boolean(document.querySelector(".app-shell"))')
    if (phase === 'restore') {
      const previous = JSON.parse(await fs.readFile(path.join(evidence, 'capture-render.json'), 'utf8'))
      assert.equal(await evaluate('goalResponsibilityVisual.restoredFromStorage'), true, 'A new process must read the first saved profile.')
      const restored = await facts()
      assert.equal(restored.snapshotId, previous.final.snapshotId)
      assert.deepEqual(preserved(restored), preserved(previous.final), 'The second process must retain original layout, drafts and Session/Run identities.')
      assert.deepEqual(restored.goal.patrols, previous.final.goal.patrols, 'The second process must read original patrol feedback.')
      assert.deepEqual(restored.calls, previous.final.calls, 'Relaunch cannot repeat any saved patrol input.')
      await openDetail()
      await dimensions(1280, 'light'); await capture('relaunch-1280-light', 1280, 'light')
      await dimensions(620, 'dark'); await capture('relaunch-620-dark', 620, 'dark')
      result.final = await facts()
      result.durability = { kind: 'private-renderer-profile', originalProfileRead: true, nativeLifecycleProven: false }
    } else {
      assert.equal(await evaluate('goalResponsibilityVisual.restoredFromStorage'), false, 'The first capture needs a fresh private profile.')
      // Four actual production consumers at both desktop widths and brightness modes.
      for (const mode of ['light', 'dark']) for (const width of [1280, 620]) {
        await dimensions(width, mode)
        await evaluate('goalResponsibilityVisual.surface("list")')
        await waitFor('Boolean(document.querySelector("[data-demand-id] [data-goal-responsibility]"))')
        await capture(`list-${width}-${mode}`, width, mode)
        await openDetail()
        await evaluate('document.querySelector("[data-goal-detail-id] [data-goal-responsibility]").scrollIntoView({block:"start"})')
        await capture(`detail-${width}-${mode}`, width, mode)
        await evaluate('goalResponsibilityVisual.surface("workbench")')
        await waitFor('Boolean(document.querySelector(".region-current-demand"))')
        await capture(`region-${width}-${mode}`, width, mode)
        await evaluate('goalResponsibilityVisual.surface("mote")')
        await waitFor('Boolean(document.querySelector("[data-mote-goal]"))')
        const mote = 'document.querySelector("[data-mote-goal] .mote-current-work__copy")'
        if (await evaluate(`${mote}.getAttribute('aria-expanded') !== 'true'`)) await click(mote, 'expand-original-mote-work')
        await capture(`mote-${width}-${mode}`, width, mode)
      }
      await dimensions(1280, 'light')
      await evaluate('goalResponsibilityVisual.surface("workbench")')
      const editor = 'document.querySelector("[data-workbench-region-id=\\"goal-responsibility-worker-region\\"] [aria-label=\\"Message Agent\\"]")'
      await waitFor(visible(editor))
      await click(editor, 'keep-unsent-original-worker-draft')
      const draft = '保留这条未发送草稿；核对同一 Goal 的原责任。'
      await win.webContents.debugger.sendCommand('Input.insertText', { text: draft })
      await waitFor(`Object.values(goalResponsibilityVisual.facts().drafts).includes(${JSON.stringify(draft)})`)
      const beforeClick = await facts()
      await openDetail()
      await click(button('PMO 巡查', 'document.querySelector("[data-goal-detail-id]")'), 'request-original-pmo-patrol-once')
      await waitFor(`goalResponsibilityVisual.facts().snapshotId === ${JSON.stringify(source.journey.deliveredSnapshotId)}`)
      const delivered = await facts()
      assert.equal(delivered.calls.filter(call => call.kind === 'recorded-request' && call.method === 'goal.patrol').length, 1)
      assert.deepEqual(preserved(delivered), preserved(beforeClick), 'Patrol navigation/input must retain the original private workface and draft.')
      assert.ok(delivered.goal.responsibility.executions.some(row => row.alert !== null), 'A delivered request cannot clear attention.')
      await detailFrames('delivered')
      await evaluate('goalResponsibilityVisual.flush()')
      await win.webContents.session.flushStorageData()
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
      await waitFor(`Boolean(window.goalResponsibilityVisual) && goalResponsibilityVisual.facts().snapshotId === ${JSON.stringify(source.journey.deliveredSnapshotId)}`)
      assert.equal(await evaluate('goalResponsibilityVisual.restoredFromStorage'), true)
      const reloaded = await facts()
      assert.deepEqual(preserved(reloaded), preserved(delivered), 'Reload must read the first original private layout and draft.')
      assert.deepEqual(reloaded.goal.patrols, delivered.goal.patrols)
      assert.equal(reloaded.calls.filter(call => call.kind === 'recorded-request' && call.method === 'goal.patrol').length, 1)
      await dimensions(620, 'light'); await capture('reload-delivered-620-light', 620, 'light')
      await evaluate('goalResponsibilityVisual.publishReport()')
      await waitFor(`goalResponsibilityVisual.facts().snapshotId === ${JSON.stringify(source.journey.reportedSnapshotId)}`)
      const reported = await facts()
      assert.ok(reported.goal.patrols.find(item => item.operationId === source.journey.patrol.params.operationId)?.report?.applied)
      assert.deepEqual(preserved(reported), preserved(reloaded), 'A recorded inspection publication cannot replace any original workface or input.')
      await detailFrames('reported')
      result.final = await facts()
      result.durability = { kind: 'private-renderer-profile', reloadReadOriginal: true, nativeLifecycleProven: false }
    }
    assert.equal(result.windowShown, false)
    assert.equal(result.windowFocused, false)
    assert.ok(result.windowFacts.length > result.frames.length, 'Actual nonempty hidden Window observations are required.')
    assert.deepEqual(result.rendererFailures, [])
    assert.deepEqual(result.consoleErrors, [])
    assert.equal(result.final.calls.some(call => call.kind === 'unrecorded'), false, 'No other operation may be silently mocked as applied.')
    assert.ok(result.frames.length >= (phase === 'capture' ? 25 : 2), 'A nonempty complete scenario/frame set is required.')
    await evaluate('goalResponsibilityVisual.flush()')
    await win.webContents.session.flushStorageData()
    observePrivateWindow('before-exit')
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
  } finally {
    await fs.writeFile(path.join(evidence, phase + '-render.json'), JSON.stringify(result, null, 2))
    win?.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
