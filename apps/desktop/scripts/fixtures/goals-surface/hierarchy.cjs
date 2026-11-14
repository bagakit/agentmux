const assert = require('node:assert/strict')

/** New IA evidence, kept separate from the historical goal-space matrix. */
module.exports = async ({ evaluate, size, pointer, click, capture, waitFor, paint, result, scope, insert }) => {
  const key = scope === 'goal-hierarchy-key-only'
  const refresh = scope === 'goal-hierarchy-refresh-only'
  const ctaOnly = scope === 'goal-hierarchy-cta-only'
  const settingsOnly = scope === 'goal-hierarchy-settings-only' || scope === 'goal-hierarchy-settings-wide-only'
  const settingsMatrix = scope === 'goal-hierarchy-settings-wide-only' ? [[1280, 'dark']] : [[1280, 'dark'], [620, 'light']]
  const goalsOnly = scope === 'goal-hierarchy-goals-only' || refresh || ctaOnly
  const matrix = ctaOnly ? [['empty',1280,'light'],['empty',620,'dark'],['empty',620,'light']] : refresh ? [[2048,'dark'],[2048,'light'],[1280,'light'],[620,'dark'],[620,'light']].map(([width,theme])=>['empty',width,theme]).concat([['team-unknown',2048,'light']]) : key ? [['empty', 2048, 'dark'], ['saved-plan', 1280, 'light'], ['long-pending', 620, 'light']] :
    ['empty', 'saved-plan'].flatMap(scene => [[2048, 'dark'], [2048, 'light'], [1280, scene === 'empty' ? 'light' : 'dark'], [620, 'dark'], [620, 'light']].map(([width, theme]) => [scene, width, theme]))
      .concat([['long-pending', 1280, 'dark'], ['long-pending', 620, 'light'], ['team-unknown', 2048, 'light'], ['team-unknown', 620, 'dark'], ['pending-draft', 1280, 'light'], ['pending-draft', 620, 'dark']])
  result.matrix = { key, scenes: settingsOnly ? [] : matrix, settings: !key && !goalsOnly }
  const query = selector => `document.querySelector(${JSON.stringify(selector)})`
  async function anchors(phase) {
    const facts = await evaluate(`(()=>{const canvas=document.querySelector('.goal-plan__canvas');return {scrollTop:canvas.scrollTop,scrollLeft:canvas.scrollLeft,visible:getComputedStyle(document.querySelector('.goal-plan__edges')).display!=='none',edges:[...document.querySelectorAll('[data-goal-plan-edge]')].map(path=>{const [from,to]=path.dataset.goalPlanEdge.split('>'),node=id=>[...document.querySelectorAll('[data-goal-plan-node]')].find(e=>e.dataset.goalPlanNode===id),a=node(from),b=node(to),ah=a.querySelector('.goal-plan-node__head').getBoundingClientRect(),bh=b.querySelector('.goal-plan-node__head').getBoundingClientRect(),ar=a.getBoundingClientRect(),br=b.getBoundingClientRect(),matrix=path.getScreenCTM(),point=p=>new DOMPoint(p.x,p.y).matrixTransform(matrix),s=point(path.getPointAtLength(0)),e=point(path.getPointAtLength(path.getTotalLength()));return{from,to,error:Math.max(Math.abs(s.x-ar.right),Math.abs(s.y-ah.top-ah.height/2),Math.abs(e.x-br.left),Math.abs(e.y-bh.top-bh.height/2))}})}})()`)
    if (facts.visible) assert.ok(facts.edges.length > 0 && facts.edges.every(edge => edge.error < 2), `Actual edge anchors after ${phase}`)
    result.observations.push({ scene: 'hierarchy-edges', phase, ...facts })
    return facts
  }
  for (const [scene, width, theme] of settingsOnly ? [] : matrix) {
    const seeded = await evaluate(`goalsHierarchy.seed(${JSON.stringify(scene)})`)
    await evaluate(`goalsVisual.appearance(${JSON.stringify(theme)})`); await size(width)
    await waitFor(scene === 'saved-plan' ? 'document.querySelectorAll("[data-goal-plan-node]").length===7' : 'document.querySelectorAll("[data-goal-plan-origin]").length===1')
    await evaluate('document.querySelector(".goals-detail").scrollTop=0'); await pointer(query('.goals-detail__toolbar')); await paint()
    const facts = await evaluate(`(()=>{const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}},detail=document.querySelector('.goals-detail'),head=document.querySelector('.goals-detail__head'),main=document.querySelector('.goals-detail__main'),graph=document.querySelector('[aria-label="Goal plan"]'),team=document.querySelector('.goal-team'),properties=document.querySelector('[aria-label="Goal properties"]'),canvas=graph.querySelector('.goal-plan__canvas');return {width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.appearance,title:document.querySelector('[aria-label="Goal title"]').value,stage:document.querySelector('[data-goal-detail-stage]').innerText,head:box(head),graph:box(graph),origin:box(graph.querySelector('[data-goal-plan-origin]')),first:main.firstElementChild===graph,team:box(team),properties:box(properties),teamLink:box(document.querySelector('.goals-detail__team-link')),teamActors:[...team.querySelectorAll('[data-goal-team-actor]')].map(e=>({key:e.dataset.goalTeamActor,roles:[...e.querySelectorAll('[data-goal-team-role]')].map(r=>r.dataset.goalTeamRole),shared:!!e.querySelector('.focus-context.focus-context--card'),...box(e)})),unknown:[...team.querySelectorAll('[data-goal-team-unconfirmed]')].map(e=>({id:e.dataset.goalTeamUnconfirmed,text:e.innerText,interactiveAgentCard:!!e.querySelector('.focus-context')})),sections:[...main.children].map(e=>({tag:e.tagName,aria:e.getAttribute('aria-label'),heading:e.querySelector('h2,h3')?.textContent??null,...box(e)})),criteria:[...main.querySelectorAll('[data-goal-success-criterion]')].map(e=>({id:e.dataset.goalSuccessCriterion,text:e.textContent,...box(e)})),confirmation:main.querySelector('[data-goal-confirmation-state]')?.dataset.goalConfirmationState??null,canvas:canvas?{...box(canvas),clientHeight:canvas.clientHeight,scrollHeight:canvas.scrollHeight,clientWidth:canvas.clientWidth,scrollWidth:canvas.scrollWidth,tabIndex:canvas.tabIndex,scrollHint:graph.querySelector('.goal-plan__scroll-hint')?.textContent??null}:null,overflow:document.documentElement.scrollWidth>innerWidth||document.body.scrollWidth>innerWidth}})()`)
    if (scene === 'team-unknown' && width === 620) {
      await click(query('.goals-detail__team-link')); await paint()
      const view = await evaluate(`(()=>{const team=document.querySelector('.goal-team'),r=team.getBoundingClientRect();return {top:r.top,bottom:r.bottom,text:team.innerText,focused:document.activeElement?.getAttribute('aria-label'),actors:[...team.querySelectorAll('[data-goal-team-actor]')].map(e=>({key:e.dataset.goalTeamActor,top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})),unknown:[...team.querySelectorAll('[data-goal-team-unconfirmed]')].map(e=>({id:e.dataset.goalTeamUnconfirmed,top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom}))}})()`)
      assert.ok(view.top >= 36 && view.top < 200, 'The real header Team action reveals its original Team region')
      result.observations.push({scene:'hierarchy-team-location',width,theme,view})
    }
    if (ctaOnly) {
      const cta = await evaluate(`(()=>{const button=document.querySelector('[data-goal-grill]'),detail=document.querySelector('.goals-detail'),toolbar=document.querySelector('.goals-detail__toolbar'),footer=document.querySelector('.window-status-bar'),r=button.getBoundingClientRect(),d=detail.getBoundingClientRect(),t=toolbar.getBoundingClientRect(),f=footer.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {button:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,text:button.textContent},readingArea:{top:Math.max(d.top,t.bottom),bottom:Math.min(d.bottom,f.top),left:d.left,right:d.right},hitOriginal:hit===button||button.contains(hit),disabled:button.disabled,detailScrollTop:detail.scrollTop}})()`)
      assert.equal(cta.detailScrollTop,0,'The next action is reached from the original first screen')
      assert.ok(cta.button.top>=cta.readingArea.top && cta.button.bottom<=cta.readingArea.bottom && cta.button.left>=cta.readingArea.left && cta.button.right<=cta.readingArea.right,'The complete original primary next-step button fits its actual usable viewport, above the real footer')
      assert.equal(cta.hitOriginal,true); assert.equal(cta.disabled,false)
      result.observations.push({scene:'hierarchy-primary-cta',width,theme,cta})
    } else await capture(`${width}-${theme}-hierarchy-${scene}`, width)
    assert.equal(facts.width, width); assert.equal(facts.theme, theme); assert.equal(facts.overflow, false)
    assert.equal(facts.first, true); assert.ok(facts.graph.y >= facts.head.bottom - 1 && facts.graph.y < facts.height - 100)
    assert.ok(facts.team.y < facts.properties.y, 'Team is above lower-emphasis Properties')
    assert.ok(facts.teamLink && facts.teamLink.y < facts.height, 'Narrow Team remains discoverable from the Goal header')
    if (scene === 'long-pending' || scene === 'pending-draft') { assert.equal(facts.confirmation, 'unconfirmed'); assert.equal(facts.criteria.length, 2) }
    if (scene === 'team-unknown') {
      assert.equal(facts.teamActors.length, 1); assert.equal(facts.teamActors[0].shared, true)
      assert.deepEqual(facts.teamActors[0].roles, ['supervisor', 'assignees', 'related'])
      assert.equal(facts.unknown.length, 1); assert.equal(facts.unknown[0].id, 'ambiguous-team'); assert.equal(facts.unknown[0].interactiveAgentCard, false)
    }
    result.observations.push({ scene: 'hierarchy-layout', variant: scene, width, theme, seeded, facts, retained: await evaluate('goalsHierarchy.facts()') })
    if (scene === 'saved-plan' && width === 1280) {
      assert.equal(facts.canvas.tabIndex, 0); assert.ok(facts.canvas.scrollHeight > facts.canvas.clientHeight, 'Saved plan really scrolls vertically')
      assert.equal(facts.canvas.scrollHint, 'Scroll to explore the full plan', 'Actual overflowing canvas exposes its reading affordance')
      await evaluate('document.querySelector(".goal-plan__canvas").scrollTop=65'); await paint()
      assert.ok((await anchors('vertical-scroll')).scrollTop > 0)
      await click(query('[data-goal-plan-node="history"] .goal-plan-node__head'))
      await waitFor('Boolean(document.querySelector("[data-goal-plan-detail=history]"))')
      await evaluate('document.querySelector(".goal-plan__canvas").scrollTop=45'); await paint()
      await anchors('open-detail-after-scroll')
      await click(`([...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Back to node'))`)
      await waitFor('!document.querySelector("[data-goal-plan-detail=history]")')
      await evaluate('document.querySelector(".goal-plan__canvas").scrollTop=55'); await paint()
      await anchors('close-detail-after-scroll')
    }
  }
  // Settings author owns its current route and save proof. These final two frames
  // are enabled by the full/settings-only scope once that route is stable.
  if (!key && !goalsOnly) {
    for (const [width, theme] of settingsMatrix) {
      await evaluate('goalsVisual.seedCommon("many")'); await evaluate(`goalsVisual.appearance(${JSON.stringify(theme)})`); await size(width)
      await click(query('[aria-label="Configure common actions"]'))
      await waitFor(`Boolean(${query('[data-settings-field="goals-common-actions"]')})`)
      await evaluate(`${query('[data-settings-field="goals-common-actions"]')}.scrollIntoView({block:'start'})`); await paint()
      const directory = await evaluate(`({pane:document.querySelector('[data-settings-pane]:not([hidden])')?.dataset.settingsPane,refs:[...document.querySelectorAll('[data-common-ref]')].map(e=>e.dataset.commonRef)})`)
      assert.equal(directory.pane, 'goals', 'The actual Configure navigation lands in Goals settings')
      await click(query('[data-common-select="prompt:common-review"]'))
      await waitFor(`Boolean(${query('[data-prompt-editor="common-review"] textarea')})`)
      assert.equal(await evaluate(`${query('[data-prompt-editor="common-review"] textarea')}.value`), '帮我检查当前改动，指出具体风险并建议一个最小验证。')
      await insert('[data-prompt-editor="common-review"] textarea', '\n保留同一条未保存正文，再返回 Goals 配置。')
      const edited = await evaluate(`${query('[data-prompt-editor="common-review"] textarea')}.value`)
      await click(`([...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Goals common actions'))`)
      await waitFor(`document.querySelector('[data-settings-pane]:not([hidden])')?.dataset.settingsPane==='goals'`)
      assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-common-ref]")].map(e=>e.dataset.commonRef)'), directory.refs)
      if (width === 620) {
        await click(query('[data-common-select="prompt:common-review"]'))
        await waitFor(`Boolean(${query('[data-prompt-editor="common-review"] textarea')})`)
        assert.equal(await evaluate(`${query('[data-prompt-editor="common-review"] textarea')}.value`), edited, 'Cross-page navigation retains the same original draft')
      }
      result.observations.push({scene:'hierarchy-settings-shared-draft',width,theme,directory,edited})
      await capture(`${width}-${theme}-hierarchy-settings`, width)
      result.observations.push({ scene: 'hierarchy-settings', width, theme, facts: await evaluate('({headings:[...document.querySelectorAll("h1,h2,h3")].map(e=>e.textContent),active:document.querySelector("[data-settings-pane]:not([hidden])")?.dataset.settingsPane,text:document.body.innerText})') })
      await click(query('[aria-label="Close settings"]'))
    }
  }
  if(ctaOnly) assert.equal(result.observations.filter(item=>item.scene==='hierarchy-primary-cta').length,3,'The real CTA consumer oracle is nonempty')
  assert.equal(result.frames.length, ctaOnly ? 0 : settingsOnly ? settingsMatrix.length : refresh ? 6 : key ? 3 : goalsOnly ? 16 : 18)
}
