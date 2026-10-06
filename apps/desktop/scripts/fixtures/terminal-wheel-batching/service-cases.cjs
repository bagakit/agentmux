const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
exports.verifyServiceFanout = async ({ win, mount, drain, info, until, phase, result, privateRoot }) => {
  const reference = phase === 'service-global-reference'
  await until(() => win.webContents.executeJavaScript('window.serviceReady===true'), Boolean, 'Actual service consumer fixture did not load')
  for (const population of reference ? [200] : [200, 2000]) {
    const before = await mount({ mode: 'alternate-mouse' })
    await win.webContents.executeJavaScript(`servicePopulation(${population})`)
    const progress = await win.webContents.executeJavaScript('serviceProgress(400)')
    assert.equal(progress.count, 400)
    if (reference) { assert.equal(progress.sameCollection, false); assert.ok(progress.collectionChanges >= 400); assert.ok(progress.chromeCommits > 0) }
    else { assert.equal(progress.sameCollection, true, 'Raw service progress cannot replace the ordinary Session collection'); assert.equal(progress.collectionChanges, 0); assert.equal(progress.chromeCommits, 0, 'Actual global notices and closed QuickSwitcher stay idle for progress'); assert.equal(progress.latestRevision, progress.expectedRevision, 'Scoped reads retain the actual latest full service fact') }
    result.cases.push({ name: 'progress-scope', population, ...progress })
    if (reference) continue
    for (const kind of ['pressure', 'input', 'recover']) {
      const fault = await win.webContents.executeJavaScript(`serviceFault(${JSON.stringify(kind)})`)
      if (kind === 'pressure') assert.match(fault.body, /resource pressure/)
      if (kind === 'input') assert.match(fault.body, /input unavailable/)
      if (kind === 'recover') assert.doesNotMatch(fault.body, /input unavailable|Serving output under resource pressure/)
      result.cases.push({ name: 'actual-service-window', population, kind, revision: fault.revision })
    }
    const initial = (await win.capturePage()).toPNG(), started = performance.now()
    const concurrentStart = await win.webContents.executeJavaScript(`(() => {
      window.serviceWheelRevisions = []
      window.serviceConcurrent = serviceProgress(400, true)
      return true
    })()`)
    assert.equal(concurrentStart, true)
    for (const direction of [1, -1, 1]) {
      for (let i = 0; i < 8; i++) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: before.point.x, y: before.point.y, deltaX: 0, deltaY: 13 * direction
      })
      await win.webContents.executeJavaScript('terminals.at(-1).focus()')
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: direction > 0 ? 'j' : 'k' })
    }
    const concurrent = await win.webContents.executeJavaScript('serviceConcurrent')
    const wheelRevisions = await win.webContents.executeJavaScript('serviceWheelRevisions')
    assert.ok(wheelRevisions.length > 0 && wheelRevisions.some(revision => revision < concurrent.expectedRevision), 'Trusted wheel overlaps actual Store service delivery')
    assert.equal(concurrent.collectionChanges, 0)
    assert.equal(concurrent.chromeCommits, 0)
    assert.equal(concurrent.latestRevision, concurrent.expectedRevision)
    const native = await drain()
    await until(info, value => value.firstLine?.includes(`private-TUI-row-${native.program.top}`), 'Original xterm must show the actual native TUI after reversal')
    const final = (await win.capturePage()).toPNG(), hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
    assert.notEqual(hash(initial), hash(final), 'Native capture changes with actual TUI content')
    assert.ok(native.program.reports > 0)
    assert.ok(native.program.keys.includes('jkj'), 'Immediate following keys reach original private PTY in order')
    fs.writeFileSync(path.join(privateRoot, `service-${population}.png`), final)
    result.cases.push({ name: 'actual-wheel-reverse-key', population, elapsedMs: performance.now() - started,
      concurrent, schedule: 'Finite service producer yields after its first fact until the first trusted wheel, then resumes task delivery', wheelRevisions, beforeGrid: [before.cols, before.rows], requests: native.requests.length, reports: native.program.reports,
      keys: native.program.keys, initial: hash(initial), final: hash(final), native })
  }
  await win.webContents.executeJavaScript('serviceCleanup()')
}
