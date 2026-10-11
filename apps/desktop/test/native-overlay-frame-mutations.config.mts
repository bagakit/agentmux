import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/main/native-overlay-surfaces.ts'
const changes = {
  unrelatedBrowsers: [['    // Accepted update/visibilityChanged owns Browser demand.', '    this.browsers.visibleNativeBounds()\n    // Accepted update/visibilityChanged owns Browser demand.']],
  untaggedTransport: [
    ['sourceCurrent?: () => boolean): Promise<void>', 'sourceCurrent?: () => boolean, sourceImage?: NativeImage): Promise<void>'],
    ['const image = await this.window.webContents.capturePage(projection.region.bounds)', 'const image = sourceImage ?? await this.window.webContents.capturePage(projection.region.bounds)'],
    ['this.paint(projection, false, () => this.frameCurrent(frame))', 'this.paint(projection, false, () => this.frameCurrent(frame), image)']
  ],
  missingFrames: [['this.window.webContents.beginFrameSubscription(false, image => {', 'this.window.webContents.beginFrameSubscription(false, image => { return;']],
  pixelDedup: [['if (projection.framePixels?.equals(pixels)) continue', 'if (false) continue']],
  latestPending: [['this.pendingFrame = { image, subscription, width, height, zoom:', 'if (!this.pendingFrame) this.pendingFrame = { image, subscription, width, height, zoom:']],
  serialFrames: [['if (this.frameRunning) return', 'if (false) return']],
  staleFrames: [
    ['this.frameSubscription !== subscription || ', ''],
    ['this.frameSubscription !== frame.subscription || ', '']
  ],
  frameScale: [['Math.round(bounds.x * size.width / frame.width)', 'Math.round(bounds.x)']],
  lateDecoder: [['revision !== projection.revision || !sourceCurrent?.()', 'revision !== projection.revision']],
  releaseFrames: [['this.window.webContents.endFrameSubscription()', 'void 0']]
} as const
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...original, plugins: [{ name: 'native-source-frame-mutants', enforce: 'pre', transform(source, id) {
  const name = process.env.NATIVE_FRAME_MUTATION as keyof typeof changes | undefined
  if (!name || relative(root, id) !== owner) return
  assert.ok(changes[name])
  let changed = source
  const hits: { needle: string; occurrences: number }[] = []
  for (const [needle, replacement] of changes[name]) {
    const occurrences = changed.split(needle).length - 1
    assert.equal(occurrences, 1)
    changed = changed.replace(needle, replacement)
    hits.push({ needle, occurrences })
  }
  if (process.env.NATIVE_FRAME_HITS) appendFileSync(process.env.NATIVE_FRAME_HITS,
    JSON.stringify({ name, file: owner, hits, source: sha(source), changed: sha(changed) }) + '\n')
  return { code: changed, map: null }
} }], test: { ...original.test, include: ['apps/desktop/test/native-overlay-surfaces.test.ts'], passWithNoTests: false, maxWorkers: 1 } })
