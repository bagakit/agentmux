const assert = require('node:assert/strict')

/** Actual Chromium input and computed animation progress in the private Goal workface. */
module.exports = async ({ evaluate, size, click, pointer, capture, waitFor, paint, result, debuggerSession }) => {
  const query = selector => `document.querySelector(${JSON.stringify(selector)})`
  const outline = '[data-goal-outline-trigger]', menu = '.goal-outline__menu'
  const toggle = '[data-goal-supervisor-toggle]', canvas = '.goal-plan__canvas'
  const article = '.goals-detail', node = id => `[data-goal-plan-node="${id}"]`
  const currentId = () => evaluate('document.querySelector(".goals-detail").dataset.goalDetailId')
  const press = async (key, code) => {
    for (const type of ['keyDown', 'keyUp']) await debuggerSession.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code })
    await paint()
  }
  const readingPosition = () => evaluate(`(() => {
    const page = ${query(article)}, brief = ${query('[data-goal-reading-section="overview"]')}
    return { scrollTop: page.scrollTop, briefTop: brief.getBoundingClientRect().top, hostTop: page.getBoundingClientRect().top,
        scrollHeight: page.scrollHeight, focus: document.activeElement.getAttribute('aria-label') || document.activeElement.dataset.goalReadingSection }
  })()`)
  // The toolbar is sticky. Scrolling its buttons into view would move the document before the user's click.
  const clickVisible = async selector => {
    const point = await evaluate(`(() => {
      const element = ${query(selector)}
      if (!element) throw new Error(${JSON.stringify('Missing target ' + selector)})
      const rect = element.getBoundingClientRect()
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
      if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Occluded toolbar control')
      return { x, y }
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await debuggerSession.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    }
    await paint()
  }
  const media = async value => {
    await debuggerSession.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] })
    assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), value === 'reduce')
  }
  const jump = async section => {
    await clickVisible(outline)
    const option = `[data-goal-destination="${section}"]`
    await waitFor(`Boolean(${query(option)})`)
    await click(query(option))
    await waitFor(`document.activeElement === ${query('[data-goal-reading-section="' + section + '"]')}`)
  }
  // Pause browser-created effects on their real targets once they start. A screenshot taken
  // after seeking the live effect remains reproducible even when capture itself takes longer.
  const holdMidpoint = async (selector, eventName) => {
    await evaluate(`(() => {
      const effects = new Set()
      const capture = event => {
        if (!event.target.closest(${JSON.stringify(selector)})) return
        for (const effect of event.target.getAnimations()) {
          if (effects.has(effect)) continue
          const timing = effect.effect.getTiming()
          if (typeof timing.duration !== 'number' || timing.duration <= 0 || timing.iterations !== 1) continue
          effects.add(effect)
          effect.pause()
          effect.currentTime = timing.delay + timing.duration / 4
        }
      }
      document.addEventListener(${JSON.stringify(eventName)}, capture, true)
      window.goalProbeMotion = { effects, release() {
        document.removeEventListener(${JSON.stringify(eventName)}, capture, true)
        for (const effect of effects) effect.play()
      } }
    })()`)
  }
  const captureMidpoint = async (frame, width) => {
    await waitFor('window.goalProbeMotion.effects.size > 0')
    const sample = await evaluate(`[...window.goalProbeMotion.effects].map(animation => ({
      name: animation.animationName || animation.transitionProperty,
      elapsedMs: animation.currentTime,
      progress: animation.effect.getComputedTiming().progress, duration: animation.effect.getTiming().duration,
      opacity: getComputedStyle(animation.effect.target).opacity, transform: getComputedStyle(animation.effect.target).transform
    }))`)
    assert.ok(sample.every(effect => effect.progress > 0 && effect.progress < 1), JSON.stringify(sample))
    if (frame === '1600-dark-outline-midpoint') {
      assert.equal(await evaluate(`getComputedStyle(${query(menu)}).opacity`), '1', 'The popup obscures document text throughout its entrance')
      assert.ok(sample.some(effect => effect.name === 'goal-outline-enter' && effect.transform !== 'none'))
    }
    await capture(frame, width)
    result.observations.push({ frame, sample })
    await evaluate('window.goalProbeMotion.release()')
    await waitFor("[...window.goalProbeMotion.effects].every(animation => animation.playState === 'finished' || animation.playState === 'idle')")
  }
  const hasSection = section => `${query(outline)}.getAttribute('aria-label').endsWith(${JSON.stringify(section)})`
  const captureAgentSources = async (width, reduced) => {
    const relationships = '.goals-detail__relationships > summary'
    const clickRow = async selector => {
      await evaluate(`${query(selector)}.scrollIntoView({ block: 'center', behavior: 'instant' })`)
      await paint()
      await clickVisible(selector)
    }
    await clickRow(relationships)
    await waitFor(`${query(relationships)}.parentElement.open`)
    if (!await evaluate(`${query('.goal-team__edit')}.open`)) await clickRow('.goal-team__edit > summary')
    await waitFor(`${query('.goal-team__edit')}.open`)
    await clickRow('[aria-label="Choose Goal assignees"]')
    const source = '.goal-agent-picker [aria-label="Agent source"]'
    const existing = source + ' [data-option="existing"]'
    const mote = source + ' [data-option="mote"]'
    const indicator = source + ' .segmented-control__indicator'
    await waitFor(`${query(existing)}?.getAttribute('aria-checked') === 'true'`)
    await capture(width + '-agent-sources', width)
    await evaluate(query(existing) + '.focus()')
    if (!reduced) await holdMidpoint(indicator, 'transitionrun')
    await press('ArrowRight', 39)
    await waitFor(`document.activeElement === ${query(mote)} && ${query(mote)}.getAttribute('aria-checked') === 'true'`)
    await waitFor(`Boolean(${query('[aria-label="Mote for new Session"]')})`)
    if (reduced) assert.equal(await evaluate(`getComputedStyle(${query(indicator)}).transitionDuration`), '0s')
    else await captureMidpoint(width + '-agent-source-midpoint', width)
    await capture(width + '-mote-source', width)
    await press('Escape', 27)
    await waitFor(`!${query('.goal-agent-picker')}`)
    await clickRow(relationships)
  }
  async function readOriginal() {
    const before = await evaluate('goalsSpace.facts()')
    assert.equal(before.id, await currentId())
    assert.equal(before.plan.nodes.length, 7)
    return before
  }

  await size(1600)
  await media('no-preference')
  await evaluate("goalsPlan.seed(false, true); goalsVisual.appearance('dark')")
  await waitFor(`Boolean(${query(outline)}) && document.querySelectorAll('[data-goal-plan-node]').length === 7`)
  const before = await readOriginal()
  await pointer(query('.goals-detail__toolbar'))
  assert.equal(await evaluate(`${query(toggle)}.getClientRects().length`), 0, 'The wide layout already exposes the Supervisor')
  const stations = await evaluate(`['.goals-detail__head', '.goals-detail__main', '.goals-detail__side'].map(selector => {
    const { top, bottom, left, right } = document.querySelector(selector).getBoundingClientRect()
    return { top, bottom, left, right }
  })`)
  const [header, work, supervisor] = stations
  assert.ok(Math.abs(header.left - work.left) <= 2 && Math.abs(header.right - supervisor.right) <= 2, JSON.stringify(stations))
  assert.ok(Math.abs(work.top - supervisor.top) <= 2 && header.bottom <= work.top, JSON.stringify(stations))
  const handoff = selector => query(`[data-goal-handoff="attempt:${selector}"]`)
  const roles = selector => evaluate(`[...${handoff(selector)}.querySelectorAll('small')].map(element => element.textContent)`)
  assert.deepEqual(await roles('drafts'), ['Executor', 'Supervisor'])
  assert.match(await evaluate(`${handoff('drafts')}.textContent`), /Delivery reported/)
  await capture('1600-dark-workspace', 1600)
  await holdMidpoint(menu, 'animationstart')
  await clickVisible(outline)
  await captureMidpoint('1600-dark-outline-midpoint', 1600)
  const destinations = await evaluate("[...document.querySelectorAll('[data-goal-destination]')].map(item => item.dataset.goalDestination)")
  assert.deepEqual(destinations, ['plan', 'overview', 'execution', 'activity'])
  await capture('1600-dark-outline', 1600)
  await press('Escape', 27)
  assert.equal(await evaluate(`document.activeElement === ${query(outline)}`), true)
  await jump('overview')
  assert.equal(await evaluate(hasSection('Goal overview')), true)
  assert.equal(await evaluate(`Boolean(${query('[data-goal-reading-section="overview"] [aria-label="Criteria and results"]')})`), true)
  await capture('1600-dark-overview', 1600)
  const discussion = '[aria-label^="Open discussion for "]'
  const assignments = '.goal-plan__assignments'
  const assignmentToggle = '.goal-plan__assignment-toggle'
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(discussion)}).length`), 1)
  assert.equal(await evaluate(`Boolean(${query('.goals-detail__overview-heading ' + discussion)})`), true)
  await jump('execution')
  assert.equal(await evaluate(hasSection('Execution records')), true)
  await capture('1600-dark-execution', 1600)
  await jump('plan')
  assert.equal(await evaluate(`${query(assignments)}.hidden`), true)
  await clickVisible(assignmentToggle)
  assert.equal(await evaluate(`${query(assignments)}.nextElementSibling === ${query('.goal-plan__workbench')} && !${query(assignments)}.hidden`), true)
  await capture('1600-dark-assignments', 1600)
  await clickVisible(assignmentToggle)
  await evaluate(`(() => {
    window.goalProbeCard = ${query(node('workspace'))}
    window.goalProbeEdge = ${query('[data-goal-plan-edge="outline>workspace"]')}
    const mutations = { pathUpdates: 0, geometryWrites: 0, childChanges: 0, unrelatedCardWrites: 0 }
    const observer = new MutationObserver(changes => {
      for (const change of changes) {
        if (change.type === 'childList') mutations.childChanges++
        if (change.attributeName === 'd') mutations.geometryWrites++
        if (change.attributeName === 'data-goal-path') {
          mutations.pathUpdates++
          if (change.target.dataset.goalPlanNode === 'guide') mutations.unrelatedCardWrites++
        }
      }
    })
    observer.observe(${query(canvas)}, { subtree: true, childList: true, attributes: true, attributeFilter: ['d', 'data-goal-path'] })
    window.finishGoalGraphSample = () => { observer.disconnect(); return mutations }
  })()`)
  await holdMidpoint(canvas, 'transitionrun')
  await pointer(query(node('workspace') + ' button'))
  await waitFor(`${query(canvas)}.dataset.goalTrace === 'workspace'`)
  await captureMidpoint('1600-dark-path-midpoint', 1600)
  const pathRole = selector => evaluate(`${query(selector)}.getAttribute('data-goal-path')`)
  assert.equal(await pathRole(node('outline')), 'upstream')
  assert.equal(await pathRole(node('verify')), 'downstream')
  assert.equal(await pathRole(node('guide')), null)
  assert.equal(await pathRole('[data-goal-plan-edge="outline>workspace"]'), 'upstream')
  assert.equal(await pathRole('[data-goal-plan-edge="workspace>verify"]'), 'downstream')
  await capture('1600-dark-path', 1600)
  const mutations = await evaluate('window.finishGoalGraphSample()')
  assert.ok(mutations.pathUpdates > 0)
  assert.deepEqual([mutations.geometryWrites, mutations.childChanges, mutations.unrelatedCardWrites], [0, 0, 0])
  result.observations.push({ hoveredNode: 'workspace', mutations })
  await pointer(query('.goals-detail__toolbar'))
  await evaluate(`${query(node('guide') + ' button')}.focus({preventScroll:true})`)
  await press('Tab', 9)
  const focused = await evaluate("document.activeElement.closest('[data-goal-plan-node]')?.dataset.goalPlanNode")
  assert.ok(focused && focused !== 'guide')
  assert.equal(await evaluate(`${query(canvas)}.dataset.goalTrace`), focused)
  await capture('1600-dark-keyboard-path', 1600)
  assert.equal(await evaluate(`Boolean(window.goalProbeCard && window.goalProbeEdge) && window.goalProbeCard === ${query(node('workspace'))} && window.goalProbeEdge === ${query('[data-goal-plan-edge="outline>workspace"]')}`), true)
  await captureAgentSources(1600, false)
  assert.deepEqual(await evaluate('goalsSpace.facts()'), before)

  await media('reduce')
  assert.equal(await evaluate(`getComputedStyle(${query('[data-goal-plan-edge="outline>workspace"]')}).transitionDuration`), '0s')
  await size(620)
  await evaluate("goalsVisual.appearance('light')")
  await jump('plan')
  await evaluate(`${query(article)}.scrollTop = 0`)
  await waitFor(hasSection('Execution plan'))
  await capture('620-light-workspace', 620)
  await pointer(query(node('workspace') + ' button'))
  await waitFor(`${query(canvas)}.dataset.goalTrace === 'workspace'`)
  const reducedEffects = await evaluate(`[${query(node('workspace'))}, ${query(node('outline'))}]
    .map(element => ({ transition: getComputedStyle(element).transitionDuration, running: element.getAnimations().length }))`)
  assert.ok(reducedEffects.every(effect => effect.running === 0 && effect.transition.split(',').every(time => parseFloat(time) === 0)), JSON.stringify(reducedEffects))
  await capture('620-light-path-reduced', 620)
  await clickVisible(assignmentToggle)
  assert.equal(await evaluate(`${query(assignmentToggle)}.getAttribute('aria-expanded')`), 'true')
  await capture('620-light-assignments', 620)
  await clickVisible(assignmentToggle)
  await clickVisible(outline)
  assert.equal(await evaluate(`${query(menu)}.getAnimations().filter(a => a.playState === 'running').length`), 0)
  await capture('620-light-outline-reduced', 620)
  await click(query('[data-goal-destination="overview"]'))
  await waitFor(hasSection('Goal overview'))
  await clickVisible(outline)
  assert.equal(await evaluate(`${query('[data-goal-destination="overview"]')}.getAttribute('aria-current')`), 'location')
  await capture('620-light-brief-outline', 620)
  await press('Escape', 27)
  const initialPosition = await readingPosition()
  const scroll = initialPosition.scrollTop
  assert.ok(scroll > 0)
  await evaluate(`(() => {
    const page = ${query(article)}, samples = []
    function mark(event) {
      const focused = document.activeElement
      samples.push({ event: event.type, view: page.dataset.goalView, top: page.scrollTop, focus: focused.getAttribute('aria-label') || focused.tagName })
    }
    const events = ['pointerdown', 'mousedown', 'focusin', 'click', 'scroll']
    for (const type of events) page.addEventListener(type, mark, true)
    window.finishGoalScrollSamples = () => {
      for (const type of events) page.removeEventListener(type, mark, true)
      return samples
    }
  })()`)
  await clickVisible(toggle)
  await waitFor(`${query(toggle)}.getAttribute('aria-pressed') === 'true'`)
  await capture('620-light-supervisor', 620)
  await click(query('.goal-supervisor-rail__assign'))
  await waitFor(`Boolean(${query('.goal-agent-picker [aria-label="Search Agents"]')})`)
  await capture('620-light-supervisor-picker', 620)
  await press('Escape', 27)
  await waitFor(`!${query('.goal-agent-picker')}`)
  await clickVisible(toggle)
  const restored = await readingPosition()
  result.observations.push({ initialPosition, restored, events: await evaluate('window.finishGoalScrollSamples()') })
  assert.ok(Math.abs(restored.scrollTop - scroll) <= 2 && Math.abs(restored.briefTop - initialPosition.briefTop) <= 2, JSON.stringify({ initialPosition, restored }))
  assert.equal(await evaluate(hasSection('Goal overview')), true)
  await capture('620-light-return', 620)
  await clickVisible(toggle)
  await captureAgentSources(620, true)
  await clickVisible(toggle)
  await jump('overview')
  await capture('620-light-overview', 620)
  await jump('execution')
  await capture('620-light-execution', 620)
  assert.deepEqual(await evaluate('goalsSpace.facts()'), before)

  // Retain an actual authored draft across both forms of navigation.
  await evaluate("goalsHierarchy.seed('pending-draft')")
  const draft = await evaluate('goalsSpace.facts()')
  assert.ok(draft.draft?.title?.value)
  await waitFor(`Boolean(${query(outline)}) && ${query(article)}.dataset.goalDetailId === ${JSON.stringify(draft.id)}`)
  await jump('overview')
  await clickVisible(toggle)
  await clickVisible(toggle)
  assert.deepEqual(await evaluate('goalsSpace.facts()'), draft)
  result.observations.push({ width: 620, reducedMotion: true, restoredScrollTop: scroll, names: destinations, preservedDraft: draft.draft.title.value })

  await evaluate("goalsPlan.seed(false, true); goalsVisual.appearance('light')")
  await waitFor(`Boolean(${handoff('drafts')})`)
  await jump('plan')
  await clickVisible(node('workspace') + ' button')
  assert.deepEqual(await roles('workspace'), ['Supervisor', 'Executor'])
  assert.match(await evaluate(`${handoff('workspace')}.textContent`), /Dispatch linked/)
  await evaluate(`${query(article)}.scrollTop = 0`)
  await capture('620-light-dispatch-handoff', 620)
}
