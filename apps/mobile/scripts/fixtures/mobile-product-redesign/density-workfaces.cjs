const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

module.exports = async ({ read, until, resize, button, capture, result }) => {
  await resize(390, 844)
  await until('mobileProductScene.appearanceReady()')
  await read('mobileProductScene.setAppearance("dark")')
  const fixture = await read('mobileProductScene.facts().densityFixture')
  assert.equal(fixture.goals.length, 12)
  assert.equal(fixture.sessions.length, 12)
  assert.equal(fixture.catalog.regions.length, 12)
  assert.equal(new Set(fixture.catalog.agentPresentation.map(row => row.projectGroup.key)).size, 1)
  for (const session of fixture.sessions) {
    const region = fixture.catalog.regions.find(region => region.agentSessionId === session.agentSessionId)
    assert.equal(region.execution.hostId, session.hostId)
    assert.equal(region.runId, session.run.runId)
  }
  result.densityFixture = { sha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'), data: fixture }
  result.densityWorkfaces = []
  const measure = async (kind, scope, rows, title) => {
    await until(`document.querySelectorAll(${JSON.stringify(rows)}).length===12`)
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const actual = await read(`(()=>{
      const scope=document.querySelector(${JSON.stringify(scope)}), app=document.querySelector('.mobile-app');
      const rect=n=>n.getBoundingClientRect().toJSON();
      const visible=n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
      const clip=n=>{const c={left:0,top:0,right:innerWidth,bottom:innerHeight};for(let p=n.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),r=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowX)){c.left=Math.max(c.left,r.left);c.right=Math.min(c.right,r.right)}if(/auto|scroll|hidden|clip/.test(s.overflowY)){c.top=Math.max(c.top,r.top);c.bottom=Math.min(c.bottom,r.bottom)}}return c};
      const complete=n=>{const r=n.getBoundingClientRect(),c=clip(n);return visible(n)&&r.left>=c.left-.5&&r.top>=c.top-.5&&r.right<=c.right+.5&&r.bottom<=c.bottom+.5};
      const rows=[...document.querySelectorAll(${JSON.stringify(rows)})].map(n=>({name:n.querySelector(${JSON.stringify(title)}).textContent,rect:rect(n),clip:clip(n),fullyVisible:complete(n),text:n.innerText}));
      const controls=[...scope.querySelectorAll('button,input,select,summary')].filter(n=>visible(n)&&complete(n)).map(n=>({name:n.getAttribute('aria-label')||n.textContent.trim(),tag:n.tagName,rect:rect(n)}));
      const inputs=[...scope.querySelectorAll('input:not([type=hidden]),textarea')].filter(visible).map(n=>({name:n.getAttribute('aria-label'),font:getComputedStyle(n).fontSize,rect:rect(n)}));
      const ancestors=[];for(let p=scope.parentElement;p;p=p.parentElement)ancestors.push(p);
      const scroll=[...ancestors,scope,...scope.querySelectorAll('*')].filter(n=>visible(n)&&/auto|scroll/.test(getComputedStyle(n).overflowY)&&n.scrollHeight>n.clientHeight+1).map(n=>({className:n.className,rect:rect(n),scrollTop:n.scrollTop,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight}));
      return {kind:${JSON.stringify(kind)},viewport:{width:innerWidth,height:innerHeight},scope:rect(scope),bodyFont:getComputedStyle(app).fontSize,overflow:app.scrollWidth>app.clientWidth,rows,fullyVisibleRows:rows.filter(row=>row.fullyVisible).length,controls,inputs,scroll};
    })()`)
    const originals = kind === 'Goals' ? fixture.goals.map(goal => ({ id: goal.id, name: goal.title, status: goal.status }))
      : fixture.catalog.agentPresentation.map(row => ({ id: row.agentSessionId, name: row.name, status: row.state }))
    actual.originals = originals
    result.densityWorkfaces.push(actual)
    assert.deepEqual(actual.rows.map(row => row.name).sort(), originals.map(row => row.name).sort(), 'Actual product rows retain all original directory names')
    assert.equal(actual.overflow, false)
    assert.equal(actual.bodyFont, '14px')
    assert.ok(actual.inputs.length > 0)
    for (const input of actual.inputs) assert.equal(input.font, '16px', 'Original editable text stays at 16px')
    assert.ok(actual.controls.length > 0)
    for (const control of actual.controls) assert.ok(control.rect.width >= 43.5 && control.rect.height >= 43.5, `Actual visible touch target remains 44px: ${control.name}`)
    assert.ok(actual.fullyVisibleRows > 0 && actual.fullyVisibleRows <= actual.rows.length, 'The first screen shows a nonempty portion of the actual directory')
    assert.ok(actual.scroll.length > 0 || actual.fullyVisibleRows === actual.rows.length, 'Clipped records remain scrollable unless the entire directory fits')
    if (actual.scroll.length) assert.equal(actual.scroll[0].scrollTop, 0, 'First-screen density is measured at the original scroll origin')
  }
  await button('Goals', '.mobile-navigation')
  await measure('Goals', '.mobile-goals-host:not([hidden])', '.mobile-goals-host:not([hidden]) .mobile-goals-list > li', '.mobile-goal-row-copy > strong')
  await capture('density-goals-390-dark')
  await button('Focus', '.mobile-navigation')
  await measure('Focus', '.mobile-focus-facet', '.mobile-focus-facet .mobile-focus-project .mobile-session-list > li', '.mobile-row-title strong')
  await capture('density-focus-390-dark')
  const calls = await read('mobileProductScene.facts().calls')
  const forbidden = new Set(['agent.open', 'agent.input.submit', 'agent.input.respond', 'agent.input.resume', 'space.mote.dialogue.input.submit',
    'sdk.ensureAgentContinuity', 'sdk.submitAgentPrompt', 'sdk.respondAgentInteraction', 'sdk.writeAgent', 'sdk.resizeAgent', 'sdk.signalAgent',
    'goal.create', 'goal.update', 'goal.delete', 'goal.discuss', 'goal.start', 'topic.create', 'topic.knowledge.write'])
  const business = calls.filter(call => forbidden.has(call.method))
  assert.deepEqual(business, [], 'Directory comparison never dispatches or mutates original business objects')
  assert.ok(calls.some(call => call.method === 'goal.ls'))
  assert.ok(calls.some(call => call.method === 'space.ls'))
  result.densityCalls = { all: calls, business, readMethods: [...new Set(calls.map(call => call.method))] }
  result.densityBoundary = 'One private Chromium process, fixed 390×844 viewport and identical seeded public SDK/Goal/Space facts. Complete visible rows are intersected with their real clipping ancestors; counts are observed, not fixed success thresholds. No live App, Browser, Session or physical phone claim.'
}
