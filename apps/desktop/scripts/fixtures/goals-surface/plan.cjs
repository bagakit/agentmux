const assert = require('node:assert/strict')

/** Screenshots are evidence for independent review, not an aesthetic approval. */
module.exports = async ({ evaluate, size, click, capture, waitFor, paint, result }) => {
  const { parseGoalResponsibility } = await import('@agentmux/core/goal-responsibility')
  const { demandExecutionReferences } = await import('@agentmux/demand')
  const states = ['done', 'ready', 'working', 'review', 'changes', 'unknown', 'waiting']
  const canvasGeometry = () => evaluate(`(()=>{const canvas=document.querySelector('.goal-plan__canvas'),columns=canvas.querySelector('.goal-plan__columns'),svg=canvas.querySelector('.goal-plan__edges');return {clientHeight:canvas.clientHeight,scrollHeight:canvas.scrollHeight,contentHeight:columns.getBoundingClientRect().height,svgHeight:Number(svg.getAttribute('height'))}})()`)
  for (const [width, theme] of [[1280, 'dark'], [1280, 'light'], [620, 'light'], [620, 'dark']]) {
    await evaluate(`goalsPlan.seed();goalsVisual.appearance(${JSON.stringify(theme)})`)
    await size(width)
    await waitFor('document.querySelectorAll("[data-goal-plan-node]").length === 7')
    const original = await evaluate('goalsPlan.facts()')
    assert.deepEqual(parseGoalResponsibility(original.responsibility, demandExecutionReferences({ delegations: original.delegations })), original.responsibility,
      'Preview responsibility observations pass the production schema at the Node boundary')
    const facts = await evaluate(`({states:[...document.querySelectorAll('[data-goal-plan-node]')].map(node=>node.dataset.goalPlanState),
      progress:document.querySelector('[data-goal-plan-progress]').textContent,
      highlight:[...document.querySelectorAll('.goal-plan-node--next')].map(node=>node.dataset.goalPlanNode),
      columns:[...document.querySelectorAll('[data-goal-plan-column]')].map(column=>[...column.querySelectorAll('[data-goal-plan-node]')].map(node=>node.dataset.goalPlanNode)),
      theme:document.documentElement.dataset.appearance})`)
    assert.deepEqual(facts.states, states, 'Every representative state comes from the real plan projection')
    assert.equal(facts.progress, '1 of 7 done · revision 2')
    assert.deepEqual(facts.highlight, ['history'])
    assert.deepEqual(facts.columns, [['outline', 'guide'], ['workspace', 'drafts', 'history', 'reconnect'], ['verify']])
    assert.equal(facts.theme, theme, 'Actual App theme matches the frame')
    result.observations.push({ scene: 'plan', width, theme, facts })
    await capture(`${width}-${theme}-plan-context`, width)
    await evaluate(`(()=>{const graph=document.querySelector('.goal-plan'),detail=graph.closest('.goals-detail');graph.scrollIntoView({block:'start'});detail.scrollTop-=detail.querySelector('.goals-detail__toolbar').getBoundingClientRect().height+12})()`)
    await paint()
    const geometry = await evaluate(`(()=>{const graph=document.querySelector('.goal-plan'),canvas=graph.querySelector('.goal-plan__canvas'),columns=graph.querySelector('.goal-plan__columns');return {graphWidth:graph.getBoundingClientRect().width,canvasWidth:canvas.clientWidth,canvasScrollWidth:canvas.scrollWidth,columnFlow:getComputedStyle(columns).gridAutoFlow,edges:getComputedStyle(graph.querySelector('.goal-plan__edges')).display,paths:graph.querySelectorAll('[data-goal-plan-edge]').length}})()`)
    assert.ok(geometry.graphWidth > 200, 'The real graph has a readable viewport')
    if (width === 620) {
      assert.equal(geometry.columnFlow, 'row', 'Narrow graph reads as vertical dependency groups')
      assert.equal(geometry.edges, 'none', 'Narrow graph hides crossing curves')
    } else {
      assert.equal(geometry.columnFlow, 'column', 'Wide graph preserves the left-to-right dependency columns')
      assert.ok(geometry.paths > 0, 'Wide graph has real dependency curves')
    }
    result.observations.push({ scene: 'plan-geometry', width, theme, geometry })
    const closed = await canvasGeometry()
    await capture(`${width}-${theme}-plan-graph`, width)
    if (width === 620) {
      await evaluate('document.querySelector("[data-goal-plan-node=verify]").scrollIntoView({block:"center"})')
      await capture(`${width}-${theme}-plan-dependency-tail`, width)
    }
    await click('document.querySelector("[data-goal-plan-node=history] .goal-plan-node__head")')
    await waitFor('Boolean(document.querySelector("[data-goal-plan-detail=history]"))')
    await evaluate('document.querySelector("[data-goal-plan-detail=history]").closest(".goal-plan__reading").scrollIntoView({block:"center"})')
    const detail = await evaluate('document.querySelector("[data-goal-plan-detail=history]").textContent')
    assert.ok(detail.includes('thread:history') && detail.includes('Changes requested') && detail.includes('original reading anchor'), 'Expanded node retains its original thread, report and review')
    const expanded = await canvasGeometry()
    await capture(`${width}-${theme}-plan-review`, width)
    await click('document.querySelector(".goal-plan__reading > .goals-section-heading button")')
    await waitFor('!document.querySelector("[data-goal-plan-detail=history]")')
    assert.equal(await evaluate('document.activeElement.closest("[data-goal-plan-node]")?.dataset.goalPlanNode'), 'history',
      'Back to node restores focus to the original selected node')
    await paint()
    const closedAgain = await canvasGeometry()
    result.observations.push({ scene: 'plan-open-close', width, theme, closed, expanded, closedAgain })
    assert.ok(closedAgain.scrollHeight <= closed.scrollHeight + 1 && closedAgain.svgHeight <= closed.svgHeight + 1,
      'Closing the original node restores the original canvas extent instead of retaining the expanded SVG height')
  }
  assert.equal(result.frames.length, 14, 'Four viewports/themes have context, graph and expanded-review frames, plus both narrow dependency tails')
}
