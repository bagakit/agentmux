const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const [html, privateRoot, evidence, manifestFile, scope = 'real-a'] = process.argv.slice(2)
const { fixtureTime, fixturePath } = require('../../lib/fixture-values.mjs')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const result = { schema: 'agentmux.goal-real-work-render.v1', passed: false, captureOnly: true,
  aestheticReview: 'not-performed', userRunTouched: false, frames: [], observations: [], consoleErrors: [] }
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
let win
const evaluate = code => win.webContents.executeJavaScript(code)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(code) {
  for (let count = 0; count < 200; count++) { if (await evaluate(code)) return; await delay(30) }
  throw new Error(`Private real-work Renderer did not reach: ${code}`)
}
async function paint() {
  await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
  await delay(80)
}

async function input() {
  assert.ok(manifestFile, 'Real A requires an explicit source manifest, never a process-directory default')
  const bytes = await fs.readFile(manifestFile), manifest = JSON.parse(bytes)
  assert.equal(manifest.schema, 'agentmux.goal-real-work-source.v1')
  const loaded = {}, hashes = {}
  for (const name of ['inventory', 'goal-inspect', 'goal-delegations', 'goal-plan', 'executor-record', 'creator-record', 'core-history-sources']) {
    const ref = manifest.inputs[name]
    assert.ok(ref && ref.path && ref.sha256, `Nonempty original input: ${name}`)
    const raw = await fs.readFile(path.resolve(path.dirname(manifestFile), ref.path))
    assert.ok(raw.length > 0, `Original source ${name} is not empty`)
    assert.equal(sha(raw), ref.sha256, `Original bytes remain intact: ${name}`)
    loaded[name] = JSON.parse(raw); hashes[name] = sha(raw)
    if (name !== 'core-history-sources') assert.equal(loaded[name].ok, true)
  }
  const goal = loaded['goal-inspect'].result.goal
  assert.equal(goal.id, manifest.goalId)
  assert.equal(goal.updatedAt, manifest.goalUpdatedAt)
  for (const name of ['goal-delegations', 'goal-plan']) {
    assert.equal(loaded[name].result.goalId, goal.id)
    assert.equal(loaded[name].result.goalUpdatedAt, goal.updatedAt)
  }
  const original = loaded.inventory.result.goals.filter(item => item.id === goal.id)
  assert.equal(original.length, 1)
  assert.equal(original[0].updatedAt, goal.updatedAt)
  assert.equal(original[0].title, goal.title)
  const historySources = loaded['core-history-sources'].observations.flatMap(observation => {
    assert.ok(observation.sources && !observation.error, 'Use original metadata or preserve its observed failure; never fabricate a descriptor')
    for (const descriptor of observation.sources) {
      assert.equal(descriptor.hostId, observation.hostId)
      assert.equal(descriptor.agentSessionId, observation.agentSessionId)
    }
    return observation.sources
  })
  result.source = { manifestPath: manifestFile, manifestSHA256: sha(bytes), inputs: hashes }
  result.sourceBoundary = manifest.replayBoundary
  result.originalScreenshot = manifest.originalScreenshot
  assert.ok(Array.isArray(loaded['goal-inspect'].result.goalContinuations), 'Use the complete original read, including its continuation observation')
  return { goal, goalContinuations: loaded['goal-inspect'].result.goalContinuations, inventory: loaded.inventory.result.goals, delegations: loaded['goal-delegations'].result,
    plan: loaded['goal-plan'].result, historySources, source: result.source }
}

