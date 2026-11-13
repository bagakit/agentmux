import assert from 'node:assert/strict'
import { join } from 'node:path'
import { withCaptureProof, pixel, readPng } from './bootstrap.js'

void withCaptureProof(async context => {
  const { cli, target, region, root, report, window, browsers, browserId } = context
  const entries = (browsers as unknown as { entries: Map<string, unknown> }).entries
  const values = entries.values, members = entries.entries, iterator = entries[Symbol.iterator]
  const globalScan = () => { throw new Error('Capturing one window must not scan unrelated Browser entries') }
  entries.values = globalScan; entries.entries = globalScan; entries[Symbol.iterator] = globalScan
  const before = await window.webContents.executeJavaScript(`({draft:document.getElementById('draft').value,active:document.activeElement.id})`)
  const output = join(root, 'workface.png')
  const captured = await cli('app.capture', { target }, output)
  assert.equal(captured.ok, true, JSON.stringify(captured))
  const png = await readPng(output)
  assert.deepEqual(pixel(png, 600, 350), [220, 80, 20, 255], 'The actual native Browser must appear above the Renderer')
  assert.deepEqual(pixel(png, 100, 400), [80, 40, 210, 255], 'The actual original Renderer remains visible')
  assert.ok(captured.result.layers.some((layer: any) => layer.browserId === browserId && layer.kind === 'browser'))
  assert.deepEqual(captured.result.target, target)
  assert.ok(captured.result.observedAt >= captured.result.startedAt)
  assert.equal(captured.result.image.data, undefined, 'CLI binary output must not duplicate its image payload')
  entries.values = values; entries.entries = members; entries[Symbol.iterator] = iterator
  const cropped = await cli('app.capture', { target: { ...target, region } }, join(root, 'region.png'))
  assert.equal(cropped.ok, true, JSON.stringify(cropped))
  assert.equal(cropped.result.image.width, 720)
  assert.equal(cropped.result.image.height, 500)
  const native = browsers.captureWorkbenchViews(window).find(entry => entry.browserId === browserId)!.view.webContents
  const originalCapture = native.capturePage.bind(native), sourceCrops: unknown[] = []
  native.capturePage = async (rect, options) => { sourceCrops.push(rect); return originalCapture(rect, options) }
  await window.webContents.executeJavaScript(`document.getElementById('region').style.cssText='left:350px;top:220px;width:120px;height:90px'`)
  const tiny = await cli('app.capture', { target: { ...target, region } })
  assert.equal(tiny.ok, true, JSON.stringify(tiny))
  assert.equal(tiny.result.image.width, 120); assert.equal(tiny.result.image.height, 90)
  assert.deepEqual(sourceCrops, [{ x: 50, y: 40, width: 120, height: 90 }], 'Native pixels must be bounded to the exact intersecting crop')
  native.capturePage = originalCapture
  await window.webContents.executeJavaScript(`document.getElementById('region').style.cssText=''`)
  const wrong = await cli('app.capture', { target: { ...target, documentGeneration: 'another-generation' } })
  assert.equal(wrong.ok, false, 'Another native document may not be captured')
  const wrongRegion = await cli('app.capture', { target: { ...target, region: { ...region, regionId: 'another-region' } } })
  assert.equal(wrongRegion.ok, false)
  await window.webContents.executeJavaScript(`document.getElementById('region').hidden=true`)
  const hidden = await cli('app.capture', { target: { ...target, region } })
  assert.equal(hidden.ok, false, 'An unpresented Region cannot borrow another visible source')
  await window.webContents.executeJavaScript(`document.getElementById('region').hidden=false`)
  browsers.setBounds(browserId, null)
  const noBrowser = await cli('app.capture', { target })
  assert.equal(noBrowser.ok, true)
  assert.deepEqual(pixel(noBrowser.result.image.data, 600, 350), [80, 40, 210, 255])
  browsers.setBounds(browserId, { x: 300, y: 180, width: 400, height: 260 })
  const after = await window.webContents.executeJavaScript(`({draft:document.getElementById('draft').value,active:document.activeElement.id})`)
  assert.deepEqual(after, before, 'Observation must preserve the original draft and input')
  const overwrite = await cli('app.capture', { target }, output)
  assert.equal(overwrite.ok, false, 'CLI may not overwrite a local output')
  assert.equal(await readPng(output), png)
  report.png = png
  report.checks.push('actual CLI/RPC/window/Renderer/native Browser PNG', 'exact document and occurrence rejection', 'native intersection pixels only', 'window-related layer lookup without a global Browser scan',
    'hidden Region refusal with other capture still available', 'original draft/caret preserved', 'new-file-only binary export')
})
