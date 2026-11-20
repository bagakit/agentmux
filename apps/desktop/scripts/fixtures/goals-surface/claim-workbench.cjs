const assert = require('node:assert/strict')

// Host-shaped preview inputs enter the normal App. All navigation below uses its rendered controls.
module.exports = async ({ evaluate, size, click, capture, waitFor, paint, result, keyEscape, debuggerSession }) => {
  const query = selector => `document.querySelector(${JSON.stringify(selector)})`
  async function hitControl(selector) {
    const target = query(selector)
    await evaluate(`${target}.scrollIntoView({block: 'nearest'})`)
    await paint()
    const hittable = await evaluate(`(() => { const element = ${target}, rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return { hit: element.contains(hit), targetY: rect.y, hitClass: hit?.className, margin: getComputedStyle(element).scrollMarginTop } })()`)
    assert.equal(hittable.hit, true, selector + ' remains clickable below the sticky reading navigation ' + JSON.stringify(hittable))
    await click(target)
  }
  for (const scene of ['inspection', 'parallel']) for (const [width, theme] of [[1600, 'dark'], [620, 'light']]) {
    await size(width)
    await evaluate(scene === 'inspection' ? 'goalsPlan.inspection()' : 'goalsPlan.seed(false, true)')
    await evaluate(`goalsVisual.appearance(${JSON.stringify(theme)})`)
    await waitFor(scene === 'inspection' ? `Boolean(${query('[data-goal-plan-origin]')})` : 'document.querySelectorAll("[data-goal-plan-node]").length === 7')
    await evaluate('document.querySelector(".goals-detail").scrollTop = 0')
    await paint()
    const before = await evaluate('goalsSpace.facts()')
    const first = await evaluate(`(() => {
      const detail = document.querySelector('.goals-detail'), graph = detail.querySelector('.goal-plan__canvas')
      const rail = detail.querySelector('.goals-detail__side'), graphBox = graph.getBoundingClientRect()
      return { theme: document.documentElement.dataset.appearance, width: detail.clientWidth,
        pageOverflow: detail.scrollWidth - detail.clientWidth, canvasTop: graphBox.top, canvasHeight: graphBox.height,
        firstNodeTop: graph.querySelector('[data-goal-plan-node]').getBoundingClientRect().top,
        endpoints: [...graph.querySelectorAll('[data-goal-plan-boundary]')].map(node => node.dataset.goalPlanBoundary),
        railVisible: rail.getBoundingClientRect().width > 0, timelineRows: detail.querySelectorAll('[data-goal-time-row]').length }
    })()`)
    assert.equal(first.theme, theme)
    assert.ok(first.pageOverflow <= 1 && first.firstNodeTop < 690 && first.canvasHeight > 80, JSON.stringify(first))
    assert.deepEqual(first.endpoints, ['start', 'finish'])
    assert.ok(first.timelineRows > 0)
    assert.equal(first.railVisible, width === 1600)
    await capture(`${width}-${theme}-${scene}`, width)
    if (scene === 'inspection') {
      assert.equal(await evaluate(`${query('[data-goal-time-row="start:workspace-check"] time')}.closest('li').innerText.includes('Request saved')`), true)
      assert.equal(await evaluate('document.querySelectorAll(".goal-execution-time__live, .goal-execution-time__planned").length'), 0)
      const target = '[data-goal-work-kind="patrol"][data-goal-work-operation="inspection:workspace/original"]'
      assert.equal(await evaluate(`${query('.goals-detail__stage .goals-detail__current-work')}.textContent`), 'View original inspection')
      await click(query('.goals-detail__stage .goals-detail__current-work'))
      assert.equal(await evaluate(`document.activeElement === ${query(target)}`), true, 'Read the exact retained patrol operation')
      if (width === 620) await click(query('[data-goal-supervisor-toggle]'))
    } else {
      const guide = '[data-goal-plan-node="guide"]'
      assert.equal(await evaluate(`${query(guide + ' [data-claim-open]')}.textContent`), 'Open to claim')
      await click(query('[aria-label="Goal actions"]'))
      await waitFor(`[...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent.trim() === 'Copy goal link')`)
      await keyEscape()
      await waitFor(`!document.querySelector('[role="menu"]')`)
      await click(query(guide + ' button'))
      const assignments = '[aria-label="Node assignment"]'
      assert.ok(await evaluate(`${query(assignments)}.innerText.includes('Close claims')`))
      assert.ok(await evaluate(`${query(assignments)}.innerText.includes('Assign')`))
      const scope = await evaluate(`(() => {
        const work = document.querySelector('[data-goal-work-area]'), report = [...work.querySelectorAll('[data-goal-work-kind="delegation"]')].find(element => element.getBoundingClientRect().height > 0)
        return { heading: work.querySelector('h2').textContent, operation: report.dataset.goalWorkOperation,
          node: report.querySelector('[data-goal-work-node]').dataset.goalWorkNode,
          selectedTitle: document.querySelector('.goal-plan__reading h3').textContent }
      })()`)
      assert.equal(scope.heading, 'Execution records')
      assert.equal(scope.selectedTitle, 'Write the recovery guide')
      assert.equal(scope.operation, 'attempt:' + scope.node)
      assert.notEqual(scope.node, 'guide', 'The visible original report belongs to its own recorded task')
      await evaluate(`${query(assignments)}.scrollIntoView({block: 'center'})`)
      await paint()
      await capture(`${width}-${theme}-open-node`, width)
      const index = '.goal-plan__assignments'
      assert.equal(await evaluate(`${query(index)}.hidden`), true)
      await hitControl('.goal-plan__assignment-toggle')
      assert.equal(await evaluate(`${query(index)}.hidden`), false)
      assert.equal(await evaluate(`${query(index)}.querySelectorAll('nav button').length`), 7)
      await hitControl(index + ' nav button')
      assert.ok(await evaluate(`Boolean(${query('.goal-plan__reading h3')})`))
    }
    if (width === 620) {
      await click(query('[data-goal-supervisor-toggle]'))
      assert.ok(await evaluate(`${query('.goals-detail__side')}.getBoundingClientRect().width > 0`))
      await capture(`${width}-${theme}-${scene}-supervisor`, width)
      await click(query('[data-goal-supervisor-toggle]'))
      assert.equal(await evaluate(`${query('.goals-detail')}.dataset.goalView`), 'work')
    }
    assert.deepEqual(await evaluate('goalsSpace.facts()'), before, 'Reading preserves the same goal, plan, draft and Runs')
    result.observations.push({ scene, width, theme, first })
  }
  for (const [width, theme] of [[1260, 'dark'], [620, 'light']]) {
    const scene = 'execution-timeline'
    await size(width)
    await evaluate('goalsPlan.seed(false, true)')
    await evaluate(`goalsVisual.appearance(${JSON.stringify(theme)})`)
    const row = '[data-goal-time-row="attempt:drafts"]'
    const point = row + ' [data-goal-time-event="Report recorded"]'
    const observed = '[data-goal-time-row="attempt:workspace"]'
    const bar = observed + ' [data-goal-observed-activity]'
    const reading = '.goal-plan__reading'
    const back = reading + ' .goal-plan__reading-header button'
    await waitFor(`Boolean(${query(point)} && ${query(bar)})`)
    const before = await evaluate('goalsSpace.facts()')
    const enter = async () => {
      for (const type of ['keyDown', 'keyUp']) {
        await debuggerSession.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
          ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) })
      }
    }
    await evaluate(`${query('[data-goal-execution-time]')}.scrollIntoView({block:'center'})`)
    await paint()
    const hover = async selector => {
      const mouse = await evaluate(`(() => { const rect = ${query(selector)}.getBoundingClientRect();
        return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2} })()`)
      await debuggerSession.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mouse })
      await waitFor(`${query(selector)}.matches(':hover')`)
    }
    await debuggerSession.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 12, y: 54 })
    await waitFor(`!${query(observed)}.matches(':hover')`)
    const normal = await evaluate(`getComputedStyle(${query(observed)}).backgroundColor`)
    await hover(bar)
    await waitFor(`getComputedStyle(${query(observed)}).backgroundColor !== ${JSON.stringify(normal)}`)
    await capture(`${width}-${theme}-${scene}`, width)
    await hitControl(bar)
    await waitFor(`${query(reading + ' h3')}?.textContent === 'Restore the whole workspace'`)
    assert.equal(await evaluate(`${query(observed)}.getAttribute('aria-pressed')`), 'true')
    await hitControl(back)
    assert.equal(await evaluate(`document.activeElement === ${query(observed)}`), true)
    await hover(point)
    assert.match(await evaluate(`${query(point)}.title`), /^Report recorded · .+/u)
    await hitControl(point)
    await waitFor(`Boolean(${query(reading + ' [data-goal-delivery="attempt:drafts"]')})`)
    assert.equal(await evaluate(`${query(row)}.getAttribute('aria-pressed')`), 'true')
    await capture(`${width}-${theme}-${scene}-attempt`, width)
    await hitControl(back)
    assert.equal(await evaluate(`document.activeElement === ${query(row)}`), true)
    await enter()
    await waitFor(`Boolean(${query(reading + ' [data-goal-delivery="attempt:drafts"]')})`)
    for (const type of ['keyDown', 'keyUp']) {
      await debuggerSession.sendCommand('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    }
    assert.equal(await evaluate(`document.activeElement === ${query(back)}`), true)
    await enter()
    await waitFor(`document.activeElement === ${query(row)} && ${query(row)}.matches(':focus-visible')`)
    await paint()
    await capture(`${width}-${theme}-${scene}-focus`, width)
    assert.deepEqual(await evaluate('goalsSpace.facts()'), before)
    result.observations.push({ scene, width, theme, dispatch: 'attempt:workspace', report: 'attempt:drafts', focusReturned: true, keyboardOpened: true })
  }
  for (const [width, theme] of [[1600, 'dark'], [620, 'light']]) {
    await size(width)
    await evaluate('goalsPlan.seed(false, true, true)')
    await evaluate(`goalsVisual.appearance(${JSON.stringify(theme)})`)
    const avatar = query('[data-goal-confirm-agent]')
    const criteria = query('[aria-label="Review goal criteria before confirming"]')
    await waitFor(`Boolean(${avatar})`)
    await hitControl('[data-goal-plan-node="guide"] .goal-plan-node__head')
    await waitFor(`Boolean(${criteria})`)
    assert.equal(await evaluate(`${query('[data-goal-finite-start]')}.closest('details').open`), false)
    await capture(`${width}-${theme}-criteria-from-ticket`, width)
    await click(criteria)
    await waitFor(`document.activeElement === ${query('[aria-label="Criteria and results"]')}`)
    await evaluate(`${avatar}.closest('button').scrollIntoView({block:'center'})`)
    await paint()
    await capture(`${width}-${theme}-confirm-and-continue`, width)
    const point = await evaluate(`(() => {const r = ${avatar}.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await debuggerSession.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await waitFor(`[...document.querySelectorAll('[role="tooltip"]')].some(element => element.textContent.includes('Supervisor') && element.textContent.includes('Mira') && element.textContent.includes('Idle'))`)
    await capture(`${width}-${theme}-confirm-agent-hover`, width)
  }
  for (const [width, theme] of [[1260, 'dark'], [620, 'light']]) {
    await size(width)
    await evaluate('goalsPlan.activeTickets()')
    await evaluate(`goalsVisual.appearance(${JSON.stringify(theme)})`)
    await click(query('[data-surface-mode="tickets"]'))
    await waitFor('document.querySelectorAll("[data-active-ticket]").length === 5')
    assert.equal(await evaluate(`${query('[data-surface-mode="tickets"]')}.scrollWidth <= ${query('[data-surface-mode="tickets"]')}.clientWidth`), true)
    assert.equal(await evaluate(`${query('[aria-label="Active tickets"]')}.scrollWidth <= ${query('[aria-label="Active tickets"]')}.clientWidth`), true)
    await capture(`${width}-${theme}-active-tickets`, width)
  }
  await evaluate('goalsVisual.seed("one")')
  await evaluate('goalsPlan.activeTickets(true);goalsVisual.appearance("light")')
  await waitFor(`Boolean(${query('[data-surface-mode="tickets"]')})`)
  await click(query('[data-surface-mode="tickets"]'))
  await waitFor(`document.body.innerText.includes('Active tickets are unavailable')`)
  await capture('620-light-active-tickets-unavailable', 620)

}