async function click(expression) {
  const point = await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing actual product target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await paint()
}
const query = selector => `document.querySelector(${JSON.stringify(selector)})`
const button = name => `([...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(name)}||e.getAttribute('aria-label')===${JSON.stringify(name)}))`
async function capture(name, width, height, theme) {
  await paint()
  const png = Buffer.from((await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })).data, 'base64')
  const file = `${width}-${theme}-${name}.png`
  await fs.writeFile(path.join(evidence, file), png)
  result.frames.push({ name, width, height, theme, file, sha256: sha(png), bytes: png.length, source: 'explicit-synthetic-preview' })
}
async function captureMatrix() {
  result.mode = 'supplementary-synthetic-matrix'
  result.boundary = 'Supplementary explicit synthetic Goal DTOs through the actual App. No real-A claim, native input or original user data mutation.'
  const cases = [
    ['fresh', 2048, 'dark'], ['fresh', 620, 'light'],
    ['saved-plan', 2048, 'light'], ['saved-plan', 1280, 'dark'], ['saved-plan', 620, 'light'],
    ['pending', 1280, 'light'], ['pending', 620, 'light'], ['current-result', 2048, 'dark'], ['current-result', 620, 'light'],
    ['stale', 1280, 'dark'], ['gap', 620, 'dark'], ['ack', 1280, 'light'],
    ['history', 1280, 'light'], ['multi-host', 620, 'dark'], ['follow-up', 1280, 'light'], ['dirty-navigation', 1280, 'dark'],
    ['existing-loop', 2048, 'light'], ['existing-loop', 620, 'dark']
  ]
  const selected = scope.startsWith('matrix:') ? cases.filter(([scene]) => scope.slice(7).split(',').includes(scene)) : cases
  assert.ok(selected.length>0,'Explicit matrix subset is nonempty')
  result.matrix = selected
  for (const [scene, width, theme] of selected) {
    await evaluate('goalsWorkScenes.observe()')
    if (scene === 'saved-plan' || scene === 'follow-up') await evaluate('goalsHierarchy.seed("saved-plan")')
    else if (scene === 'pending') await evaluate('goalsHierarchy.seed("long-pending")')
    else if (scene === 'multi-host') {
      await evaluate('goalsHierarchy.seed("team-unknown")')
      await evaluate(`goalsWorkScenes.patch({creationOrigin:{operationId:'qualified-origin',requesterAsSupervisor:true,requesterParticipationId:'qualified-requester',supervisorDefaultPending:false},participations:[{id:'qualified-requester',operationId:'qualified-origin',kind:'create',agentSessionId:'team-atlas',hostId:'team-main-host',entryPoint:'goal.create',recordedAt:${fixtureTime(100)}}]})`)
    }
    else if (['current-result', 'stale', 'gap', 'ack'].includes(scene))
      await evaluate(`goalsVisual.seed(${JSON.stringify(scene === 'current-result' ? 'results' : scene === 'ack' ? 'proposal' : scene)})`)
    else await evaluate('goalsHierarchy.seed("empty")')
    if (scene === 'follow-up') {
      await evaluate(`(()=>{const state=goalsWorkScenes.facts(),candidate=state.sessions.find(s=>s.kind==='agent'&&s.control.agentSessionId!==state.goal.supervisorSessionId);if(!candidate)throw Error('One actual foreign live namesake is required');goalsWorkScenes.patch({supervisorSessionId:candidate.control.agentSessionId})})()`)
    }
    if (scene === 'history') {
      await evaluate(`goalsWorkScenes.metadata([{hostId:'history-owner',agentSessionId:'retained-reference',state:'retired',retiredAt:${fixtureTime(1000)},history:{providerId:'codex',executorId:'codex',workspacePath:${JSON.stringify(fixturePath('preview/history'))},createdAt:${fixtureTime(0)},nativeHandle:{kind:'provider',providerId:'codex',sessionId:'retained-native'}}}]);goalsWorkScenes.patch({sessionIds:['retained-reference'],participations:[{id:'source-reference',operationId:'source-operation',kind:'requirements',agentSessionId:'retained-reference',hostId:'history-owner',recordedAt:${fixtureTime(500)},entryPoint:'goal.update'}]})`)
    }
    if (scene === 'existing-loop') {
      const agent = await evaluate('goalsWorkScenes.facts().sessions.find(s=>s.kind==="agent")')
      const loop = { loopId: 'retained-loop', creationOperationId: 'retained-loop-start', revision: 2,
        hostId: agent.control.hostId, agentSessionId: agent.control.agentSessionId, providerId: agent.providerId,
        workspacePath: agent.workspacePath, intervalMs: 60000, nextCheckAt: fixtureTime(4000), status: 'active', prompt: 'Original private continuation body',
        taskSource: { kind: 'goal', goalId: 'goal:visual-0', alignmentRevision: 1 },
        initialDelivery: { state: 'unconfirmed', operationId: 'retained-loop-start', startedAt: fixtureTime(1000), prompt: 'Original private first input', condition: { expectedRun: { runId: agent.control.run.runId }, afterSubmissionId: null } } }
      await evaluate(`goalsWorkScenes.observe(${JSON.stringify([loop])});goalsVisual.seedWorkflow('finite')`)
    }
    await evaluate(`goalsVisual.appearance(${JSON.stringify(theme)})`)
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    await paint()
    if (scene === 'ack') {
      await click('document.querySelector("[data-goal-confirm]")')
      await waitFor('document.querySelector("[data-goal-detail-stage]")?.textContent.includes("Acknowledgement unconfirmed")')
    }
    if (scene === 'dirty-navigation') {
      const draft = 'Unsent bilingual title / 保留同一条原始草稿'
      await click(query('[aria-label="Goal title"]'))
      await evaluate(query('[aria-label="Goal title"]') + '.select()')
      await win.webContents.debugger.sendCommand('Input.insertText', { text: draft })
      await click(button('Back to goals'))
      await click(query('[data-demand-id="goal:visual-0"]'))
      assert.equal(await evaluate(query('[aria-label="Goal title"]') + '.value'), draft)
      assert.equal(await evaluate('Boolean(document.querySelector(".goals-collection--list"))'), true)
    }
    if (['history', 'multi-host', 'existing-loop'].includes(scene)) {
      await click('document.querySelector(".goals-detail__team-link")')
      if (scene === 'existing-loop') await waitFor('Boolean(document.querySelector(".goals-continuation__saved"))')
    }
    if (scene === 'saved-plan' && width === 1280) {
      await evaluate('document.querySelector(".goal-plan__canvas").scrollTop=65'); await paint()
      await graphAnchors('scrolled')
      await click('document.querySelector("[data-goal-plan-node=history] .goal-plan-node__head")')
      await waitFor('Boolean(document.querySelector("[data-goal-plan-detail=history]"))')
      await evaluate('document.querySelector(".goal-plan__canvas").scrollTop=45'); await paint(); await graphAnchors('detail-open')
      await click(button('Back to node')); await evaluate('document.querySelector(".goal-plan__canvas").scrollTop=55'); await paint(); await graphAnchors('detail-closed')
    }
    if (scene === 'follow-up') {
      await waitFor("Boolean(document.querySelector('.goal-delegation__identity'))")
      await evaluate("document.querySelector('.goal-delegation__identity').scrollIntoView({block:'center'})");await paint()
      const followUp=await evaluate("[...document.querySelectorAll('.goal-delegation__identity')].map(e=>e.textContent)");assert.ok(followUp.length>0);assert.ok(followUp.every(text=>text.includes('Follow-up Supervisor reference · Host unconfirmed')),'A bare Supervisor never borrows the single foreign live namesake')
      result.observations.push({scene:'follow-up-host-caption',followUp})
    }
    const facts = await evaluate(`(()=>{const state=goalsWorkScenes.facts(),detail=document.querySelector('.goals-detail');return {state,text:detail.innerText,theme:document.documentElement.dataset.appearance,overflow:document.documentElement.scrollWidth>innerWidth||document.body.scrollWidth>innerWidth,primary:[...detail.querySelectorAll('button.primary-button')].map(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{text:e.textContent,disabled:e.disabled,top:r.top,bottom:r.bottom,left:r.left,right:r.right,painted:e.getClientRects().length>0,hit:hit===e||Boolean(hit&&e.contains(hit))}}),footerTop:document.querySelector('.window-status-bar').getBoundingClientRect().top,toolbarBottom:document.querySelector('.goals-detail__toolbar').getBoundingClientRect().bottom,origin:[...detail.querySelectorAll('[data-goal-plan-origin]')].map(e=>e.dataset.goalPlanOrigin),nodes:[...detail.querySelectorAll('[data-goal-plan-node]')].map(e=>e.dataset.goalPlanNode),actors:detail.querySelectorAll('[data-goal-team-actor]').length,references:detail.querySelectorAll('[data-goal-team-reference]').length}})()`)
    await capture(scene, width, 900, theme)
    assert.equal(facts.theme, theme); assert.equal(facts.overflow, false)
    assert.ok(facts.state.selected, 'The actual Goal selection is nonempty')
    if (scene === 'fresh') { assert.equal(facts.nodes.length, 0); assert.deepEqual(facts.origin, [facts.state.goal.id]) }
    if (['fresh','pending','ack'].includes(scene)) {const primary=facts.primary.filter(e=>e.painted&&!e.disabled);assert.equal(primary.length,1,'One original current primary action');assert.ok(primary[0].top>=facts.toolbarBottom&&primary[0].bottom<=facts.footerTop&&primary[0].hit,'The complete original current action is inside the usable viewport and receives pointer hits')}
    if (scene === 'saved-plan') assert.equal(facts.nodes.length, 7)
    if (scene === 'multi-host') assert.equal(facts.actors,1,'The exact recorded Supervisor uses the real shared live card while the bare multiHost reference stays unconfirmed')
    if (scene === 'existing-loop') assert.ok(facts.text.includes('Inspect and retry original start'))
    result.observations.push({ scene, width, theme, facts })
  }
  assert.equal(result.frames.length, selected.length)
}
async function graphAnchors(phase) {
  const facts = await evaluate(`(()=>{const canvas=document.querySelector('.goal-plan__canvas');return {scrollTop:canvas.scrollTop,edges:[...document.querySelectorAll('[data-goal-plan-edge]')].map(path=>{const [from,to]=path.dataset.goalPlanEdge.split('>'),node=id=>[...document.querySelectorAll('[data-goal-plan-node]')].find(e=>e.dataset.goalPlanNode===id),a=node(from),b=node(to),ah=a.querySelector('.goal-plan-node__head').getBoundingClientRect(),bh=b.querySelector('.goal-plan-node__head').getBoundingClientRect(),ar=a.getBoundingClientRect(),br=b.getBoundingClientRect(),matrix=path.getScreenCTM(),point=p=>new DOMPoint(p.x,p.y).matrixTransform(matrix),s=point(path.getPointAtLength(0)),e=point(path.getPointAtLength(path.getTotalLength()));return {from,to,error:Math.max(Math.abs(s.x-ar.right),Math.abs(s.y-(ah.top+ah.height/2)),Math.abs(e.x-br.left),Math.abs(e.y-(bh.top+bh.height/2)))}})}})()`)
  assert.ok(facts.scrollTop > 0, 'Actual nonzero canvas scroll, not the initial frame')
  assert.ok(facts.edges.length > 0); for (const edge of facts.edges) assert.ok(edge.error < 2, 'Rendered dependency endpoints follow their actual original node heads')
  result.observations.push({ scene: 'saved-plan-edge-anchors', phase, facts })
}

