import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { resolve, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../../../..')
const helper = process.env.AGENTMUX_FEEDBACK_PIXEL_SOURCE ?? resolve(import.meta.dirname, 'frame-pixels.mjs')
const { inspectFeedbackFrame } = await import(pathToFileURL(helper))
const historical = resolve(root, 'docs/reviews/evidence/browser-operation-pointer-motion-native-2026-10-04/attempt-4')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const postcss = createRequire(require.resolve('vite'))('postcss')
const moduleBytes = await readFile(resolve(root, 'apps/desktop/src/main/browser-operation-feedback.ts'))
const moduleText = moduleBytes.toString('utf8')
const sheet = /sheet\.replaceSync\(`([^`]+)`\)/.exec(moduleText)
assert.ok(sheet && sheet[1].length > 0, 'Actual approved product stylesheet is nonempty')
const rules = new Map()
postcss.parse(sheet[1]).walkRules(rule => { const values = {}; rule.walkDecls(d => { values[d.prop] = d.value }); rules.set(rule.selector, values) })
assert.ok(rules.size > 0, 'Paint facts come from the actual stylesheet, not a handwritten color list')
const fill = /arrow\.setAttribute\('fill', '([^']+)'\)/.exec(moduleText)
assert.ok(fill, 'Actual SVG path fill is present')
const color = hex => hex?.startsWith('#') ? `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})` : hex
function historicalP3(value) {
  const channels = value.match(/[\d.]+/g).map(Number)
  const run = spawnSync('python3', ['-c', 'from PIL import Image,ImageCms;import sys,json; rgb=json.loads(sys.argv[1]); im=Image.new("RGB",(1,1),tuple(rgb)); print(json.dumps(ImageCms.profileToProfile(im,ImageCms.createProfile("sRGB"),"/System/Library/ColorSync/Profiles/Display P3.icc").getpixel((0,0))))', JSON.stringify(channels.slice(0, 3))])
  assert.equal(run.status, 0)
  return [...JSON.parse(run.stdout), channels[3] ?? 1]
}
function candidate(sample) {
  const result = structuredClone(sample), hud = result.hud
  const completed = hud.phase === 'completed'
  // Old raw did not collect computed paint. This test derives it from its byte-identical
  // approved Source leaf; it does not rewrite or claim these fields existed in old raw.
  assert.equal(createHash('sha256').update(moduleBytes).digest('hex'), 'e30d06cd287f3642153c03287850dfd70c3ee62939ad212b0dc31c3406812e16')
  const values = rules.get('.label'); assert.ok(values)
  if (hud.label) hud.label.paint = { color: color(completed ? rules.get('.label.complete').color : values.color),
    backgroundColor: values.background.replace('rgba(', 'rgba('), paddingTop: values.padding.split(' ')[0] }
  if (hud.arrow) hud.arrow.paint = { fill: color(fill[1]) }
  // The historical subscriber PNG lost its profile tag. This explicit Display-P3
  // calibration hypothesis proves the classifier, not historical color-space provenance.
  // New Native must record the actual screen profile and its actual Canvas conversion.
  hud.label.paint.outputColor = historicalP3(hud.label.paint.color)
  hud.label.paint.outputBackground = historicalP3(hud.label.paint.backgroundColor)
  hud.arrow.paint.outputFill = historicalP3(hud.arrow.paint.fill)
  return result
}
async function original(phase, label, sequence) {
  const raw = JSON.parse(await readFile(resolve(historical, `${phase}-receipt.json`), 'utf8'))
  const row = raw.cases.find(row => row.label === label); assert.ok(row)
  const frame = row.frames.find(frame => frame.sequence === sequence); assert.ok(frame)
  const sample = row.samples.find(sample => sample.sequence === frame.sampleAtOrBefore.sampleSequence); assert.ok(sample)
  const path = resolve(historical, basename(frame.path)), png = await readFile(path)
  assert.equal(createHash('sha256').update(png).digest('hex'), frame.sha256)
  // Existing maintained Pillow decodes original PNG bytes. No screenshot is edited or written.
  const decoded = spawnSync('python3', ['-c', 'from PIL import Image; import sys,struct; im=Image.open(sys.argv[1]).convert("RGBA"); sys.stdout.buffer.write(struct.pack("<II",*im.size)+im.tobytes())', path], { maxBuffer: 12 * 1024 * 1024 })
  assert.equal(decoded.status, 0, decoded.stderr?.toString())
  const bitmap = { width: decoded.stdout.readUInt32LE(0), height: decoded.stdout.readUInt32LE(4), bytes: decoded.stdout.subarray(8), order: 'rgba' }
  assert.equal(bitmap.width, frame.size.width); assert.equal(bitmap.height, frame.size.height)
  return { bitmap, sample: candidate(sample) }
}
for (const [phase, label, sequence, failure] of [
  ['first', 'motion-same-operation', 0, 'no pointer/label'],
  ['second', 'motion-reduced-static', 1, 'no pointer/label'],
  ['second', 'motion-reduced-static', 0, 'running pixels paired with completed DOM']
]) test(`reject actual old mismatched PNG: ${phase}/${label}/${sequence} (${failure})`, async () => {
  const { bitmap, sample } = await original(phase, label, sequence)
  assert.equal(inspectFeedbackFrame(bitmap, sample).compatible, false, 'Original visible pixels must refuse the false cue/phase attribution')
})
for (const [phase, label, sequence] of [
  ['first', 'motion-same-operation', 1], ['first', 'motion-same-operation', 2],
  ['second', 'motion-reduced-static', 2], ['first', 'motion-named-key', 0], ['first', 'motion-generic-key', 0]
]) test(`accept actual nonempty original cue PNG: ${phase}/${label}/${sequence}`, async () => {
  const { bitmap, sample } = await original(phase, label, sequence)
  const result = inspectFeedbackFrame(bitmap, sample)
  assert.equal(result.compatible, true, JSON.stringify(result))
  assert.ok(result.textPixels.count > 0 && result.arrowPixels.count > 0)
  assert.equal(result.phase, sample.hud.phase)
})
test('unknown scale or missing computed paint refuses attribution', async () => {
  const { bitmap, sample } = await original('second', 'motion-reduced-static', 2)
  assert.equal(inspectFeedbackFrame({ ...bitmap, width: bitmap.width / 2 }, sample).compatible, false)
  delete sample.hud.label.paint
  assert.equal(inspectFeedbackFrame(bitmap, sample).compatible, false)
})
