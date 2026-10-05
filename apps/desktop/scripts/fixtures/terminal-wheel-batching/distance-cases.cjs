const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

// The existing production consumer, Core and private PTY remain the only input/output path.
async function verifyWheelDistance({ win, mount, drain, info, until, phase, distribution, cases }) {
  const oldDistance = phase === 'old-distance'
  const recipes = [
    { name: 'pixel-tiny-distance', mode: 'alternate-mouse', deltas: Array(20).fill(-1) },
    { name: 'pixel-fractional-distance', mode: 'alternate-mouse', deltas: Array(16).fill(-6) },
    { name: 'pixel-threshold-distance', mode: 'alternate-mouse', deltas: [-49, -50, -49, -50, -49, -50] },
    { name: 'pixel-reversal-distance', mode: 'alternate-mouse', reversal: true },
    { name: 'binary-pixel-distance', mode: 'alternate-binary', deltas: Array(12).fill(-6) },
    { name: 'cursor-key-pixel-distance', mode: 'alternate-keys', deltas: Array(12).fill(-6) }
  ]
  async function pixels() {
    await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    const current = await info(), rect = current.screen
    const image = (await win.webContents.capturePage()).crop({ x: Math.ceil(rect.left), y: Math.ceil(rect.top),
      width: Math.floor(rect.width), height: Math.floor(Math.min(rect.height, current.cellHeight * 12)) })
    assert.ok(!image.isEmpty())
    const png = image.toPNG(); assert.ok(png.length > 1000)
    return { sha256: createHash('sha256').update(png).digest('hex'), size: image.getSize(), pngBase64: png.toString('base64') }
  }
  for (const c of recipes) {
    await mount(c)
    // Independent cases share the retained fixture terminal, never a gesture's accumulator.
    await win.webContents.executeJavaScript('terminals.at(-1)._core._mouseService._wheelPartialScroll=0')
    const before = await info(), cellHeight = before.deviceCell.height / before.dpr
    assert.equal(before.partial, 0); assert.ok(cellHeight > 0)
    assert.ok(Math.abs(cellHeight - before.cellHeight) < .51)
    const deltas = c.reversal ? [-10.05 * cellHeight / before.scrollSensitivity,
      -.85 * cellHeight / (.3 * before.scrollSensitivity), ...Array(8).fill(.2 * cellHeight / (.3 * before.scrollSensitivity))] : c.deltas
    const initialPixels = await pixels(), steps = []
    let partial = 0, reports = 0, top = 500, previousRequests = 0, previousInputs = 0, previousPixels = initialPixels, reverseStart
    for (let index = 0; index < deltas.length; index++) {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before.point.x,
        y: before.point.y, deltaX: 0, deltaY: deltas[index] })
      const event = (await until(info, value => value.wheels.length === index + 1, 'Actual pixel wheel was not dispatched')).wheels.at(-1)
      assert.equal(event.isTrusted, true); assert.equal(event.deltaMode, 0)
      let distance = event.deltaY * before.scrollSensitivity / cellHeight
      if (oldDistance && Math.abs(event.deltaY) < 50) distance *= .3
      if (!oldDistance && partial * distance < 0) partial = 0
      partial += distance
      const count = Math.floor(Math.abs(partial)); partial %= 1
      reports += count; top += (event.deltaY < 0 ? -3 : 3) * count
      const native = await drain()
      assert.equal(native.program.reports, reports, 'Normalized pixel distance must reach the Native TUI: ' + c.name + ':' + index)
      assert.equal(native.program.top, top, 'Native history must move, not merely an emulator report counter')
      const after = await until(info, value => value.firstLine?.includes(`private-TUI-row-${top}`), 'Actual TerminalView did not repaint Native history')
      const requests = native.requests.slice(previousRequests), inputEvents = after.inputEvents.slice(previousInputs)
      const operations = count ? phase === 'baseline' ? count : 1 : 0
      assert.equal(requests.length, operations, 'Each DOM wheel keeps its own complete input operation')
      assert.equal(inputEvents.length, operations)
      assert.deepEqual(inputEvents.flatMap(input => input.bytes), requests.flatMap(request => request.bytes))
      if (c.mode === 'alternate-binary') {
        assert.ok(inputEvents.every(input => input.channel === 'onBinary'))
        if (count) {
          const bytes = requests.flatMap(request => request.bytes), report = bytes.slice(0, 6)
          assert.ok(report[4] >= 128); assert.deepEqual(bytes, Array.from({ length: count }, () => report).flat())
        }
      } else assert.ok(inputEvents.every(input => input.channel === 'onData'))
      const currentPixels = await pixels()
      // Each reversed step compares against its preceding reversed frame, never the forward gesture.
      if (count) assert.notEqual(currentPixels.sha256, previousPixels.sha256, 'Native movement must change actual terminal pixels')
      else assert.equal(currentPixels.sha256, previousPixels.sha256, 'No Native movement must preserve actual terminal pixels')
      if (c.reversal && index === 1) reverseStart = { top, pixels: currentPixels }
      steps.push({ index, event, physicalRows: event.deltaY / cellHeight, partial, reports: count,
        operations, inputEvents, requests, nativeTop: native.program.top, firstLine: after.firstLine,
        pixels: { sha256: currentPixels.sha256, size: currentPixels.size } })
      previousRequests = native.requests.length; previousInputs = after.inputEvents.length; previousPixels = currentPixels
    }
    const native = await drain(), after = await info(), finalPixels = await pixels()
    if (c.reversal) {
      const reverseSteps = steps.slice(2)
      if (oldDistance) {
        assert.ok(reverseSteps.every(step => step.operations === 0 && step.nativeTop === reverseStart.top))
        assert.equal(finalPixels.sha256, reverseStart.pixels.sha256)
      } else {
        assert.equal(reverseSteps.findIndex(step => step.reports > 0), 1, 'Opposite residue cannot delay a reversed gesture')
        assert.notEqual(finalPixels.sha256, reverseStart.pixels.sha256)
      }
    }
    cases.push({ distribution, ...c, deltas, before, after, steps, native, injectedServiceDelayMs: 0,
      pixels: { initial: initialPixels, ...(reverseStart ? { reversalStart: reverseStart } : {}), final: finalPixels } })
  }
}
module.exports = { verifyWheelDistance }