app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    const captured = scope.startsWith('matrix') ? null : await input()
    const preload = captured ? path.join(privateRoot, 'real-work-preload.cjs') : undefined
    if (preload) await fs.writeFile(preload, `const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('goalsRealWorkInput',${JSON.stringify(captured)});`)
    win = new BrowserWindow({ show: false, width: 1280, height: 900,
      webPreferences: { preload, sandbox: false, backgroundThrottling: false } })
    win.webContents.on('console-message', details => { if (details.level === 'error') result.consoleErrors.push({ message: details.message, line: details.lineNumber, source: details.sourceId }) })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    if (scope.startsWith('matrix')) { await waitFor('Boolean(window.goalsWorkScenes && window.goalsHierarchy)'); await captureMatrix(); result.passed = true; return }
    await waitFor('Boolean(window.goalsRealWork) && Boolean(document.querySelector("[data-goal-work-area]"))')
    await waitFor('Boolean(goalsRealWork.facts().goal?.startObservations?.length)')
    const matrix = scope === 'real-a-team' ? [[620,900,'light']] : [[2048, 1188, 'dark'], [1280, 900, 'light'], [620, 900, 'light']]
    result.matrix = matrix
    for (const [width, height, theme] of matrix) {
      await evaluate(`goalsRealWork.appearance(${JSON.stringify(theme)})`)
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await paint()
      const facts = await evaluate('goalsRealWork.facts()')
      assert.equal(facts.selected, captured.goal.id)
      for (const key of ['id', 'title', 'description', 'status', 'updatedAt', 'dispatches', 'patrols', 'sessionIds', 'participations'])
        assert.deepEqual(facts.goal[key], captured.goal[key], `The real consumer preserves original ${key}`)
      assert.deepEqual(facts.sessions, [], 'Retired history is never synthesized as an active Session')
      assert.deepEqual(facts.writes, [], 'Capture invokes no mutating owner')
      if(scope==='real-a-team'){await click(query('.goals-detail__team-link'));await paint()}
      const dom = await evaluate(`(()=>{const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}},detail=document.querySelector('.goals-detail');return {width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.appearance,toolbar:box(document.querySelector('.goals-detail__toolbar')),windowHeader:box(document.querySelector('.topbar')),scrollAncestors:(()=>{const rows=[];for(let e=detail;e;e=e.parentElement)rows.push({tag:e.tagName,className:e.className,scrollTop:e.scrollTop,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight});return rows})(),detail:box(detail),work:box(document.querySelector('[data-goal-work-area]')),origin:[...document.querySelectorAll('[data-goal-plan-origin]')].map(e=>({id:e.dataset.goalPlanOrigin,...box(e)})),tasks:document.querySelectorAll('[data-goal-plan-node]').length,stage:document.querySelector('[data-goal-detail-stage]')?.innerText,text:detail.innerText,team:box(document.querySelector('.goal-team')),navigation:box(document.querySelector('.goals-collection')),overflow:document.documentElement.scrollWidth>innerWidth||document.body.scrollWidth>innerWidth}})()`)
      const name = `${width}-${theme}-${scope==='real-a-team'?'real-a-team':'real-a'}`, file = name + '.png'
      const png = Buffer.from((await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })).data, 'base64')
      await fs.writeFile(path.join(evidence, file), png)
      result.frames.push({ name, width, height, theme, file, sha256: sha(png), bytes: png.length, source: 'original-public-read-snapshot' })
      result.observations.push({ scene: 'real-a', width, height, theme, facts, dom })
      assert.equal(dom.theme, theme)
      if(scope==='real-a-team'){assert.ok(dom.toolbar.top>=dom.windowHeader.bottom,'Team navigation keeps the complete original toolbar below global chrome');assert.ok(dom.team.top>=dom.toolbar.bottom,'The Team destination starts below its original toolbar');assert.equal(dom.scrollAncestors.find(e=>e.className==='workspace-main-surface').scrollTop,0,'The outer work surface is not scrolled by a Goal-local jump')}
      assert.equal(dom.overflow, false, 'The full App has no horizontal overflow')
      assert.deepEqual(dom.origin.map(item => item.id), [captured.goal.id], 'The no-plan real Goal still has its one genuine origin')
      assert.equal(dom.tasks, 0, 'No fake Task is added to the original no-plan Goal')
    }
    assert.equal(result.frames.length, scope==='real-a-team'?1:3)
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
