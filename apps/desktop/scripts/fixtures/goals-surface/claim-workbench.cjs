const assert = require('node:assert/strict')

// Host-shaped preview inputs enter the normal App. All navigation below uses its rendered controls.
module.exports = async ({ evaluate, size, click, capture, waitFor, paint, result }) => {
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
  const readingButton = label => `[...document.querySelectorAll('.goals-detail__reading-nav button')].find(node => node.textContent === ${JSON.stringify(label)})`
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
    } else {
      const guide = '[data-goal-plan-node="guide"]'
      assert.equal(await evaluate(`${query(guide + ' [data-claim-open]')}.textContent`), 'Open to claim')
      assert.ok(await evaluate(`Boolean(${query('.goals-detail__copy')})`), 'The owner-qualified Goal link is available')
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
      assert.equal(scope.heading, 'Goal work')
      assert.equal(scope.selectedTitle, 'Write the recovery guide')
      assert.equal(scope.operation, 'attempt:' + scope.node)
      assert.notEqual(scope.node, 'guide', 'The visible original report belongs to its own recorded task')
      await evaluate(`${query(assignments)}.scrollIntoView({block: 'center'})`)
      await paint()
      await capture(`${width}-${theme}-open-node`, width)
      const index = '.goal-plan__assignments'
      assert.equal(await evaluate(`${query(index)}.open`), false)
      await hitControl(index + ' > summary')
      assert.equal(await evaluate(`${query(index)}.querySelectorAll('nav button').length`), 7)
      await hitControl(index + ' nav button')
      assert.ok(await evaluate(`Boolean(${query('.goal-plan__reading h3')})`))
    }
    if (width === 620) {
      await click(readingButton('Supervisor'))
      assert.ok(await evaluate(`${query('.goals-detail__side')}.getBoundingClientRect().width > 0`))
      await capture(`${width}-${theme}-${scene}-supervisor`, width)
      await click(readingButton('Plan'))
      assert.equal(await evaluate(`${query('.goals-detail')}.dataset.goalView`), 'work')
    }
    assert.deepEqual(await evaluate('goalsSpace.facts()'), before, 'Reading preserves the same goal, plan, draft and Runs')
    result.observations.push({ scene, width, theme, first })
  }
}
