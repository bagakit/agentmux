const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const [url, privateRoot, evidence, mode] = process.argv.slice(2)
app.setPath('userData', join(privateRoot, 'profile'))
app.setPath('sessionData', join(privateRoot, 'session'))
app.commandLine.appendSwitch('disable-background-timer-throttling')
const actual = { passed: false, mode, frames: [], operations: [], detailChecks: [], errors: [], loaded: [], transport: [] }
const visible = `element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'`
const knowledge = '.topic-knowledge-panel'
const discovery = '.topic-knowledge-notice[aria-label="Knowledge discovery incomplete"]'
const unavailable = '.topic-knowledge-notice[aria-label="Knowledge sources unavailable"]'
const history = '.topic-knowledge-notice[aria-label="Search history unavailable"]'
let window
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds))
const evaluate = source => window.webContents.executeJavaScript(source)
const facts = () => evaluate('window.spaceContextFixture.facts()')
const nodes = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible})`
const first = selector => `(${nodes(selector)})[0]`
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
  await delay(120)
}
async function point(selector, scroll = true) {
  const target = await evaluate(`(() => {
    const element = ${first(selector)}
    if (!element) return null
    ${scroll ? "element.scrollIntoView({ block: 'nearest' })" : ''}
    const box = element.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
    return { x, y, hit: element.contains(document.elementFromPoint(x, y)), title: element.title, text: element.textContent }
  })()`)
  assert.ok(target?.hit, 'Visible, hittable original control: ' + selector)
  return target
}
async function mouse(type, target, options = {}) {
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, ...options })
}
async function click(selector, scroll = true) {
  const target = await point(selector, scroll)
  await mouse('mouseMoved', target)
  await mouse('mousePressed', target, { button: 'left', clickCount: 1 })
  await mouse('mouseReleased', target, { button: 'left', clickCount: 1 })
  await settle()
  actual.operations.push({ kind: 'native-pointer', selector, target, facts: await facts() })
}
async function key(name, modifiers = 0) {
  const code = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, Home: 36, End: 35, ' ': 32 }[name]
  const params = { key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, modifiers }
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...params,
    ...(name === 'Enter' ? { text: '\r' } : name === ' ' ? { text: ' ' } : {}) })
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  await settle()
  actual.operations.push({ kind: 'native-key', key: name, modifiers,
    focus: await evaluate('({tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label"), focusVisible: document.activeElement?.matches(":focus-visible")})'), facts: await facts() })
}
async function query(text) {
  await click('[aria-label="Search this Topic"]')
  await key('Home'); await key('End', 8)
  const selection = await evaluate(`(() => { const field = ${first('[aria-label="Search this Topic"]')};
    return { focused: document.activeElement === field, start: field.selectionStart, end: field.selectionEnd, value: field.value } })()`)
  assert.equal(selection.focused, true); assert.equal(selection.start, 0); assert.equal(selection.end, selection.value.length)
  actual.operations.push({ kind: 'observed-native-input-selection', selection })
  await window.webContents.debugger.sendCommand('Input.insertText', { text })
  await settle()
  assert.equal(await evaluate(first('[aria-label="Search this Topic"]') + '.value'), text)
  await key('Enter')
}
async function size(width, theme, height = 1000) {
  window.setContentSize(width + 268, height)
  await evaluate('window.spaceContextFixture.theme(' + JSON.stringify(theme) + ')')
  await settle()
  assert.equal(await evaluate('document.querySelector(".surface-tool-panel").getBoundingClientRect().width'), width)
}
async function label(expected) {
  await waitFor(first('.topic-knowledge-results__label') + '?.textContent === ' + JSON.stringify(expected), expected)
}
async function frame(name) {
  await settle()
  const dom = await evaluate(`(() => {
    const panel = document.querySelector('.surface-tool-panel'), current = ${first(knowledge)}
    const rect = panel.getBoundingClientRect(), status = ${first('.topic-knowledge-status')}
    return { dockWidth: rect.width, dockHeight: rect.height, knowledgeHeight: current?.getBoundingClientRect().height,
      selectedTool: ${nodes('[data-space-tool]')}.map(element => ({ label: element.getAttribute('aria-label'), selected: element.getAttribute('aria-pressed') })),
      scope: ${first('.topic-knowledge-scope')}?.textContent, count: ${first('.topic-knowledge-results__label')}?.textContent,
      query: ${first('[aria-label="Search this Topic"]')}?.value,
      notices: ${nodes('.topic-knowledge-notice')}.map(element => ({ label: element.getAttribute('aria-label'), open: element.open,
        error: element.classList.contains('topic-knowledge-notice--error'), text: element.textContent })),
      status: status ? { height: status.getBoundingClientRect().height, scrollHeight: status.scrollHeight, scrollTop: status.scrollTop, clientHeight: status.clientHeight } : null,
      rows: ${nodes('.topic-knowledge-row')}.map(element => ({ title: element.querySelector('strong')?.textContent, topicId: element.dataset.knowledgeTopicId,
        selected: element.getAttribute('aria-pressed') })),
      detail: ${first('.topic-knowledge-entry')}?.innerText,
      fileContexts: ${nodes('.workspace-tool-context [title]')}.map(element => ({ title: element.title, text: element.textContent })),
      zones: ${nodes('[data-zone-id]')}.map(element => ({ id: element.dataset.zoneId, selected: element.getAttribute('aria-pressed') })),
      git: ${nodes('[data-git-workspace]')}.map(element => ({ id: element.dataset.gitWorkspace, path: element.querySelector('.workspace-git-path')?.title })),
      text: panel.innerText }
  })()`)
  const file = name + '.png'
  await writeFile(join(evidence, file), (await window.webContents.capturePage()).toPNG())
  actual.frames.push({ file, dom, facts: await facts() })
  await writeFile(join(evidence, 'actual.json'), JSON.stringify(actual, null, 2) + '\n')
  console.log('space_context_frame=' + file)
}
async function refresh(mode, expected) {
  await evaluate('window.spaceContextFixture.observation(' + JSON.stringify(mode) + ')')
  await click('[aria-label="Refresh knowledge"]')
  await label(expected)
}
async function chosen(topicId) {
  await waitFor('window.spaceContextFixture.facts().selection?.topicId === ' + JSON.stringify(topicId), 'Original object selected')
}
async function fileRoot(expected) {
  await waitFor('window.spaceContextFixture.facts().latestDirectoryRead?.params.path === ' + JSON.stringify(expected), 'Original logical file directory')
}
async function toggleFiles(expand) {
  const selector = '[aria-label="' + (expand ? 'Show file tree' : 'Hide file tree') + '"]'
  if (await evaluate(nodes(selector) + '.length')) await click(selector)
}
async function detailGeometry() {
  return await evaluate(`(() => {
    const surface = ${first(knowledge)}, entry = ${first('.topic-knowledge-entry')}
    if (!surface || !entry) return null
    const header = entry.querySelector(':scope > header'), close = entry.querySelector('[aria-label="Close knowledge detail"]')
    const body = entry.querySelector('.topic-knowledge-entry__body')
    const bounds = element => { const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } }
    const intersect = (rect, clip, horizontal = true, vertical = true) => {
      const left = horizontal ? Math.max(rect.left, clip.left) : rect.left, right = horizontal ? Math.min(rect.right, clip.right) : rect.right
      const top = vertical ? Math.max(rect.top, clip.top) : rect.top, bottom = vertical ? Math.min(rect.bottom, clip.bottom) : rect.bottom
      return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
    }
    function clipping(element) {
      let rect = intersect(bounds(surface), { left: 0, top: 0, right: innerWidth, bottom: innerHeight })
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), horizontal = /auto|scroll|hidden|clip/.test(style.overflowX), vertical = /auto|scroll|hidden|clip/.test(style.overflowY)
        if (horizontal || vertical) rect = intersect(rect, bounds(ancestor), horizontal, vertical)
      }
      return rect
    }
    function measure(element) {
      if (!element) return null
      const rect = bounds(element), intersection = intersect(rect, clipping(element))
      const x = intersection.left + intersection.width / 2, y = intersection.top + intersection.height / 2
      return { rect, intersection, hit: intersection.width > 0 && intersection.height > 0 && element.contains(document.elementFromPoint(x, y)), x, y }
    }
    let readable = null
    if (body) for (const paragraph of body.querySelectorAll('p')) {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent.trim()) continue
        const range = document.createRange(); range.selectNodeContents(text)
        const clip = intersect(bounds(body), clipping(body))
        for (const line of range.getClientRects()) {
          const intersection = intersect(line, clip), x = intersection.left + intersection.width / 2, y = intersection.top + intersection.height / 2
          if (intersection.width >= 16 && intersection.height >= line.height - 1 && body.contains(document.elementFromPoint(x, y))) {
            readable = { text: text.textContent, line: { left: line.left, top: line.top, width: line.width, height: line.height }, intersection }; break
          }
        }
        if (readable) break
      }
      if (readable) break
    }
    const readers = [entry, body].filter(element => element && /auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1)
      .map(element => ({ selector: element === entry ? '.topic-knowledge-entry' : '.topic-knowledge-entry__body',
        scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }))
    return { surface: bounds(surface), header: measure(header), close: measure(close), body: measure(body),
      resultLabel: measure(surface.querySelector('.topic-knowledge-results__label')),
      resultText: surface.querySelector('.topic-knowledge-results__label')?.textContent, readable, readers }
  })()`)
}
async function checkDetail(name) {
  const geometry = await detailGeometry()
  assert.ok(geometry, 'Original detail is present')
  for (const part of ['header', 'close', 'resultLabel']) {
    const measured = geometry[part]
    assert.ok(measured?.hit, 'Actual clipped detail ' + part + ' is hittable')
    assert.ok(measured.intersection.height >= measured.rect.height - 1 && measured.intersection.width >= measured.rect.width - 1,
      'Original detail ' + part + ' is within its real clipping viewport')
  }
  assert.ok(geometry.body?.hit && geometry.body.intersection.height >= 16, 'Original body has a real readable viewport')
  assert.ok(geometry.readable?.text.trim(), 'A full original paragraph text line is actually visible, not merely in the DOM')
  assert.ok(geometry.readers.length <= 1, 'Detail has one vertical reading scroller, not nested scroll owners')
  actual.detailChecks.push({ name, geometry })
  return geometry
}
async function closeOriginalDetail(name, keepDiagnostics = false) {
  await click('[aria-label="Close knowledge detail"]', false)
  await waitFor('document.activeElement === window.__spaceContextOriginalRow', 'Close commit restores focus to the same original result row')
  assert.equal(await evaluate(nodes('.topic-knowledge-entry') + '.length'), 0)
  assert.equal(await evaluate(nodes('.topic-knowledge-row') + '.length'), 100)
  await point('.topic-knowledge-row', false)
  if (keepDiagnostics) assert.equal(await evaluate(first(discovery) + '.open && ' + first(unavailable) + '.open'), true)
  actual.detailChecks.push({ name, closed: true, originalRowFocused: true, diagnosticsKeptOpen: keepDiagnostics,
    facts: await facts() })
}

app.whenReady().then(async () => {
  app.dock?.hide()
  window = new BrowserWindow({ width: 568, height: 1000, frame: false, show: false, backgroundColor: '#17191d',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  window.webContents.on('render-process-gone', (_event, details) => actual.errors.push(details))
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) actual.errors.push({ message }) })
  await window.loadURL(url)
  window.showInactive()
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor('Boolean(window.spaceContextFixture && document.querySelector(".workspace-topic-entry"))', 'Actual Category Dock ready')
  const identities = await evaluate('window.spaceContextFixture.identities')
  actual.initial = await facts()
  await click('.workspace-topic-entry[data-topic-id=' + JSON.stringify(identities.first.id) + ']')
  await chosen(identities.first.id)
  await toggleFiles(true)
  await fileRoot(identities.first.directoryPath)
  await click('[aria-label="Show Knowledge"]')
  await label('100 items shown')
  for (const [width, theme] of (mode === 'details-only' ? [[300, 'dark']] : [[300, 'dark'], [236, 'dark'], [300, 'light'], [236, 'light']])) {
    await size(width, theme); await frame('knowledge-' + width + '-' + theme)
  }
  if (mode !== 'details-only') {
  await size(236, 'dark')
  await click('[aria-label="Refresh knowledge"]')
  for (let attempt = 0; attempt < 15 && !await evaluate('document.activeElement?.matches(' + JSON.stringify(discovery + ' > summary') + ')'); attempt++) await key('Tab')
  assert.equal(await evaluate('document.activeElement?.matches(' + JSON.stringify(discovery + ' > summary') + ')'), true)
  await key('Enter')
  assert.equal(await evaluate(first(discovery) + '.open'), true)
  const raw = await evaluate(first(discovery) + '.textContent')
  for (const field of ['code', 'message', 'source', 'recovery']) assert.ok(raw.includes(identities.partial[field]), 'Original issue field: ' + field)
  await frame('discovery-details-keyboard')
  await click(discovery + ' > summary')
  }
  await evaluate('window.__spaceContextOriginalRow = ' + first('.topic-knowledge-row') + '; true')
  await click('.topic-knowledge-row')
  await waitFor(nodes('.topic-knowledge-entry') + '.length === 1')
  await checkDetail('normal-detail-open')
  await frame('original-knowledge-detail')
  await closeOriginalDetail('normal-detail-close')
  await refresh('mixed', '100 items shown')
  assert.equal(await evaluate(nodes(unavailable) + '.length'), 1)
  if (mode !== 'details-only') await frame('partial-and-error')
  await toggleFiles(false)
  await size(236, 'dark', 420)
  const currentHeight = await evaluate(first(knowledge) + '.getBoundingClientRect().height')
  if (currentHeight < 240 || currentHeight > 300) await size(236, 'dark', Math.round(420 + 270 - currentHeight))
  const shortHeight = await evaluate(first(knowledge) + '.getBoundingClientRect().height')
  assert.ok(shortHeight >= 240 && shortHeight <= 300, 'Short actual Knowledge surface must be 240–300px')
  await click(discovery + ' > summary'); await click(unavailable + ' > summary')
  assert.equal(await evaluate(first(discovery) + '.open && ' + first(unavailable) + '.open'), true)
  const target = await point('.topic-knowledge-status')
  await mouse('mouseMoved', target)
  assert.equal(await evaluate(first('.topic-knowledge-status') + '.scrollHeight > ' + first('.topic-knowledge-status') + '.clientHeight'), true)
  const scrollBefore = await evaluate(first('.topic-knowledge-status') + '.scrollTop')
  await mouse('mouseWheel', target, { deltaX: 0, deltaY: 300 })
  await settle()
  actual.operations.push({ kind: 'native-wheel', selector: '.topic-knowledge-status', deltaY: 300,
    before: scrollBefore, after: await evaluate(first('.topic-knowledge-status') + '.scrollTop'), target })
  await waitFor(first('.topic-knowledge-status') + '.scrollTop > ' + scrollBefore, 'Real status-group scroll')
  if (mode === 'details-only') {
    await query('alpha')
    await label('100 results shown')
  }
  await evaluate('window.__spaceContextOriginalRow = ' + first('.topic-knowledge-row') + '; true')
  await click('.topic-knowledge-row', false)
  await waitFor(nodes('.topic-knowledge-entry') + '.length === 1')
  if (mode === 'details-only') {
    const originalBody = await evaluate(first('.topic-knowledge-entry') + '.innerText')
    await evaluate('window.spaceContextFixture.observation("failed")')
    await query('beta')
    await waitFor(first('.topic-knowledge-results__label') + '?.textContent.startsWith("Last confirmed:")')
    const confirmedLabel = await evaluate(first('.topic-knowledge-results__label') + '.textContent')
    assert.ok(confirmedLabel.includes('alpha') && confirmedLabel.includes(identities.first.title) && !confirmedLabel.includes('beta'))
    assert.equal(await evaluate(first('.topic-knowledge-entry') + '.innerText'), originalBody)
  }
  assert.equal(await evaluate(first(discovery) + '.open && ' + first(unavailable) + '.open'), true)
  const detail = await checkDetail('short-detail-open')
  await frame('short-mixed-details')
  if (detail.readers.length) {
    const reader = detail.readers[0], target = detail.body
    await mouse('mouseMoved', target)
    await mouse('mouseWheel', target, { deltaX: 0, deltaY: 80 })
    await settle()
    await waitFor(first(reader.selector) + '.scrollTop > ' + reader.scrollTop, 'Original detail scrolls through its own real reader')
    actual.detailChecks.push({ name: 'short-detail-body-read', reader: reader.selector,
      before: reader.scrollTop, after: await evaluate(first(reader.selector) + '.scrollTop'), geometry: await detailGeometry() })
    const readerTarget = await point(reader.selector, false)
    await mouse('mouseMoved', readerTarget)
    await mouse('mouseWheel', readerTarget, { deltaX: 0, deltaY: -10000 })
    await settle()
    await waitFor(first(reader.selector) + '.scrollTop === 0', 'Native reader scroll returns to original close control')
  }
  await checkDetail('short-detail-return-to-close')
  await closeOriginalDetail('short-detail-close', true)
  if (mode === 'details-only') await frame('short-mixed-closed')
  if (mode !== 'details-only') {
  await size(300, 'light')
  await refresh('empty', 'Search incomplete')
  const emptyText = await evaluate(first(knowledge) + '.innerText')
  assert.ok(emptyText.includes('Some sources could not be searched')); assert.ok(!emptyText.includes('No matches'))
  await frame('empty-partial')
  await refresh('complete', '3 items')
  assert.equal(await evaluate(nodes('.topic-knowledge-notice') + '.length'), 0)
  await frame('complete-results')
  await query('alpha')
  await label('3 results')
  await click('.topic-knowledge-row')
  const originalDetail = await evaluate(first('.topic-knowledge-entry') + '.innerText')
  await evaluate('window.spaceContextFixture.observation("failed")')
  await query('beta')
  await waitFor(first('.topic-knowledge-results__label') + '?.textContent.startsWith("Last confirmed:")')
  const lastConfirmed = await evaluate(first('.topic-knowledge-results__label') + '.textContent')
  assert.ok(lastConfirmed.includes('alpha')); assert.ok(lastConfirmed.includes(identities.first.title)); assert.ok(!lastConfirmed.includes('beta'))
  assert.equal(await evaluate(first('.topic-knowledge-entry') + '.innerText'), originalDetail)
  await frame('last-confirmed-query')
  await click('[aria-label="Close knowledge detail"]')
  await evaluate('window.spaceContextFixture.observation("history")')
  await query('alpha')
  await label('3 results')
  await click(history + ' > summary')
  const historyText = await evaluate(first(history) + '.textContent')
  for (const field of ['code', 'message', 'source', 'recovery']) assert.ok(historyText.includes(identities.historyIssue[field]), 'History issue field: ' + field)
  assert.equal(await evaluate(nodes('.topic-knowledge-row') + '.length'), 3)
  await frame('history-unavailable')
  if (mode !== 'knowledge-only') {
  await click('[data-space-nav=' + JSON.stringify('topic-category:' + identities.category.categoryId) + ']')
  assert.equal((await facts()).selection.spaceId, identities.category.spaceId)
  await click('[aria-label="Show Topics"]')
  await frame('category-original-directory')
  await click('.workspace-topic-entry[data-topic-id=' + JSON.stringify(identities.second.id) + ']')
  await chosen(identities.second.id)
  await toggleFiles(true)
  await fileRoot(identities.second.directoryPath)
  assert.equal((await facts()).object.physicalPath, identities.second.physicalDirectoryPath)
  await frame('selected-topic-directory')
  await click('[data-space-nav=' + JSON.stringify('topic:' + identities.mote.id) + ']')
  await chosen(identities.mote.id)
  await toggleFiles(true)
  await fileRoot(identities.mote.directoryPath)
  assert.equal(await evaluate(first('[data-space-tool="files-branches"]') + '.getAttribute("aria-label")'), 'Files + Mote')
  const fixtureHome = await evaluate('window.spaceContextFixture.fixtureHome')
  assert.ok(identities.mote.physicalDirectoryPath === fixtureHome || identities.mote.physicalDirectoryPath.startsWith(fixtureHome + '/'), 'Original fixture physical path lies within its frozen fixture home')
  const physicalTooltip = '~' + identities.mote.physicalDirectoryPath.slice(fixtureHome.length)
  const titleSelector = '.workspace-tool-context [title=' + JSON.stringify(physicalTooltip) + ']'
  const hover = await point(titleSelector)
  await mouse('mouseMoved', hover)
  await delay(800)
  actual.operations.push({ kind: 'native-hover', selector: titleSelector, originalPhysicalPath: identities.mote.physicalDirectoryPath, target: hover })
  await frame('mote-files-scope')
  await evaluate('window.spaceContextFixture.moteUnavailable(true)')
  await click('[data-space-nav=' + JSON.stringify('topic:' + identities.mote.id) + ']')
  await waitFor(nodes('[aria-label="Mote directory observation"]') + '.length === 1')
  assert.equal((await facts()).object.physicalPath, identities.mote.physicalDirectoryPath)
  assert.equal(await evaluate(nodes('[data-mote-details]') + '.length'), 1)
  await point('[aria-label="Retry Mote directory discovery"]')
  await frame('mote-unavailable-directory-kept')
  await evaluate('window.spaceContextFixture.moteUnavailable(false)')
  await click('[aria-label="Retry Mote directory discovery"]')
  await waitFor(nodes('[aria-label="Mote directory observation"]') + '.length === 0')
  await click('[data-space-nav=' + JSON.stringify(identities.folderProject) + ']')
  await waitFor('window.spaceContextFixture.facts().activeWorkspaceId === ' + JSON.stringify(identities.folder.id))
  assert.equal(await evaluate(first('[data-space-tool="files-branches"]') + '.getAttribute("aria-label")'), 'Files + Zones')
  await waitFor(nodes('[data-zone-id]') + '.length > 0')
  await frame('folder-zones')
  await click('[aria-label="Manage worktrees"]')
  await waitFor('window.spaceContextFixture.facts().tool === "git" && window.spaceContextFixture.facts().view === "branches"')
  await waitFor(nodes('.branch-row__open') + '.length === 1')
  await frame('folder-git')
  }
  }
  actual.final = await facts()
  actual.transport = await evaluate('window.spaceContextFixture.transport()')
  assert.equal(actual.transport.some(value => value.method === 'forbidden-write'), false)
  for (const field of ['tabs', 'drafts', 'sessions']) assert.deepEqual(actual.final[field], actual.initial[field], 'Original ' + field + ' kept')
  assert.deepEqual(actual.errors, [], 'Renderer errors invalidate capture')
  actual.passed = true
}).catch(async error => {
  actual.failure = { name: error.name, message: error.message, stack: error.stack }
  if (window && !window.isDestroyed()) {
    try { actual.failureFacts = await facts(); await frame('failure') } catch (captureError) { actual.failureCaptureError = captureError.message }
  }
}).finally(async () => {
  if (window && !window.isDestroyed()) {
    try {
      actual.loaded = await evaluate('performance.getEntriesByType("resource").map(entry => entry.name)')
      actual.transport = await evaluate('window.spaceContextFixture.transport()')
    } catch {}
  }
  await writeFile(join(evidence, 'actual.json'), JSON.stringify(actual, null, 2) + '\n')
  window?.destroy()
  app.exit(actual.passed ? 0 : 1)
})
