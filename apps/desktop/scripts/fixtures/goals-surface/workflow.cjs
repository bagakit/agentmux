const assert = require('node:assert/strict')
module.exports = async ({evaluate,size,click,capture,waitFor,paint,result}) => {
  for (const [mode,width,theme] of [
    ['finite',1280,'dark'],['multiple',620,'light'],['results',1280,'light'],['results',620,'dark'],
    ['gap',620,'light'],['accepted',1280,'dark'],['finished',620,'light'],['done',1280,'light'],['receipt-failure',620,'dark']
  ]) {
    await evaluate(`goalsVisual.seedWorkflow(${JSON.stringify(mode)});goalsVisual.appearance(${JSON.stringify(theme)})`)
    await size(width);await paint();await waitFor('Boolean(document.querySelector(".goals-detail"))')
    if(mode==='receipt-failure') { await click('document.querySelector("[data-goal-confirm]")');await waitFor('Boolean(document.querySelector("[data-goal-acknowledgement-failure]"))') }
    const facts=await evaluate(`({goal:document.querySelector('.goals-title').value,main:[...document.querySelectorAll('.goals-detail .goals-button--primary')].map(node=>node.textContent),criteriaOpen:document.querySelector('.goals-criteria-reading')?.open,result:document.querySelector('[data-goal-result-state]')?.getAttribute('data-goal-result-state'),row:document.querySelector('[data-demand-id="goal:old-done"]')?.textContent,overflow:document.querySelector('.goals-detail').scrollWidth>document.querySelector('.goals-detail').clientWidth})`)
    assert.ok(facts.goal);assert.ok(facts.main.length<=1,'Current stage has at most one primary action');assert.equal(facts.overflow,false)
    if(mode==='done') { assert.ok(facts.row,'Done without acceptance stays in the default list');assert.deepEqual(facts.main,[await evaluate('document.querySelector("[data-goal-grounding]").textContent')],'Done without report prioritizes checking the existing result') }
    if(mode==='results'||mode==='gap') { assert.equal(facts.criteriaOpen,false);assert.ok(facts.main.some(label=>label.includes('finish'))) }
    result.observations.push({scene:mode,width,theme,facts});await capture(`${width}-${theme}-workflow-${mode}`,width)
    if(mode==='multiple') {
      await click('document.querySelectorAll(".goal-finite-start input[type=radio]")[1]');await paint();assert.equal(await evaluate('document.querySelectorAll(".goal-finite-start input[type=radio]")[1].checked'),true);await capture(`${width}-${theme}-workflow-selected-recipient`,width)
    }
    if(mode==='results') {
      await click('document.querySelector(".goals-evidence details summary")');await capture(`${width}-${theme}-workflow-evidence-source`,width)
    }
  }
}
