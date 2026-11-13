import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { mergeConfig } from 'vitest/config'
import base from './vitest.image-annotation.config.mts'

const source = process.env.SCREENSHOT_PIN_RECOVERY_SOURCE
  ? resolve(import.meta.dirname, '../../..', process.env.SCREENSHOT_PIN_RECOVERY_SOURCE)
  : resolve(import.meta.dirname, '../src/renderer/src/lib/use-screenshot-pin.ts')
const mutation = process.env.SCREENSHOT_PIN_RECOVERY_MUTATION ? JSON.parse(process.env.SCREENSHOT_PIN_RECOVERY_MUTATION) : null
const configured = mergeConfig(base, {
  cacheDir: resolve(import.meta.dirname, '../../../.tmp/screenshot-pin-recovery-tests'),
  plugins: [{ name: 'loaded-pin-recovery', enforce: 'pre', load(id) {
    if (id.split('?')[0] !== source) return
    const original = readFileSync(source, 'utf8')
    if (mutation && original.split(mutation.from).length !== 2) throw new Error('The recovery mutation is not unique: ' + mutation.id)
    const consumed = mutation ? original.replace(mutation.from, mutation.to) : original
    if (process.env.SCREENSHOT_PIN_RECOVERY_LOADED) appendFileSync(process.env.SCREENSHOT_PIN_RECOVERY_LOADED,
      JSON.stringify({ source: createHash('sha256').update(original).digest('hex'), consumed: createHash('sha256').update(consumed).digest('hex'), mutation: mutation?.id ?? null }) + '\n')
    return consumed
  } }],
  test: { passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})

configured.test = { ...configured.test, include: ['apps/desktop/test/screenshot-pin-recovery.test.tsx'] }
export default configured
