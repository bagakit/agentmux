import assert from 'node:assert/strict'

/** Read the original live raw Terminal in the actual App. All scrolling and input use CDP
 * gestures; observation never calls xterm scroll methods or substitutes Provider records. */
export async function runRemoteTerminalReadingProof({ win, reading, identity, phase, capture }) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const evaluate = expression => win.webContents.executeJavaScript(expression)
  const observe = () => evaluate('window.remoteReadingState()')
  const wait = async (read, accept, label, budget = 20000) => {
    const deadline = Date.now() + budget
    for (;;) { const value = await read(); if (accept(value)) return value
      assert.ok(Date.now() < deadline, label); await delay(20) }
  }
  const select = async tabId => {
    await evaluate(`document.querySelector('button[data-workbench-tab-id=${JSON.stringify(tabId)}]').click(); true`)
  }
  const wheel = async (before, direction) => {
    assert.ok(before.point?.height > 0, 'The actual terminal has visible positive geometry')
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel',
      x: Math.floor(before.point.x), y: Math.floor(before.point.y), deltaX: 0,
      deltaY: direction * Math.max(10, Math.floor(before.point.height / 2)) })
    const next = await wait(observe, value => direction < 0 ? value.view?.buffer.viewportY < before.view.buffer.viewportY
      : value.view?.buffer.viewportY > before.view.buffer.viewportY, 'An actual trusted wheel must move this original terminal viewport', 3000)
    assert.equal(next.terminalId, before.terminalId, 'Continuous reading retains the native terminal instance')
    assert.equal(next.view.runId, reading.runId)
    assert.equal(next.historyCount, 0, 'Live terminal reading must not switch to a record page')
    const distance = Math.abs(next.view.buffer.viewportY - before.view.buffer.viewportY)
    assert.ok(distance <= Math.min(next.view.viewGrid.rows, before.view.viewGrid.rows), 'Successive visible reading ranges overlap; no skipped history interval')
    return next
  }
  const originalWorkbench = await evaluate('window.remoteState()')
  await select(reading.tabId)
  const bottom = await wait(observe, value => value.visibleTerminals === 1 && value.view?.liveReady && value.view.buffer.type === 'normal' &&
    value.view.buffer.baseY > 0 && value.view.buffer.viewportY === value.view.buffer.baseY && value.lines.some(line => line?.includes(reading.lastMarker)),
  'The original large normal terminal and its last retained row must actually be visible')
  assert.ok(bottom.allMetrics.length > 0)
  assert.ok(bottom.metrics.writeCalls > 0 && bottom.metrics.inputBytes > 256 * 1024, 'A nonempty actual native writer consumed the large terminal transfer')
  assert.equal(bottom.session.id, reading.sessionId)
  assert.equal(bottom.session.control.runId, reading.runId)
  const steps = [bottom.view.buffer.viewportY]
  let current = bottom
  while (current.view.buffer.viewportY > 0) {
    assert.ok(steps.length < 1500, 'The original bounded history must remain continuously reachable')
    current = await wheel(current, -1); steps.push(current.view.buffer.viewportY)
  }
  assert.ok(steps.length > 1)
  assert.ok(current.lines.some(line => line?.includes(reading.firstMarker)), 'The first retained producer row is actually visible in the original Region')
  const top = current
  await capture(`${phase}-terminal-first-row.png`)
  const down = [current.view.buffer.viewportY]
  while (current.view.buffer.viewportY < current.view.buffer.baseY) {
    assert.ok(down.length < 1500)
    current = await wheel(current, 1); down.push(current.view.buffer.viewportY)
  }
  assert.ok(current.lines.some(line => line?.includes(reading.lastMarker)))
  assert.ok(current.wheels.length > 0)
  assert.ok(current.wheels.every(event => event.trusted && event.targetTerminal), 'Every actual reading gesture reaches the native terminal')
  await capture(`${phase}-terminal-last-row.png`)
  // Initial attachment/resize work must settle before the unrelated-output cost window.
  let idle = await observe()
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(100); const next = await observe()
    if (JSON.stringify(next.metrics) === JSON.stringify(idle.metrics)) { idle = next; break }
    idle = next
    assert.ok(attempt < 19, 'The related quiet terminal must settle before unrelated activity is measured')
  }
  let noise
  try {
    const remote = await evaluate('window.remoteProof.request("terminal-noise-start")')
    assert.equal(remote.unrelated.length, 7)
    assert.ok(remote.unrelated.every(run => run.pid > 0 && run.outputBytes > 0))
    assert.equal(remote.unrelatedByteDeliveries, 0)
    await delay(500)
    const after = await observe()
    assert.equal(after.terminalId, idle.terminalId)
    assert.deepEqual(after.metrics, idle.metrics, 'Seven unrelated output Runs cause zero writes/parse input in the original idle reading terminal')
    assert.deepEqual(after.view.buffer, idle.view.buffer)
    noise = { remote, before: { terminalId: idle.terminalId, metrics: idle.metrics, allMetrics: idle.allMetrics },
      after: { terminalId: after.terminalId, metrics: after.metrics, allMetrics: after.allMetrics } }
  } finally { await evaluate('window.remoteProof.request("terminal-noise-stop")') }
  const beforeInput = await evaluate('window.remoteProof.request("remote-terminal-status")')
  await evaluate('window.remoteFocusReadingTerminal(); true')
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: reading.inputText })
  // An ordinary restart retains the first generation's marker. Wait for this
  // generation's actual writer pulse as well as the visible producer reply.
  const input = await wait(observe, value => value.lines.some(line => line?.includes(reading.inputMarker)) &&
    value.metrics.writeCalls > idle.metrics.writeCalls && value.metrics.inputBytes > idle.metrics.inputBytes &&
    value.metrics.completedWrites === value.metrics.writeCalls,
  'Actual keyboard input produces a completed new writer pulse in the same original terminal')
  const afterInput = await evaluate('window.remoteProof.request("remote-terminal-status")')
  assert.deepEqual([afterInput.runId, afterInput.pid, afterInput.state], [reading.runId, reading.pid, 'running'])
  assert.ok(afterInput.acceptedInputBytes > beforeInput.acceptedInputBytes)
  assert.ok(afterInput.latestOutputBytes > beforeInput.latestOutputBytes)
  assert.ok(input.metrics.writeCalls > idle.metrics.writeCalls && input.metrics.inputBytes > idle.metrics.inputBytes, 'A relevant output pulse proves the writer observations are connected')
  await capture(`${phase}-terminal-input.png`)
  await select(identity.tabId)
  const restored = await wait(() => evaluate('window.remoteState()'), value => Boolean(value.editor), 'The original Agent workbench must return')
  for (const field of ['tabs', 'layouts', 'drafts', 'activeWorkspaceId']) assert.deepEqual(restored[field], originalWorkbench[field], `${field} survives terminal reading and unrelated activity`)
  assert.equal(restored.session.control.run.runId, identity.run.runId)
  return { runId: reading.runId, pid: reading.pid, tabId: reading.tabId, regionId: reading.regionId,
    bottom, top, upViewportSteps: steps, downViewportSteps: down, noise,
    input: { before: beforeInput, after: afterInput, observed: input }, originalAgentWorkbenchKept: true }
}
