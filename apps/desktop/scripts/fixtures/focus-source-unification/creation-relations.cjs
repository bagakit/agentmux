const assert = require('node:assert/strict')
const { focus, taskLayoutControls } = require('./task-layout-controls.cjs')

module.exports = async function exerciseCreationRelations({ win, read, until, settle, click, capture, result, restoreOnly }) {
  const layout = () => read('document.querySelector(' + JSON.stringify(focus) + ')?.dataset.taskLayout')
  const controls = taskLayoutControls({ read, until, click })
  const button = id => focus + ' button.focus-context[data-session-id="' + id + '"]'
  const slot = id => focus + ' [data-focus-card-key][data-focus-presentation-session="' + id + '"]'
  const tree = [['coverage', 1], ['audit', 2], ['reviews', 1]]
  const view = '.focus-project-lanes__rows'
  const scrollTop = () => read(`document.querySelector(${JSON.stringify(view)}).scrollTop = 0`)
  const descendants = () => read(`[...document.querySelectorAll(${JSON.stringify(focus + ' [data-focus-creation-depth]')})].map(node => [node.dataset.focusPresentationSession, Number(node.dataset.focusCreationDepth)])`)
  const lines = () => read(`[...document.querySelectorAll('.focus-creation-line')].map(line => ({from: JSON.parse(line.dataset.focusCreationFrom)[1], to: JSON.parse(line.dataset.focusCreationTo)[1], start: Boolean(line.getAttribute('marker-start')), end: Boolean(line.getAttribute('marker-end')), dash: getComputedStyle(line).strokeDasharray}))`)
  const hasLine = (from, to) => lines().then(edges => edges.some(edge => edge.from === from && edge.to === to))
  const routeCollisions = () => read(`(() => {
      const board = document.querySelector(${JSON.stringify(view)})
      const boxes = [...board.querySelectorAll('[data-focus-card-key], .focus-context-group__bucket, .focus-topic-section')].map(element => ({
        bounds: element.getBoundingClientRect(), label: element.dataset.focusPresentationSession ?? element.textContent.trim(),
      }))
      return [...document.querySelectorAll('.focus-creation-line')].flatMap(line => {
        const origin = line.ownerSVGElement.getBoundingClientRect()
        const length = line.getTotalLength()
        for (let offset = 0; offset < length; offset += 0.5) {
          const point = line.getPointAtLength(offset), x = point.x + origin.left, y = point.y + origin.top
          const hit = boxes.find(({bounds}) => x > bounds.left + 0.25 && x < bounds.right - 0.25 && y > bounds.top + 0.25 && y < bounds.bottom - 0.25)
          if (hit) return [{from: line.dataset.focusCreationFrom, to: line.dataset.focusCreationTo, card: hit.label,
            path: line.getAttribute('d'), point: [x, y], bounds: hit.bounds.toJSON()}]
        }
        return []
      })
    })()`)
  const expectClearRoutes = async () => {
    await settle()
    assert.deepEqual(await routeCollisions(), [], 'Selected creation links stay outside cards and headings')
  }
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
    assert.deepEqual(await descendants(), tree)
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
  await until('selected card draws both column relationships', async () => await hasLine('working', 'coverage') && await hasLine('working', 'reviews'))
  assert.ok((await lines()).every(line => line.from === 'working' && line.start && line.end && line.dash === 'none'))
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
  assert.equal(await read(`(() => {
    const line = [...document.querySelectorAll('.focus-creation-line')].find(line => JSON.parse(line.dataset.focusCreationTo)[1] === 'permission')
    const board = document.querySelector(${JSON.stringify(view)}), origin = line.ownerSVGElement.getBoundingClientRect()
    const length = line.getTotalLength(), tip = line.getPointAtLength(length), before = line.getPointAtLength(length - 0.1)
    const dx = tip.x - before.x, dy = tip.y - before.y, delta = Math.hypot(dx, dy)
    const x = tip.x + origin.left - board.getBoundingClientRect().left, y = tip.y + origin.top - board.getBoundingClientRect().top
    const tailX = x - 3.75 * dx / delta, tailY = y - 3.75 * dy / delta
    const wingX = 1.875 * Math.abs(dy / delta), wingY = 1.875 * Math.abs(dx / delta)
    return tailX - wingX >= 0 && tailX + wingX <= board.clientWidth && tailY - wingY >= 0 && tailY + wingY <= board.clientHeight
  })()`), true, 'The entire arrowhead fits inside the scrollport')
  await expectClearRoutes()
  assert.equal(await read(`getComputedStyle(document.querySelector('.focus-creation-connections')).pointerEvents`), 'none')
  result.cardOutgoing = await lines()
  await capture('cards-creation-outgoing.png', 'Selected creator links to visible Agents, with a start dot and arrowheads')

  await click(button('coverage'))
  await until('the selected child shows the incoming and staggered outgoing relations', async () => await hasLine('working', 'coverage') && await hasLine('coverage', 'audit'))
  await settle()
  assert.equal(await read(`(() => {
    const source = document.querySelector(${JSON.stringify(slot('coverage'))}).getBoundingClientRect()
    const target = document.querySelector(${JSON.stringify(slot('audit'))}).getBoundingClientRect()
    return Math.abs(target.x - source.x) >= 20 && target.top >= source.bottom - 4
  })()`), true, 'The Results target is staggered across a column and row')
  assert.ok(!(await lines()).some(line => line.from === 'coverage' && line.to === 'working'))
  await expectClearRoutes()
  await capture('cards-creation-incoming.png', 'The staggered Results link follows the available gutter')
  result.cardIncoming = await lines()

  const edge = `[...document.querySelectorAll('.focus-creation-line')].find(line => JSON.parse(line.dataset.focusCreationFrom)[1] === 'coverage' && JSON.parse(line.dataset.focusCreationTo)[1] === 'audit')`
  const normalMotion = value => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{name:'prefers-reduced-motion',value}],
  })
  const pointer = async point => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',...point})
  const preview = () => read(`[...document.querySelectorAll('[role=tooltip]')].find(node => /Created /.test(node.textContent))?.textContent ?? null`)
  const names = await read(`[${JSON.stringify(button('coverage'))}, ${JSON.stringify(button('audit'))}].map(selector => document.querySelector(selector).querySelector('strong').textContent)`)
  const hintText = names[0] + 'Created ' + names[1]
  const topology = await read('window.taskLayoutProof.topology()')
  const selection = await read('window.taskLayoutProof.selection()')
  const hoverPoint = await read(`(() => {
    const line = ${edge}, rect = line.ownerSVGElement.getBoundingClientRect(), length = line.getTotalLength()
    for (const fraction of [.48, .32, .62, .24, .76]) {
      const p = line.getPointAtLength(length * fraction), x = p.x + rect.left, y = p.y + rect.top
      const target = document.elementFromPoint(x, y)
      if (target?.closest('.focus-project-lanes__rows') && !target.closest('[data-focus-card-key], button, a, .focus-context-group__bucket, .focus-project-lanes__axis')) return {x,y}
    }
    return null
  })()`)
  assert.ok(hoverPoint, 'The displayed route exposes a real gutter point to the pointer')
  await normalMotion('no-preference')
  await pointer(hoverPoint)
  await until('Creation link hover shows both original names and direction', async () => await preview() === hintText)
  const animation = await read(`(() => {
    const pulse = (${edge}).parentElement.querySelector('.focus-creation-pulse')
    const animation = pulse?.getAnimations().find(item => item.animationName === 'focus-creation-direction')
    if (!animation) return null
    animation.pause()
    const timing = animation.effect.getTiming()
    animation.currentTime = timing.duration * .2
    const start = parseFloat(getComputedStyle(pulse).strokeDashoffset)
    animation.currentTime = timing.duration * .44
    const later = parseFloat(getComputedStyle(pulse).strokeDashoffset)
    return { iterations: timing.iterations, start, later }
  })()`)
  assert.equal(animation?.iterations, 1)
  assert.ok(animation.later < animation.start, 'The rendered pulse moves from creator toward target')
  await capture('cards-creation-hover.png', 'Pointer preview names the exact relationship and a paused pulse shows its direction')
  await pointer({x:7,y:7})
  await until('leaving the board dismisses the relation preview', async () => await preview() === null)

  win.setContentSize(1200, 1000)
  await settle()
  await until('resizing keeps the selected relation visible', () => hasLine('coverage', 'audit'))
  await expectClearRoutes()
  await capture('cards-creation-reflow.png', 'Cards keep the same directed relationship after the pane narrows')
  await normalMotion('reduce')
  await read('window.unifiedFocusProof.theme("light")')
  await read(`(${edge}).parentElement.focus()`)
  await until('keyboard focus reads the same relation', async () => await preview() === hintText)
  assert.equal(await read(`(${edge}).parentElement.querySelector('.focus-creation-pulse').getAnimations().length`), 0)
  await capture('cards-creation-keyboard-reduced.png', 'Keyboard focus reads the same relation in a narrower light pane with reduced motion')
  await key('Escape', 27)
  await until('Escape dismisses the relation preview', async () => await preview() === null)
  assert.deepEqual(await read('window.taskLayoutProof.topology()'), topology)
  assert.deepEqual(await read('window.taskLayoutProof.selection()'), selection)
  result.linkReading = { hover: true, keyboard: true, motion: animation, reducedMotion: true, exactNames: names }
  result.routing = { staggered: true, clearedCardsAndHeadings: true, reflow: true }
  win.setContentSize(1440, 900)
  await settle()

  await controls.choose('list')
  await until('mounted compact List creation subtree', async () => await layout() === 'list' && (await descendants()).length === tree.length)
  assert.deepEqual(await descendants(), tree)
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
  await until('keyboard expands the same subtree', async () => (await descendants()).length === tree.length)
  assert.deepEqual(await descendants(), tree)
  assert.deepEqual(await read('window.taskLayoutProof.topology()'), before)

  const search = focus + ' [aria-label="Search contexts"]'
  await click(search)
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '整理退款原因' })
  await until('filtered child remains an original task', () => read(`Boolean(document.querySelector(${JSON.stringify(button('audit'))})) && !document.querySelector(${JSON.stringify(button('working'))})`))
  assert.deepEqual(await descendants(), [])
  assert.match(await read(`document.querySelector(${JSON.stringify(button('audit'))}).getAttribute('aria-description')`), /Created by/)
  await read(`document.querySelector(${JSON.stringify(search)}).select()`)
  await key('Backspace', 8)
  await until('clearing the filter restores the same tree', async () => (await descendants()).length === tree.length)

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
