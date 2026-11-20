const assert = require('node:assert/strict')
const { focus, taskLayoutControls } = require('./task-layout-controls.cjs')

module.exports = async function exerciseCreationRelations({ win, read, until, settle, click, capture, result, restoreOnly }) {
  const layout = () => read('document.querySelector(' + JSON.stringify(focus) + ')?.dataset.taskLayout')
  const controls = taskLayoutControls({ read, until, click })
  const button = id => focus + ' button.focus-context[data-session-id="' + id + '"]'
  const slot = id => focus + ' [data-focus-card-key][data-focus-presentation-session="' + id + '"]'
  const view = '.focus-project-lanes__rows'
  const scrollTop = () => read(`document.querySelector(${JSON.stringify(view)}).scrollTop = 0`)
  const descendants = () => read(`[...document.querySelectorAll(${JSON.stringify(focus + ' [data-focus-creation-depth]')})].map(node => [node.dataset.focusPresentationSession, Number(node.dataset.focusCreationDepth)])`)
  const lines = () => read(`[...document.querySelectorAll('.focus-creation-line')].map(line => ({from: JSON.parse(line.dataset.focusCreationFrom)[1], to: JSON.parse(line.dataset.focusCreationTo)[1], marker: Boolean(line.getAttribute('marker-end')), dash: getComputedStyle(line).strokeDasharray}))`)
  const key = async (value, code) => {
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key: value, code: value, ...(type === 'keyDown' && value === 'Enter' ? {text:'\r'} : {}), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    })
    await settle()
  }
  await until('original Focus and real cards', () => read(`Boolean(window.taskLayoutProof && document.querySelector(${JSON.stringify(button('working'))}))`))
  await until('Core creation marker reaches the actual Focus cards', () =>
    read(`Boolean(document.querySelector(${JSON.stringify(slot('working') + ' .focus-creation-mark')})) || (document.querySelector(${JSON.stringify(focus)}).dataset.taskLayout === 'list' && Boolean(document.querySelector('.focus-creation-disclosure')))`))
  if (restoreOnly) {
    assert.equal(await layout(), 'list')
    assert.deepEqual(await descendants(), [['coverage', 1], ['audit', 2]])
    assert.equal(await read('window.taskLayoutProof.restored'), true)
    result.topology = await read('window.taskLayoutProof.topology()')
    result.layout = 'list'
    await capture('restored-creation-list.png', 'A new Electron process restores the original workface and reads the same creation subtree')
    result.passed = true
    return
  }
  assert.equal(await layout(), 'cards')
  assert.deepEqual(await lines(), [])
  await read('window.unifiedFocusProof.theme("dark")')
  await click(button('working'))
  await until('selected card draws creator to child', async () => (await lines()).some(line => line.from === 'working' && line.to === 'coverage'))
  assert.ok((await lines()).every(line => line.from === 'working' && line.marker && line.dash !== 'none'))
  const attentionEndpointGap = () => read(`(() => {
    const line = [...document.querySelectorAll('.focus-creation-line')].find(line => JSON.parse(line.dataset.focusCreationTo)[1] === 'permission')
    if (!line) return Infinity
    const end = line.getPointAtLength(line.getTotalLength()), origin = line.ownerSVGElement.getBoundingClientRect()
    const target = document.querySelector(${JSON.stringify(slot('permission'))}).getBoundingClientRect()
    const x = end.x + origin.left, y = end.y + origin.top
    const dx = Math.max(target.left - x, x - target.right), dy = Math.max(target.top - y, y - target.bottom)
    return dx <= 0 && dy <= 0 ? -Math.max(dx, dy) : Math.hypot(Math.max(0, dx), Math.max(0, dy))
  })()`)
  await until('the arrow ends at the visible Attention card outline', async () => (await attentionEndpointGap()) <= 4)
  assert.equal(await read(`getComputedStyle(document.querySelector('.focus-creation-connections')).pointerEvents`), 'none')
  result.cardOutgoing = await lines()
  await capture('cards-creation-outgoing.png', 'Selected creator links to the visible Agent it created using a dashed arrow')

  await click(button('coverage'))
  await until('selected child keeps incoming creation direction', async () => (await lines()).some(line => line.from === 'working' && line.to === 'coverage'))
  assert.ok(!(await lines()).some(line => line.from === 'coverage' && line.to === 'working'))
  await capture('cards-creation-incoming.png', 'Selecting the child preserves the creator-to-child arrow direction')
  result.cardIncoming = await lines()

  await controls.choose('list')
  await until('mounted compact List creation subtree', async () => await layout() === 'list' && (await descendants()).length === 2)
  assert.deepEqual(await descendants(), [['coverage', 1], ['audit', 2]])
  assert.equal(await read(`document.querySelector(${JSON.stringify(button('audit'))}).dataset.bucket`), 'results', 'The child retains its own status inside the subtree')
  assert.equal(await read(`document.querySelectorAll(${JSON.stringify(button('mobile'))}).length`), 1, 'The other project keeps one original task row')
  const reference = slot('working') + ' .focus-creation-references button'
  const labels = await read(`[...document.querySelectorAll(${JSON.stringify(reference)})].map(node => node.querySelector('small').textContent)`)
  assert.deepEqual(labels.sort(), ['Archive', 'Attention'])
  const attention = () => read(`document.querySelector(${JSON.stringify(button('permission'))})?.closest('.focus-context-group')?.dataset.bucket`)
  assert.equal(await attention(), 'attention')
  assert.equal(await read(`document.querySelector(${JSON.stringify(button('summary'))}).closest('[data-focus-card-key]').dataset.focusCreationDepth ?? null`), null)
  await scrollTop()
  await capture('list-creation-expanded.png', 'Original working and result rows form a compact subtree with a named cross-project reference')

  const toggle = slot('working') + ' .focus-creation-disclosure'
  const before = await read('window.taskLayoutProof.topology()')
  await read(`document.querySelector(${JSON.stringify(toggle)}).focus()`)
  await key('Enter', 13)
  await until('keyboard folds the original subtree', async () => (await descendants()).length === 0)
  assert.deepEqual(await descendants(), [])
  assert.equal(await attention(), 'attention', 'Folding the creator leaves a child waiting for permission in its Attention group')
  assert.equal(await read(`document.activeElement === document.querySelector(${JSON.stringify(toggle)})`), true)
  await capture('list-creation-collapsed.png', 'The keyboard disclosure folds descendants and keeps the original workface')
  await key('Enter', 13)
  await until('keyboard expands the same subtree', async () => (await descendants()).length === 2)
  assert.deepEqual(await descendants(), [['coverage', 1], ['audit', 2]])
  assert.deepEqual(await read('window.taskLayoutProof.topology()'), before)

  const search = focus + ' [aria-label="Search contexts"]'
  await click(search)
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '整理退款原因' })
  await until('filtered child remains an original task', () => read(`Boolean(document.querySelector(${JSON.stringify(button('audit'))})) && !document.querySelector(${JSON.stringify(button('working'))})`))
  assert.deepEqual(await descendants(), [])
  assert.match(await read(`document.querySelector(${JSON.stringify(button('audit'))}).getAttribute('aria-description')`), /Created by/)
  await read(`document.querySelector(${JSON.stringify(search)}).select()`)
  await key('Backspace', 8)
  await until('clearing the filter restores the same tree', async () => (await descendants()).length === 2)

  const sizes = [1200, 1130, 1060, 1000, 935, 870, 820]
  for (const width of sizes) {
    win.setContentSize(width, 850); await settle()
    if (await read('document.querySelector(".global-focus-main").getBoundingClientRect().width') <= 420) break
  }
  await read('window.unifiedFocusProof.theme("light")')
  await scrollTop()
  await capture('list-creation-narrow.png', 'A narrow light split keeps the tree, names, and original workface legible')
  result.list = { folded: true, crossProject: true, keepsAttention: true, exactFilter: true, unchangedTopology: true }
  result.topology = await read('window.taskLayoutProof.topology()')
  result.layout = await read('window.taskLayoutProof.checkpoint()')
  assert.equal(result.layout, 'list')
  result.passed = true
}
