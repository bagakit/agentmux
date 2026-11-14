const assert = require('node:assert/strict')

/** A bounded first-screen matrix. Only a real saved plan supplies Task/progress facts. */
module.exports = async ({ evaluate, size, pointer, click, capture, waitFor, paint, result, settings = true, layout = true, widePlanOnly = false }) => {
  result.matrix = { scenes: widePlanOnly ? ['saved-plan'] : ['empty', 'saved-plan', 'long-title'], widths: widePlanOnly ? [2048] : [2048, 1280, 620], themes: ['dark', 'light'], settings, layout }
  const query = selector => `document.querySelector(${JSON.stringify(selector)})`
  if (layout) for (const scene of result.matrix.scenes) for (const width of result.matrix.widths) for (const theme of result.matrix.themes) {
    const seeded = await evaluate(`goalsSpace.seed(${JSON.stringify(scene)})`)
    await evaluate(`goalsVisual.appearance(${JSON.stringify(theme)})`)
    await size(width)
    await waitFor(scene === 'saved-plan' ? 'document.querySelectorAll("[data-goal-plan-node]").length===7' : 'document.querySelectorAll("[data-goal-plan-origin]").length===1')
    await evaluate('document.querySelector(".goals-detail").scrollTop=0')
    await pointer('document.querySelector(".goals-detail__toolbar")'); await paint()
    const facts = await evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}},detail=document.querySelector('.goals-detail'),doc=document.querySelector('.goals-document'),body=document.querySelector('.goals-detail__body'),main=document.querySelector('.goals-detail__main'),side=document.querySelector('.goals-detail__side'),graph=document.querySelector('[aria-label="Goal plan"]'),head=document.querySelector('.goals-detail__head'),origin=graph.querySelector('[data-goal-plan-origin]');return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},detail:{...box(detail),clientWidth:detail.clientWidth},document:box(doc),body:box(body),main:box(main),side:box(side),graph:box(graph),head:box(head),origin:origin?{id:origin.dataset.goalPlanOrigin,title:origin.querySelector('.goal-plan-node__title').textContent,...box(origin)}:null,first:main.firstElementChild?.contains(graph),nodes:[...graph.querySelectorAll('[data-goal-plan-node]')].map(e=>({id:e.dataset.goalPlanNode,state:e.dataset.goalPlanState,...box(e)})),edges:graph.querySelectorAll('[data-goal-plan-edge]').length,progress:graph.querySelector('[data-goal-plan-progress]')?.textContent??null,progressBars:graph.querySelectorAll('.goal-plan__progress').length,theme:document.documentElement.dataset.appearance,horizontalOverflow:document.documentElement.scrollWidth>innerWidth||document.body.scrollWidth>innerWidth,title:document.querySelector('[aria-label="Goal title"]').value}})()`)
    await capture(`${width}-${theme}-goal-space-${scene}`, width)
    assert.equal(facts.theme, theme); assert.equal(facts.viewport.width, width)
    assert.equal(facts.first, true, 'The real graph is the first main consumer for every Goal')
    assert.ok(facts.graph.top >= facts.head.bottom && facts.graph.top < facts.viewport.height - 100, 'The actual graph follows the title on the first screen')
    assert.equal(facts.title, seeded.title, 'The complete original title reaches the real title field')
    assert.equal(facts.horizontalOverflow, false, 'The App keeps the real viewport without horizontal page overflow')
    assert.ok(facts.document.width >= facts.detail.clientWidth - 2, 'The document uses the full available detail width')
    if (width === 2048) assert.ok(facts.side.left > facts.main.right && Math.abs(facts.side.top - facts.head.top) < 8, 'Ultra-wide Supervisor begins beside the heading')
    if (width === 620) assert.equal(facts.side.width, 0, 'Narrow Supervisor is available through its navigation before taking space')
    if (scene === 'saved-plan') {
      assert.equal(facts.origin, null); assert.equal(facts.nodes.length, 7); if (width !== 620) assert.ok(facts.edges > 0)
      assert.deepEqual(facts.nodes.map(node=>node.state), ['done','ready','working','review','changes','unknown','waiting'])
      assert.equal(facts.progress, 'Revision 2')
      if (width === 2048) {
        const anchors = await evaluate(`(()=>[...document.querySelectorAll('[data-goal-plan-edge]')].map(path=>{const [from,to]=path.dataset.goalPlanEdge.split('>'),node=id=>[...document.querySelectorAll('[data-goal-plan-node]')].find(e=>e.dataset.goalPlanNode===id),a=node(from),b=node(to),ah=a.querySelector('.goal-plan-node__head').getBoundingClientRect(),bh=b.querySelector('.goal-plan-node__head').getBoundingClientRect(),ar=a.getBoundingClientRect(),br=b.getBoundingClientRect(),matrix=path.getScreenCTM(),start=path.getPointAtLength(0),end=path.getPointAtLength(path.getTotalLength()),point=p=>new DOMPoint(p.x,p.y).matrixTransform(matrix),s=point(start),e=point(end);return{from,to,start:{x:s.x,y:s.y},end:{x:e.x,y:e.y},expectedStart:{x:ar.right,y:ah.top+ah.height/2},expectedEnd:{x:br.left,y:bh.top+bh.height/2},error:Math.max(Math.abs(s.x-ar.right),Math.abs(s.y-ah.top-ah.height/2),Math.abs(e.x-br.left),Math.abs(e.y-bh.top-bh.height/2))}}))()`)
        assert.ok(anchors.length>0 && anchors.every(edge=>edge.error<2), 'Actual SVG endpoints stay attached to the real rendered node heads')
        result.observations.push({scene:'goal-space-edge-anchors',width,theme,anchors})
      }
    } else {
      assert.deepEqual([facts.nodes.length, facts.edges, facts.progress, facts.progressBars], [1,0,null,0], 'The original Goal is the only node, with no invented dependency or progress')
      assert.equal(facts.origin.id, seeded.id); assert.equal(facts.origin.title, seeded.title)
      assert.ok(facts.origin.top >= facts.graph.top && facts.origin.bottom < facts.viewport.height, 'The complete true Goal origin is visible on the first screen')
    }
    const retained = await evaluate('goalsSpace.facts()')
    assert.equal(retained.id, seeded.id); assert.equal(retained.title, seeded.title); assert.equal(retained.description, seeded.description)
    assert.deepEqual(retained.plan, seeded.plan, 'Rendering and resizing do not write a plan')
    result.observations.push({ scene: 'goal-space', variant: scene, width, theme, facts, retained })
  }
  if (settings) {
    for (const [width, theme] of [[1280,'dark'],[620,'light']]) {
      await evaluate('goalsVisual.seedCommon("many")'); await evaluate(`goalsVisual.appearance(${JSON.stringify(theme)})`); await size(width)
      await click(query('[aria-label="Configure common actions"]'))
      await waitFor(`Boolean(${query('[data-settings-field="goals-common-actions"]')})`)
      await evaluate(`${query('[data-settings-field="goals-common-actions"]')}.scrollIntoView({block:"start"})`); await paint()
      const facts = await evaluate(`(()=>{const group=document.querySelector('[data-settings-field="goals-common-actions"]');return {text:group.innerText,refs:[...group.querySelectorAll('[data-common-ref]')].map(e=>e.dataset.commonRef),legacyManager:!!document.querySelector('.goals-common__manager'),overflow:document.documentElement.scrollWidth>innerWidth,theme:document.documentElement.dataset.appearance}})()`)
      assert.equal(facts.legacyManager,false);assert.equal(facts.theme,theme);assert.equal(facts.overflow,false);assert.ok(facts.refs.length>0)
      assert.ok(facts.text.includes('Goals common actions') && facts.text.includes('Add common action') && facts.text.includes('Reference a prompt'))
      result.observations.push({scene:'goal-space-settings',width,theme,facts})
      if (width === 620) {
        await click(query('[data-common-select="prompt:common-review"]'))
        await waitFor(`Boolean(${query('[data-prompt-editor="common-review"] textarea')})`)
        await evaluate(`${query('[data-prompt-editor="common-review"]')}.scrollIntoView({block:"center"})`); await paint()
        const body = await evaluate(`${query('[data-prompt-editor="common-review"] textarea')}.value`)
        assert.equal(body, '帮我检查当前改动，指出具体风险并建议一个最小验证。')
        result.observations.push({scene:'goal-space-settings-original-editor',width,theme,body})
      }
      await capture(`${width}-${theme}-goal-space-settings`,width)
      await click(query('[aria-label="Close settings"]'))
    }
  }
  assert.equal(result.frames.length, (widePlanOnly ? 2 : layout ? 18 : 0) + (settings ? 2 : 0), 'Exactly the changed first-screen matrix and selected Settings views')
}
