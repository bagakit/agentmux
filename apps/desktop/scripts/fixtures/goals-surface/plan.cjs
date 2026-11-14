const assert = require('node:assert/strict')

/** Screenshots are evidence for independent review, not an aesthetic approval. */
module.exports = async ({ evaluate, size, click, pointer, capture, waitFor, paint, result }) => {
  const { parseGoalResponsibility } = await import('@agentmux/core/goal-responsibility')
  const { demandExecutionReferences } = await import('@agentmux/demand')
  const states = ['done', 'ready', 'working', 'review', 'changes', 'unknown', 'waiting']
  const canvasGeometry = () => evaluate(`(()=>{const canvas=document.querySelector('.goal-plan__canvas'),columns=canvas.querySelector('.goal-plan__columns'),svg=canvas.querySelector('.goal-plan__edges');return {clientHeight:canvas.clientHeight,scrollHeight:canvas.scrollHeight,contentHeight:columns.getBoundingClientRect().height,svgHeight:Number(svg.getAttribute('height'))}})()`)
  // The sticky toolbar is visible in every reading position, including narrow dependency tails.
  const restOn = async () => {
    await pointer(`document.querySelector('.goals-detail__toolbar')`)
    assert.equal(await evaluate(`document.querySelectorAll('.goal-plan-node:hover').length`), 0, 'No plan card is hovered in the frame')
  }
  // Every written dependency name fits one line here, so none may be split across lines.
  const wholeDependencyNames = async () => {
    const names = await evaluate(`[...document.querySelectorAll('.goal-plan-node .goal-plan-dependency')].filter(name=>name.offsetParent).map(name=>name.getBoundingClientRect().height<parseFloat(getComputedStyle(name).fontSize)*2)`)
    assert.ok(names.length > 0 && names.every(Boolean), 'Written dependency names wrap only between names')
  }
  for (const [width, theme] of [[1280, 'dark'], [1280, 'light'], [620, 'light'], [620, 'dark']]) {
    await evaluate(`goalsPlan.seed();goalsVisual.appearance(${JSON.stringify(theme)})`)
    await size(width)
    await waitFor('document.querySelectorAll("[data-goal-plan-node]").length === 7')
    const original = await evaluate('goalsPlan.facts()')
    assert.ok(original.delegations.every(delegation => delegation.hostId !== delegation.workerHostId && delegation.workerHostId === 'plan-worker'),
      'Plan frames keep the original owner and remote worker Hosts separate')
    assert.deepEqual(parseGoalResponsibility(original.responsibility, demandExecutionReferences({ delegations: original.delegations })), original.responsibility,
      'Preview responsibility observations pass the production schema at the Node boundary')
    const facts = await evaluate(`({states:[...document.querySelectorAll('[data-goal-plan-node]')].map(node=>node.dataset.goalPlanState),
      progress:document.querySelector('[data-goal-meta-plan]').textContent,
      revision:document.querySelector('[data-goal-plan-progress]').textContent,
      selected:[...document.querySelectorAll('[data-goal-plan-node] .goal-plan-node__head[aria-expanded=true]')].map(head=>head.closest('[data-goal-plan-node]').dataset.goalPlanNode),
      highlight:[...document.querySelectorAll('.goal-plan-node--next')].map(node=>node.dataset.goalPlanNode),
      columns:[...document.querySelectorAll('[data-goal-plan-column]')].map(column=>[...column.querySelectorAll('[data-goal-plan-node]')].map(node=>node.dataset.goalPlanNode)),
      theme:document.documentElement.dataset.appearance})`)
    assert.deepEqual(facts.states, states, 'Every representative state comes from the real plan projection')
    assert.equal(facts.progress, 'Plan 1 of 7 done')
    assert.equal(facts.revision, 'Revision 2')
    assert.deepEqual(facts.selected, ['drafts'])
    assert.deepEqual(facts.highlight, [])
    assert.deepEqual(facts.columns, [['outline', 'guide'], ['workspace', 'drafts', 'history', 'reconnect'], ['verify']])
    assert.equal(facts.theme, theme, 'Actual App theme matches the frame')
    assert.ok(await evaluate(`document.querySelector('.goal-delivery__source .goal-plan-node__place')?.textContent==='Remote · Recovery worker'`),
      'Node locations name the configured remote Host, not only its route id')
    result.observations.push({ scene: 'plan', width, theme, facts })
    const firstScreen = await evaluate(`(()=>{const plan=document.querySelector('.goal-plan').getBoundingClientRect(),head=document.querySelector('.goals-detail__head').getBoundingClientRect(),side=document.querySelector('.goals-detail__side').getBoundingClientRect();return {planTop:plan.top,headBottom:head.bottom,sideWidth:side.width,sideTop:side.top,headTop:head.top,planVisible:plan.top<innerHeight-100,wideFacts:side.left>plan.left+plan.width}})()`)
    assert.ok(firstScreen.planVisible && firstScreen.planTop >= firstScreen.headBottom, 'The first screen reads the title then the actual plan')
    if (width === 620) assert.equal(firstScreen.sideWidth, 0, 'Narrow Supervisor waits in its reading destination')
    else assert.ok(firstScreen.wideFacts && Math.abs(firstScreen.sideTop-firstScreen.headTop)<8, 'Wide Supervisor aligns with the Goal heading')
    result.observations.push({scene:'detail-first-screen',width,theme,firstScreen})
    await restOn('Goal definition')
    await capture(`${width}-${theme}-plan-context`, width)
    await evaluate(`(()=>{const graph=document.querySelector('.goal-plan'),detail=graph.closest('.goals-detail');graph.scrollIntoView({block:'start'});detail.scrollTop-=detail.querySelector('.goals-detail__toolbar').getBoundingClientRect().height+12})()`)
    await paint()
    const geometry = await evaluate(`(()=>{const graph=document.querySelector('.goal-plan'),canvas=graph.querySelector('.goal-plan__canvas'),columns=graph.querySelector('.goal-plan__columns');return {graphWidth:graph.getBoundingClientRect().width,canvasWidth:canvas.clientWidth,canvasScrollWidth:canvas.scrollWidth,columnFlow:getComputedStyle(columns).gridAutoFlow,edges:getComputedStyle(graph.querySelector('.goal-plan__edges')).display,paths:graph.querySelectorAll('[data-goal-plan-edge]').length}})()`)
    assert.ok(geometry.graphWidth > 200, 'The real graph has a readable viewport')
    if (width === 620) {
      assert.equal(geometry.columnFlow, 'row', 'Narrow graph reads as vertical dependency groups')
      assert.equal(geometry.edges, 'none', 'Narrow graph hides crossing curves')
      assert.ok(await evaluate(`[...document.querySelectorAll('[data-goal-plan-depends]')].every(node=>{const text=node.querySelector('.goal-plan-node__depends');return text&&getComputedStyle(text).display!=='none'&&text.textContent.includes('Depends on')})`),
        'Every narrow dependent card keeps its dependency names without requiring expansion')
    } else {
      assert.equal(geometry.columnFlow, 'column', 'Wide graph preserves the left-to-right dependency columns')
      assert.ok(geometry.paths > 0, 'Wide graph has real dependency curves')
    }
    result.observations.push({ scene: 'plan-geometry', width, theme, geometry })
    await wholeDependencyNames()
    const closed = await canvasGeometry()
    await restOn('Execution plan')
    await capture(`${width}-${theme}-plan-graph`, width)
    if (width === 620) {
      await evaluate('document.querySelector("[data-goal-plan-node=verify]").scrollIntoView({block:"center"})')
      await restOn('Results review')
      await capture(`${width}-${theme}-plan-dependency-tail`, width)
    }
    await click('document.querySelector("[data-goal-plan-node=history] .goal-plan-node__head")')
    await waitFor('Boolean(document.querySelector("[data-goal-plan-detail=history]"))')
    await evaluate('document.querySelector("[data-goal-plan-detail=history]").closest(".goal-plan__reading").scrollIntoView({block:"center"})')
    const detail = await evaluate('document.querySelector("[data-goal-plan-detail=history]").textContent')
    assert.ok(detail.includes('thread:history') && detail.includes('Changes requested') && detail.includes('original reading anchor'), 'Expanded node retains its original thread, report and review')
    const expanded = await canvasGeometry()
    await capture(`${width}-${theme}-plan-review`, width)
    await click('document.querySelector(".goal-plan__reading-header button")')
    await waitFor('!document.querySelector("[data-goal-plan-detail=history]")')
    assert.equal(await evaluate('document.activeElement.closest("[data-goal-plan-node]")?.dataset.goalPlanNode'), 'history',
      'Back to node restores focus to the original selected node')
    await paint()
    const closedAgain = await canvasGeometry()
    result.observations.push({ scene: 'plan-open-close', width, theme, closed, expanded, closedAgain })
    assert.ok(closedAgain.scrollHeight <= closed.scrollHeight + 1 && closedAgain.svgHeight <= closed.svgHeight + 1,
      'Closing the original node restores the original canvas extent instead of retaining the expanded SVG height')
    if (theme === 'light') {
      await evaluate(`document.querySelector('.goals-activity').scrollIntoView({block:'start'})`)
      await click(`document.querySelector('.goals-activity__decision summary')`)
      await restOn()
      assert.equal(await evaluate(`document.querySelectorAll('.goals-activity__row').length`), 6, 'Recent activity reads directly while earlier records remain available')
      await capture(`${width}-${theme}-detail-activity`, width)
      await evaluate(`document.querySelector('[data-goal-attempt="previous"]').scrollIntoView({block:'center'})`)
      await click(`document.querySelector('[data-goal-attempt="previous"] .goal-delegation__source summary')`)
      await restOn()
      const earlier = await evaluate(`document.querySelector('[data-goal-attempt="previous"]').textContent`)
      assert.ok(earlier.includes('Previous attempt') && earlier.includes('Earlier guide author') && earlier.includes('thread:guide') && earlier.includes('request:guide'), 'The original previous worker, source and thread stay readable after reassignment')
      await capture(`${width}-${theme}-previous-attempt`, width)
    }
  }
  for (const [width, theme] of [[1280, 'dark'], [620, 'light']]) {
    await evaluate(`goalsPlan.seed(true);goalsVisual.appearance(${JSON.stringify(theme)})`)
    await size(width)
    await waitFor('document.querySelectorAll("[data-goal-plan-node]").length === 7 && Boolean(document.querySelector("[data-goal-plan-states-unavailable]"))')
    const facts = await evaluate(`({states:[...new Set([...document.querySelectorAll('[data-goal-plan-node]')].map(node=>node.dataset.goalPlanState))],
      caption:document.querySelector('[data-goal-plan-progress]').textContent, columns:document.querySelectorAll('[data-goal-plan-column]').length,
      highlight:document.querySelectorAll('.goal-plan-node--next').length, progressBar:Boolean(document.querySelector('.goal-plan__progress')),
      dependenciesWritten:[...document.querySelectorAll('[data-goal-plan-depends] .goal-plan-node__depends')].every(text=>getComputedStyle(text).display!=='none'),
      fullWidth:document.querySelector('[data-goal-plan-column]').getBoundingClientRect().width>=document.querySelector('.goal-plan__columns').getBoundingClientRect().width-1,
      theme:document.documentElement.dataset.appearance})`)
    assert.deepEqual(facts, { states: ['unavailable'], caption: 'Revision 2', columns: 1, highlight: 0, progressBar: false, dependenciesWritten: true, fullWidth: true, theme },
      'A plan without its owner derivation reads as a plan-order list with written dependencies, never as guessed states')
    result.observations.push({ scene: 'plan-unavailable', width, theme, facts })
    await wholeDependencyNames()
    await evaluate(`(()=>{const graph=document.querySelector('.goal-plan'),detail=graph.closest('.goals-detail');graph.scrollIntoView({block:'start'});detail.scrollTop-=detail.querySelector('.goals-detail__toolbar').getBoundingClientRect().height+12})()`)
    await restOn('Execution plan')
    await capture(`${width}-${theme}-plan-unavailable`, width)
    // The last card has the longest dependency list; the tail shows it whole and the gap to the next section.
    await evaluate('document.querySelector("[data-goal-plan-node=verify]").scrollIntoView({block:"center"})')
    await restOn('Results review')
    await capture(`${width}-${theme}-plan-unavailable-tail`, width)
  }
  assert.equal(result.frames.length, 22, 'Four viewports/themes, dependency tails, unavailable-state reading, activity timelines and retained previous attempts')
}
