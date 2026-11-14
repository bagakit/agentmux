const assert = require('node:assert/strict')
module.exports = async ({ evaluate, size, pointer, capture, waitFor, result }) => {
  const scenes = [
    ...[1280, 620].flatMap(width => ['dark', 'light'].flatMap(theme => ['none', 'delivered'].map(state => ({width,theme,state})))),
    {width:1280,theme:'dark',state:'prepared'}, {width:620,theme:'light',state:'missing'},
    {width:1280,theme:'light',state:'unknown'}, {width:620,theme:'dark',state:'stale'}
  ]
  const filter=process.env.AGENTMUX_GOAL_PLAN_REQUEST_SCENE
  assert.ok(!filter||filter==='wide-no-supervisor','Select the finite changed planning scene only')
  result.sceneFilter=filter??null
  const selected=filter?scenes.filter(scene=>scene.width===1280&&scene.state==='none'):scenes
  for (const {width,theme,state} of selected) {
    await evaluate(`goalsPlan.request(${JSON.stringify(state)});goalsVisual.appearance(${JSON.stringify(theme)})`)
    await size(width)
    await waitFor('Boolean(document.querySelector("[data-goal-plan-request-feedback]"))')
    await evaluate('document.querySelector("[data-goal-plan-empty]").scrollIntoView({block:"center"})')
    await pointer('document.querySelector(".goals-detail__toolbar")')
    const facts=await evaluate(`(()=>{const block=document.querySelector('[data-goal-plan-request-feedback]');return {text:block.textContent,buttons:[...block.querySelectorAll('button')].map(button=>({text:button.textContent,disabled:button.disabled})),hasPatrol:!!document.querySelector('[aria-label="PMO 巡查"]'),hasGraph:!!document.querySelector('[data-goal-plan-node]'),overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    assert.equal(facts.hasPatrol,false,'Planning requests do not become PMO inspection controls')
    assert.equal(facts.hasGraph,false,'Prepared or delivered input is not a saved graph')
    assert.equal(facts.overflow,false,'Controls stay readable within the actual workface')
    if(state==='none')assert.ok(facts.buttons.some(button=>button.text==='Choose Supervisor to plan'))
    else assert.ok(facts.text.includes('Mira')&&facts.text.includes('planning'))
    result.observations.push({scene:'planning-request',width,theme,state,facts})
    await capture(`${width}-${theme}-planning-${state}`,width)
  }
  assert.equal(result.frames.length,filter?2:12,'All selected exact planning-request states were captured')
}
