const assert = require('node:assert/strict')
const { readGoalEdgeGeometry, assertGoalEdgeGeometry } = require('./edge-geometry.cjs')

/** Inspect and return through the same task card in the normal App at actual container widths. */
module.exports = async ({ evaluate, size, click, pointer, capture, waitFor, paint, result, debuggerSession }) => {
  const query = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
  const canvas = '.goal-plan__canvas', reader = '.goal-plan__reading'
  const guide = '[data-goal-plan-node="guide"]', button = guide + ' .goal-plan-node__head'
  const panel = '[data-goal-plan-detail="guide"]'
  const media = value => debuggerSession.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] })

  for (const [width, theme] of [[1600, 'dark'], [620, 'light'], [390, 'dark']]) {
    await size(width)
    await media(width === 620 ? 'reduce' : 'no-preference')
    await evaluate("goalsPlan.seed(false, true); goalsVisual.appearance(" + JSON.stringify(theme) + ")")
    await waitFor("document.querySelectorAll('[data-goal-plan-node]').length === 7")
    await evaluate("document.querySelector('.goals-detail').scrollTop = 0")
    await pointer(query('.goals-detail__toolbar'))
    await paint()
    const before = await evaluate('goalsSpace.facts()')
    const groups = await evaluate(`[...document.querySelectorAll('[data-goal-plan-column]')].map(column => ({
      members: [...column.querySelectorAll('[data-goal-plan-node]')].map(node => node.dataset.goalPlanNode),
      visibleHeading: !!column.querySelector('.goal-plan__depth')?.getClientRects().length
    }))`)
    assert.deepEqual(groups.map(group => group.members), [['outline', 'guide'], ['workspace', 'drafts', 'history', 'reconnect'], ['verify']])
    assert.ok(groups.every(group => group.visibleHeading === (width <= 640)), 'Narrow workfaces identify the actual parallel groups')
    const overflow = await evaluate("document.querySelector('.goals-detail').scrollWidth - document.querySelector('.goals-detail').clientWidth")
    if (overflow > 1) {
      const offenders = await evaluate(`(() => {
        const page = document.querySelector('.goals-detail'), right = page.getBoundingClientRect().right
        return [...page.querySelectorAll('*')].filter(item => item.getBoundingClientRect().right > right + 1)
          .slice(0, 24).map(item => ({ tag: item.tagName, cls: item.getAttribute('class'), right: item.getBoundingClientRect().right }))
      })()`)
      await capture(width + '-' + theme + '-overflow', width)
      assert.fail('The workface exceeds its container by ' + overflow + 'px: ' + JSON.stringify(offenders))
    }
    await capture(width + '-' + theme + '-plan', width)
    if (width === 1600) {
      const geometry = await readGoalEdgeGeometry(evaluate)
      assertGoalEdgeGeometry(geometry)
      result.observations.push({ width, theme, geometry })
      await pointer(query('[data-goal-plan-node="workspace"] .goal-plan-node__head'))
      await waitFor(query(canvas) + ".dataset.goalTrace === 'workspace'")
      await capture('1600-dark-trace', width)
    }

    // Click the quiet far edge of the card, well outside the title and the agent name.
    await evaluate(query(button) + ".scrollIntoView({block:'center'})")
    await paint()
    const hit = await evaluate(`(() => {
      const card = ${query(guide)}, box = card.getBoundingClientRect()
      const x = box.right - 8, y = box.bottom - 9
      return { x, y, interactive: ${query(button)}.contains(document.elementFromPoint(x, y)) }
    })()`)
    assert.equal(hit.interactive, true, 'The task surface itself opens its original task')
    for (const type of ['mousePressed', 'mouseReleased']) {
      await debuggerSession.sendCommand('Input.dispatchMouseEvent', { type, x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
    }
    await waitFor('Boolean(' + query(panel) + ') && document.activeElement === ' + query(reader + ' h3'))
    const location = await evaluate(`(() => {
      const card = ${query(guide)}, reading = ${query(reader)}, timeline = ${query('[data-goal-execution-time]')}
      const box = reading.getBoundingClientRect()
      const other = [...document.querySelectorAll('[data-goal-plan-node]')].some(node => {
        if (node === card) return false
        return !!(card.compareDocumentPosition(node) & 4) && !!(node.compareDocumentPosition(reading) & 4)
      })
      return { beforeTimeline: !!(reading.compareDocumentPosition(timeline) & 4), interveningCard: other,
        gap: box.top - card.getBoundingClientRect().bottom, headingHeight: reading.querySelector('h3').getBoundingClientRect().height, sections: document.querySelectorAll('.goal-plan__reading').length,
        assignmentVisible: !!reading.querySelector('[aria-label="Node assignment"]'), heading: reading.querySelector('h3').textContent }
    })()`)
    assert.equal(location.sections, 1)
    assert.equal(location.heading, 'Write the recovery guide')
    assert.equal(location.beforeTimeline, true, 'The selected task can be read before the timeline')
    assert.equal(location.assignmentVisible, true)
    if (width <= 640) {
      assert.equal(location.interveningCard, false, 'Narrow detail follows exactly the chosen card')
      assert.ok(Math.abs(location.gap) <= 2 && location.headingHeight <= 2,
        'The narrow task shares a boundary and a single visible title with its reader: ' + JSON.stringify(location))
    }
    await capture(width + '-' + theme + '-task', width)
    if (width === 620) {
      await evaluate(`(() => {
        window.originalGoalTaskReader = ${query(panel)}
        const control = ${query(reader + ' .goal-plan__reading-header button')}
        control.focus({ preventScroll: true })
        window.originalGoalTaskFocus = control
      })()`)
      for (const resized of [1600, 620]) {
        await size(resized)
        await waitFor(`document.querySelector('.goal-plan__canvas').contains(${query(panel)}) === ${resized === 620}`)
        assert.ok(await evaluate('document.activeElement === window.originalGoalTaskFocus && ' + query(panel) + ' === window.originalGoalTaskReader'), 'Resizing moves the same mounted reader and keeps its focus')
      }
    }
    await click(query(reader + ' .goal-plan__reading-header button'))
    await waitFor('document.activeElement === ' + query(button) + ' && !' + query(panel))
    for (const type of ['rawKeyDown', 'char', 'keyUp']) {
      await debuggerSession.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        ...(type === 'char' ? { text: String.fromCharCode(13), unmodifiedText: String.fromCharCode(13) } : {}) })
    }
    await waitFor('Boolean(' + query(panel) + ')')
    await click(query(reader + ' .goal-plan__reading-header button'))
    await waitFor('document.activeElement === ' + query(button))
    assert.deepEqual(await evaluate('goalsSpace.facts()'), before, 'Inspecting a node keeps all original Goal facts')
    result.observations.push({ width, theme, groups, location, keyboardReturnedTo: 'guide' })
  }
  await size(1600)
  await evaluate("goalsPlan.inspection(); goalsVisual.appearance('light')")
  await waitFor("document.querySelectorAll('[data-goal-plan-node]').length === 1")
  await evaluate("document.querySelector('.goals-detail').scrollTop = 0")
  assert.equal(await evaluate("document.querySelectorAll('.goal-plan__depth').length"), 0, 'One original Goal has no fabricated dependency tiers')
  await capture('1600-light-single', 1600)
  await size(620)
  await evaluate("goalsPlan.seed(true, true); goalsVisual.appearance('light')")
  await waitFor("Boolean(document.querySelector('[data-goal-plan-states-unavailable]'))")
  await evaluate("document.querySelector('.goals-detail').scrollTop = 0")
  assert.equal(await evaluate("document.querySelectorAll('[data-goal-plan-node]').length"), 7)
  assert.equal(await evaluate("document.querySelectorAll('.goal-plan__depth, [data-claim-open]').length"), 0,
    'Missing owner states keep saved tasks without presenting readiness or invented dependency groups')
  await capture('620-light-unavailable', 620)

  for (const [width, theme] of [[1600, 'dark'], [390, 'light']]) {
    await size(width)
    for (const [outcome, finish, conclusion] of [
      ['unchecked', 'Evidence needed', 'Results need checking'], ['accepted', 'Succeeded', 'Accepted · Finished'], ['cancelled', 'Cancelled', 'Cancelled']
    ]) {
      await evaluate(`goalsPlan.ticketOutcome(${JSON.stringify(outcome)}); goalsVisual.appearance(${JSON.stringify(theme)})`)
      await waitFor(`Boolean(${query('[data-goal-finish-state="' + finish + '"]')})`)
      await evaluate("document.querySelector('.goals-detail').scrollTop = 0")
      const header = await evaluate(`[...document.querySelectorAll('[data-goal-detail-stage], [data-goal-meta-plan]')].map(node => [node.textContent, node.getBoundingClientRect().bottom])`)
      assert.deepEqual(header.map(([text]) => text), [conclusion, '1 of 1 Tickets passed'])
      assert.ok(header.every(([, bottom]) => bottom < 500), 'Both facts are visible near the top in wide and narrow views')
      await capture(`${width}-${theme}-tickets-passed-${outcome}`, width)
    }
    await evaluate(`goalsPlan.seed(false, true, false, 'confirmed'); goalsVisual.appearance(${JSON.stringify(theme)})`)
    const deliveryButton = "[...document.querySelectorAll('.goals-detail__actions button')].find(node => node.textContent === 'View delivery')"
    await waitFor(`Boolean(${deliveryButton})`)
    await click(deliveryButton)
    const report = query('[data-goal-delivery="attempt:outline"] [data-goal-delivery-report]')
    await waitFor(`Boolean(${report})`)
    await evaluate(`${report}.scrollIntoView({block:'center'})`)
    await capture(`${width}-${theme}-original-delivery-evidence`, width)
  }
}
