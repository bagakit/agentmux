import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { feedbackPaintPreparation, withFeedbackFramePaint } = await import(pathToFileURL(process.env.AGENTMUX_FEEDBACK_FRAME_STATE_SOURCE ?? resolve(import.meta.dirname, 'frame-state.mjs')))
const source = await readFile(resolve(import.meta.dirname, '../../../src/main/browser-operation-feedback.ts'), 'utf8')
test('actual setup consumes a nonempty Source palette once; actual reads use only that cache', () => {
  let canvases = 0, reads = 0
  class Canvas {
    constructor() { canvases++ }
    getContext(_kind, options) { return { getContextAttributes: () => options, clearRect() {}, fillRect() {},
      getImageData() { reads++; return { data: [1, 2, 3, 255] } } } }
  }
  const prepared = Function('OffscreenCanvas', `return ${feedbackPaintPreparation(source, 'display-p3')}`)(Canvas)
  assert.equal(canvases, 1); assert.ok(reads > 0); assert.equal(Object.keys(prepared.cache).length, reads)
  const count = reads
  const label = { color: 'rgb(203, 243, 216)', backgroundColor: 'rgba(20, 29, 24, 0.92)', paddingTop: '3px', fill: 'rgb(0, 0, 0)' }
  const original = '({hostConnected:true,label:{text:"original actual reader fixture"}})'
  const expression = withFeedbackFramePaint(original, prepared)
  class ForbiddenCanvas { constructor() { assert.fail('The action-time reader must not initialize or read a Canvas') } }
  const result = Function('OffscreenCanvas', 'getComputedStyle', 'globalThis', `return ${expression}`)(ForbiddenCanvas, x => x,
    { __agentMuxBrowserOperationFeedback: { shadow: { querySelector: selector => selector === '.label' ? label : null } } })
  assert.deepEqual(result.label.paint.outputColor, prepared.cache['203,243,216,1'])
  assert.deepEqual(result.label.paint.outputBackground, prepared.cache['20,29,24,0.92'])
  assert.equal(reads, count); assert.equal(canvases, 1)
})
test('unknown display or empty/unprepared palette refuses Source observation', () => {
  assert.throws(() => feedbackPaintPreparation(source, 'unknown'), /Unsupported/)
  assert.throws(() => feedbackPaintPreparation('', 'srgb'), /stylesheet unavailable/)
  assert.throws(() => withFeedbackFramePaint('null', { outputSpace: 'srgb', cache: {} }), /cache unavailable/)
})
