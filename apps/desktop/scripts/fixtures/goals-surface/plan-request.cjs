const assert = require('node:assert/strict')
module.exports = async ({ evaluate, size, pointer, capture, waitFor, result }) => {
  const scenes = [
    ...[1280, 620].flatMap(width => ['dark', 'light'].flatMap(theme => ['none', 'delivered'].map(state => ({width,theme,state})))),
    {width:1280,theme:'dark',state:'prepared'}, {width:620,theme:'light',state:'missing'},
    {width:1280,theme:'light',state:'unknown'}, {width:620,theme:'dark',state:'stale'}
  ]
  const filter=process.env.AGENTMUX_GOAL_PLAN_REQUEST_SCENE
  assert.ok(!filter||['wide-no-supervisor','current-recipient'].includes(filter),'Select the finite changed planning scene only')
  result.sceneFilter=filter??null
  const selected=filter==='wide-no-supervisor'?scenes.filter(scene=>scene.width===1280&&scene.state==='none')
    :filter==='current-recipient'?scenes.filter(scene=>scene.width===620&&scene.theme==='light'&&scene.state==='delivered'):scenes
  for (const {width,theme,state} of selected) {
    await evaluate(`goalsPlan.request(${JSON.stringify(state)});goalsVisual.appearance(${JSON.stringify(theme)})`)
    await size(width)
    await waitFor('Boolean(document.querySelector("[data-goal-plan-request-feedback]"))')
    await evaluate(`document.querySelector('[aria-label="Goal plan"]').scrollIntoView({block:'center'})`)
    await pointer('document.querySelector(".goals-detail__toolbar")')
    const facts=await evaluate(`(()=>{const block=document.querySelector('[data-goal-plan-request-feedback]');return {text:block.textContent,buttons:[...block.querySelectorAll('button')].map(button=>({text:button.textContent,disabled:button.disabled})),hasPatrol:!!document.querySelector('[aria-label="PMO 巡查"]'),nodes:[...document.querySelectorAll('[data-goal-plan-node]')].map(node=>node.dataset.goalPlanState),overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    assert.equal(facts.hasPatrol,false,'Planning requests do not become PMO inspection controls')
    assert.deepEqual(facts.nodes,['goal'],'Prepared or delivered input keeps the single Goal node until the split is saved')
    assert.equal(facts.overflow,false,'Controls stay readable within the actual workface')
    if(state==='none')assert.ok(facts.buttons.some(button=>button.text==='Choose Supervisor to split work'))
    else { assert.ok(facts.text.includes('Mira')&&facts.text.includes('planning')); assert.ok(facts.buttons.some(button=>button.text==='Check request to Mira')) }
    result.observations.push({scene:'planning-request',width,theme,state,facts})
    await capture(`${width}-${theme}-planning-${state}`,width)
  }
  assert.equal(result.frames.length,filter==='current-recipient'?1:filter?2:12,'All selected exact planning-request states were captured')
}
