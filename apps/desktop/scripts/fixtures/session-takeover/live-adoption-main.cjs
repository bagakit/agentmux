const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const picker = `document.querySelector('.session-takeover:not([hidden])')`

exports.runLiveAdoption = async ({ result, evaluate, wait, click, open, frame, spatial, evidence, mode }) => {
  const baselinePath = path.join(evidence, 'live-restart-baseline.json')
  if (mode === 'first') {
    const original = await evaluate('takeoverProbe.facts()')
    await frame('live-original')
    await open(0)
    await frame('live-choice')
    await click(`${picker}.querySelector('.agent-pick[data-executor-id="gemini"]')`)
    await wait(`!${picker}`)
    await wait(`Object.values(takeoverProbe.facts().operations).some(operation=>operation.kind==='takeover'&&operation.phase==='succeeded')`)
    const first = await evaluate('takeoverProbe.facts()')
    assert.equal(first.launches.length, 1, 'One explicit creation reached the controlled Native boundary')
    const requestId = first.launches[0].createOperationId
    const initial = first.requests[requestId]
    assert.ok(initial && first.tabs[initial.tabId], 'The first operation has a real workface')
    const lost = await evaluate(`takeoverProbe.forgetPlacement(${JSON.stringify(requestId)})`)
    assert.ok(!lost.tabs[initial.tabId] && !lost.requests[requestId], 'Client placement and correlation are actually absent')
    const identity = first.nativeSessions.find(session => session.id === initial.agentSessionId)
    assert.ok(identity, 'The exact original Native Session is present')
    assert.deepEqual(lost.nativeSessions, first.nativeSessions, 'Losing presentation does not mutate Native Sessions')
    await open(0)
    await click(`${picker}.querySelector('.agent-pick[data-executor-id="gemini"]')`)
    await wait(`!${picker}`)
    await wait(`takeoverProbe.facts().requests[${JSON.stringify(requestId)}]&&Object.values(takeoverProbe.facts().operations).some(operation=>operation.operationId===${JSON.stringify(requestId)}&&operation.phase==='succeeded')`)
    const shown = await evaluate('takeoverProbe.facts()'), rebound = shown.requests[requestId]
    assert.equal(rebound.agentSessionId, initial.agentSessionId)
    assert.equal(shown.launches.length, 1, 'Re-presentation never repeats launch or first input')
    assert.deepEqual(shown.nativeSessions, first.nativeSessions, 'The original Run and Session identities remain exact')
    assert.deepEqual(shown.drafts, original.drafts)
    assert.ok(shown.tabs[rebound.tabId].regions[rebound.regionId], 'The existing Agent has a real workface again')
    const inspection = await evaluate(`takeoverProbe.inspect(${JSON.stringify(requestId)})`)
    assert.equal(inspection.request.report.outcome, 'opened')
    await evaluate(`takeoverProbe.showRequest(${JSON.stringify(requestId)})`)
    await frame('live-reattached')
    result.liveReattached = { requestId, agentSessionId: initial.agentSessionId, noLaunch: true, inspection }
    await wait('takeoverProbe.saved()')
    const sealed = await evaluate('takeoverProbe.seal()')
    const saved = await spatial.read()
    assert.ok(saved.graph.regions.some(region => region.regionId === rebound.regionId && region.agentSessionId === initial.agentSessionId))
    await fs.writeFile(baselinePath, JSON.stringify({ tabs: sealed.tabs, layouts: sealed.layouts, drafts: sealed.drafts,
      requests: sealed.requests, nativeSessions: sealed.nativeSessions, requestId, agentSessionId: initial.agentSessionId }))
  } else {
    const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'))
    const restored = await evaluate('takeoverProbe.facts()')
    assert.equal(restored.bootRestored, true)
    for (const key of ['tabs', 'layouts', 'drafts', 'requests', 'nativeSessions']) assert.deepEqual(restored[key], baseline[key], 'Fresh process restores saved ' + key)
    assert.equal(restored.launches.length, 0, 'Restart never creates or replays')
    const inspection = await evaluate(`takeoverProbe.inspect(${JSON.stringify(baseline.requestId)})`)
    assert.equal(inspection.request.report.outcome, 'opened')
    assert.equal(inspection.request.report.agent.agentSessionId, baseline.agentSessionId)
    await evaluate(`takeoverProbe.showRequest(${JSON.stringify(baseline.requestId)})`)
    await frame('live-restart-reattached')
    result.restart = { noReplay: true, noLaunch: true, noWorkfaceReseed: true, preservedWorkface: true, inspection }
  }
}
