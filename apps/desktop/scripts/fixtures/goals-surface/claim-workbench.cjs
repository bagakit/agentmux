const assert = require('node:assert/strict')

// Host-shaped preview inputs enter the normal App. All navigation below uses its rendered controls.
module.exports = async ({ evaluate, size, click, capture, waitFor, paint, result, keyEscape, debuggerSession }) => {
  const query = selector => `document.querySelector(${JSON.stringify(selector)})`
  const timelineOnly = process.env.AGENTMUX_GOAL_EXECUTION_TIMELINE_CAPTURE === '1'
  if (process.env.AGENTMUX_GOAL_PARTICIPATION_CAPTURE === '1') {
    const goalRow = '[data-goal-time-row="goal-participation"]'
    const point = goalRow + ' [data-goal-time-event="Goal confirmed"]'
    const request = goalRow + ' [data-goal-time-event="Continuation requested"]'
    const ticket = '[data-goal-time-row="node:workspace"] [data-goal-time-event="Executor assigned"]'
    const review = '[data-goal-time-row="attempt:history"] [data-goal-time-event="Changes requested"]'
    const detail = '.goal-execution-time__detail'
    const detailOpen = detail + ' > button'
    const originalAssignment = '[data-goal-coordination="plan:original-assignment"] details'
    const originalRequest = '[data-goal-coordination="patrol:original-continue-request"] details'
    const proposal = '[aria-label="Criteria and results"]'
    const reader = '.goal-plan__reading'
    for (const [width, theme] of [[1260, 'dark'], [620, 'light']]) {
      await size(width)
      await evaluate(`goalsPlan.seed(false, true, false, undefined, 85000, true); goalsVisual.appearance(${JSON.stringify(theme)})`)
      await waitFor(`Boolean(${query(point)} && ${query(request)} && ${query(ticket)} && ${query(review)})`)
      const before = await evaluate('goalsSpace.facts()')
      const scoped = await evaluate(`[...document.querySelectorAll('[data-goal-time-participant]')].map(point =>
        [point.closest('[data-goal-time-row]').dataset.goalTimeRow, point.dataset.goalTimeParticipant, point.dataset.goalTimeEvent])`)
      assert.deepEqual(scoped, [
        ['goal-participation', 'user', 'Goal confirmed'], ['goal-participation', 'device', 'Continuation requested'],
        ['node:workspace', 'user', 'Executor assigned'], ['attempt:history', 'user', 'Changes requested'],
      ])
      await evaluate(`${query('[data-goal-execution-time]')}.scrollIntoView({block:'center'})`)
      await paint()
      await capture(`${width}-${theme}-participation-overview`, width)
      await evaluate(`${query(request)}.scrollIntoView({block:'center'})`)
      const mouse = await evaluate(`(() => { const rect = ${query(request)}.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`)
      await debuggerSession.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mouse })
      const tooltip = `[...document.querySelectorAll('[role="tooltip"]')].find(node => node.textContent.includes('Device workspace-console'))`
      await waitFor(`Boolean(${tooltip} && getComputedStyle(${tooltip}).visibility === 'visible')`)
      assert.match(await evaluate(`${tooltip}.textContent`), /Continuation requested.*Original request recorded/su)
      await capture(`${width}-${theme}-participation-preview`, width)
      await hitControl(request)
      await waitFor(`Boolean(${query(detailOpen)})`)
      assert.match(await evaluate(`${query(detail)}.innerText`), /Continuation requested.*Device workspace-console.*original-continue-request/su)
      await evaluate(`${query(detail)}.scrollIntoView({block:'center'})`)
      await paint()
      await capture(`${width}-${theme}-participation-request`, width)
      await hitControl(detailOpen)
      await waitFor(`document.activeElement === ${query(originalRequest + ' summary')}`)
      await hitControl(originalRequest + ' button')
      await waitFor(`document.activeElement === ${query(request)}`)
      await hitControl(point)
      await waitFor(`${query(detailOpen)}?.innerText === 'Open original proposal'`)
      await hitControl(detailOpen)
      await waitFor(`document.activeElement === ${query(proposal)} && Boolean(${query(proposal + ' [data-goal-alignment-revision]')})`)
      await hitControl(proposal + ' > button')
      await waitFor(`document.activeElement === ${query(point)}`)
      await hitControl(ticket)
      await waitFor(`Boolean(${query(detailOpen)})`)
      assert.match(await evaluate(`${query(detail)}.innerText`), /Executor assigned.*original-assignment.*plan-worker-session/su)
      await hitControl(detailOpen)
      await waitFor(`document.activeElement === ${query(originalAssignment + ' summary')}`)
      await evaluate(`${query(originalAssignment)}.scrollIntoView({block:'center'})`)
      await paint()
      await capture(`${width}-${theme}-participation-original-assignment`, width)
      await hitControl(originalAssignment + ' button')
      await waitFor(`document.activeElement === ${query(ticket)}`)
      await hitControl(review)
      await waitFor(`${query(detailOpen)}?.innerText === 'Open original review'`)
      await hitControl(detailOpen)
      const verdict = reader + ' [data-goal-delivery="attempt:history"] [data-goal-plan-verdict]'
      await waitFor(`${query(verdict)}?.textContent.includes('recovery-owner')`)
      await evaluate(`${query(reader + ' .goal-plan__reading-header')}.scrollIntoView({block:'nearest'})`)
      await paint()
      await capture(`${width}-${theme}-participation-original-review`, width)
      await hitControl(reader + ' .goal-plan__reading-header button')
      await waitFor(`document.activeElement === ${query(review)}`)
      assert.deepEqual(await evaluate('goalsSpace.facts()'), before, 'Reading keeps the same Goal, plan, draft and Runs')
      result.observations.push({ scene: 'goal-participation', width, theme, scoped, exactOriginalsOpened: true, exactPointReturned: true })
    }
    return
  }
  if (process.env.AGENTMUX_GOAL_WORKFLOW_REVIEW_CAPTURE === '1') {
    const attempt = query('[data-goal-delivery="attempt:outline"]')
    const view = `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'View delivery')`
    for (const [width, theme] of [[1260, 'dark'], [620, 'light']]) for (const state of ['prepared', 'confirmed']) {
      await size(width)
      await evaluate(`goalsPlan.seed(false,true,false,${JSON.stringify(state)}); goalsVisual.appearance(${JSON.stringify(theme)})`)
      await waitFor(`Boolean(${view})`)
      await click(view)
      await waitFor(`Boolean(${attempt}?.querySelector('[data-goal-workflow-review]'))`)
      await evaluate(`${attempt}.querySelector('[data-goal-workflow-review]').scrollIntoView({block: 'center', behavior: 'instant'})`)
      await paint()
      const read = await evaluate(`(() => {
        const attempt = ${attempt}, notice = attempt.querySelector('[data-goal-workflow-review]'), manualReview = attempt.querySelector('.goal-delivery__form > summary')
        const visible = element => {
          const rect = element.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          return rect.top >= 80 && rect.bottom <= innerHeight - 24 && element.contains(hit)
        }
        return { status: notice.textContent, width: attempt.clientWidth, overflow: attempt.scrollWidth - attempt.clientWidth,
          visible: visible(notice), manualReview: manualReview.textContent === 'Record review' && visible(manualReview) }
      })()`)
      assert.ok(read.visible && read.manualReview && read.width > 0 && read.overflow <= 1, JSON.stringify(read))
      assert.match(read.status, state === 'confirmed' ? /reviewer received the original delivery/ : /Waiting for the original independent reviewer/)
      await capture(`${width}-${theme}-workflow-review-${state}`, width)
      result.observations.push({ width, theme, state, ...read })
    }
    return
  }
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
  for (const scene of timelineOnly ? [] : ['inspection', 'parallel']) for (const [width, theme] of [[1600, 'dark'], [620, 'light']]) {
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
      assert.equal(await evaluate(`Boolean(${query('[data-goal-time-row="start:workspace-check"] [data-goal-time-event="Request saved"]')})`), true)
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
    const duration = width === 1260 ? 85_000 : 12_000
    await evaluate(`goalsPlan.seed(false, true, false, undefined, ${duration})`)
    await evaluate(`goalsVisual.appearance(${JSON.stringify(theme)})`)
    const row = '[data-goal-time-row="attempt:drafts"]'
    const point = row + ' [data-goal-time-event="Report recorded"]'
    const observed = '[data-goal-time-row="attempt:workspace"]'
    const observedButton = observed + ' [data-goal-time-open]'
    const details = '.goal-execution-time__detail'
    const openEventRecord = details + ' > button'
    const bar = observed + ' [data-goal-observed-activity]'
    const reading = '.goal-plan__reading'
    const back = reading + ' .goal-plan__reading-header button'
    await waitFor(`Boolean(${query(point)} && ${query(bar)})`)
    const before = await evaluate('goalsSpace.facts()')
    const key = async (name, code, text) => {
      for (const type of ['keyDown', 'keyUp']) {
        await debuggerSession.sendCommand('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code,
          ...(text && type === 'keyDown' ? { text, unmodifiedText: text } : {}) })
      }
    }
    const enter = () => key('Enter', 13, '\r')
    const tab = () => key('Tab', 9)
    await evaluate(`${query('[data-goal-execution-time]')}.scrollIntoView({block:'center'})`)
    await paint()
    const summary = bar + ' .goal-execution-time__bar-summary'
    const focusSummary = observed + ' .goal-execution-time__activity-focus'
    const barEvidence = await evaluate(`(() => { const bar = ${query(bar)}, label = ${query(summary)};
      return { text: label.textContent, visible: Boolean(label.getClientRects().length), inkFits: label.scrollWidth <= label.clientWidth,
        fraction: bar.getBoundingClientRect().width / bar.parentElement.getBoundingClientRect().width,
        fill: getComputedStyle(bar).backgroundColor, planStyle: getComputedStyle(${query('[data-goal-planned-period]')}).borderTopStyle } })()`)
    assert.equal(barEvidence.text, width === 1260 ? '1m25s observed' : '12.0s observed')
    assert.equal(barEvidence.visible, width === 1260)
    assert.equal(barEvidence.inkFits, true)
    assert.ok(Math.abs(barEvidence.fraction - duration / 180_000) < 0.001, JSON.stringify(barEvidence))
    assert.equal(barEvidence.planStyle, 'dashed')
    assert.notEqual(barEvidence.fill, 'rgba(0, 0, 0, 0)')
    const hover = async selector => {
      const mouse = await evaluate(`(() => { const rect = ${query(selector)}.getBoundingClientRect();
        return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2} })()`)
      await debuggerSession.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mouse })
      await waitFor(`${query(selector)}.matches(':hover')`)
    }
    await debuggerSession.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 12, y: 54 })
    await waitFor(`!${query(observed)}.matches(':hover')`)
    const normal = await evaluate(`getComputedStyle(${query(observed)}).backgroundColor`)
    await hover(observed + ' strong')
    await paint()
    assert.equal(await evaluate(`${query(observed + ' .goal-execution-time__task')}.title`), await evaluate(`${query(bar)}.title`))
    const hovered = await evaluate(`getComputedStyle(${query(observed)}).backgroundColor`)
    assert.notEqual(hovered, normal)
    // Keep the verified hover style while capturing the private compositor.
    await debuggerSession.sendCommand('DOM.enable')
    await debuggerSession.sendCommand('CSS.enable')
    const { root } = await debuggerSession.sendCommand('DOM.getDocument')
    const { nodeId } = await debuggerSession.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: observed })
    await debuggerSession.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
    try {
      assert.equal(await evaluate(`getComputedStyle(${query(observed)}).backgroundColor`), hovered)
      await capture(`${width}-${theme}-${scene}`, width)
    } finally {
      await debuggerSession.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
    }
    await hitControl(bar)
    await waitFor(`${query(reading + ' h3')}?.textContent === 'Restore the whole workspace'`)
    assert.equal(await evaluate(`${query(observedButton)}.getAttribute('aria-pressed')`), 'true')
    await hitControl(back)
    assert.equal(await evaluate(`document.activeElement === ${query(observedButton)}`), true)
    await enter()
    await waitFor(`${query(reading + ' h3')}?.textContent === 'Restore the whole workspace'`)
    await tab()
    assert.equal(await evaluate(`document.activeElement === ${query(back)}`), true)
    await enter()
    await waitFor(`document.activeElement === ${query(observedButton)} && ${query(observedButton)}.matches(':focus-visible')`)
    await paint()
    assert.equal(await evaluate(`Boolean(${query(focusSummary)}.getClientRects().length) && ${query(focusSummary)}.textContent`), barEvidence.text)
    if (width === 620) await capture(`${width}-${theme}-${scene}-short-focus`, width)
    const preview = '[role="tooltip"]'
    const hoverPreview = `[...document.querySelectorAll(${JSON.stringify(preview)})].find(element => element.textContent.includes('Worker report saved'))`
    await evaluate(`${query(point)}.scrollIntoView({block: 'center'})`)
    await paint()
    await hover(point)
    await waitFor(`Boolean(${hoverPreview}?.getBoundingClientRect().width && getComputedStyle(${hoverPreview}).visibility === 'visible')`)
    assert.match(await evaluate(`${hoverPreview}.textContent`), /Report recorded.*plan-worker-session.*Worker report saved/su)
    await capture(`${width}-${theme}-${scene}-event-preview`, width)
    await hitControl(point)
    await waitFor(`document.activeElement === ${query(details + ' h4')} && Boolean(${query(openEventRecord)})`)
    assert.match(await evaluate(`${query(details)}.innerText`), /Report recorded.*reply:drafts.*The original identities/su)
    await evaluate(`${query(details)}.scrollIntoView({block:'center'})`)
    await paint()
    await capture(`${width}-${theme}-${scene}-event-detail`, width)
    await keyEscape()
    await waitFor(`!${query(details)} && document.activeElement === ${query(point)}`)
    await enter()
    await waitFor(`document.activeElement === ${query(details + ' h4')}`)
    await hitControl(openEventRecord)
    await waitFor(`Boolean(${query(reading + ' [data-goal-delivery="attempt:drafts"]')})`)
    assert.equal(await evaluate(`${query(row + ' [data-goal-time-open]')}.getAttribute('aria-pressed')`), 'true')
    await capture(`${width}-${theme}-${scene}-attempt`, width)
    await hitControl(back)
    await waitFor(`document.activeElement === ${query(point)}`)
    const unknown = '[data-goal-time-row="attempt:history"] [data-goal-time-event="Original dispatch linked"]'
    const keyboardPoint = '[data-goal-time-row="attempt:history"] [data-goal-time-event="Report recorded"]'
    const overlap = await evaluate(`(() => {
      const first = ${query(unknown)}.getBoundingClientRect(), second = ${query(keyboardPoint)}.getBoundingClientRect()
      return { firstX: first.x, secondX: second.x, firstBottom: first.bottom, secondTop: second.top }
    })()`)
    assert.equal(overlap.firstX, overlap.secondX)
    assert.ok(overlap.firstBottom <= overlap.secondTop, 'Same-time events have independent hit areas')
    await evaluate(`${query(unknown)}.scrollIntoView({block:'center'})`)
    await paint()
    const target = await evaluate(`(() => { const box = ${query(unknown)}.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 } })()`)
    await debuggerSession.sendCommand('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [target]})
    await debuggerSession.sendCommand('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []})
    await waitFor(`${query(details)}?.innerText.includes('Unknown author')`)
    await keyEscape()
    await waitFor(`document.activeElement === ${query(unknown)}`)
    await tab()
    await waitFor(`document.activeElement === ${query(keyboardPoint)} && Boolean(${hoverPreview})`)
    await paint()
    await capture(`${width}-${theme}-${scene}-event-focus`, width)
    assert.deepEqual(await evaluate('goalsSpace.facts()'), before)
    result.observations.push({ scene, width, theme, dispatch: 'attempt:workspace', report: 'attempt:drafts', normal, hovered, barEvidence,
      hoverCapturedWithPseudoState: true, eventPreview: true, exactEventReturn: true, keyboardOpened: true, touchOpened: true, overlap })
  }
  if (timelineOnly) return
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
