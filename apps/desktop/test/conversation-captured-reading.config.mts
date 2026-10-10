import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...base,
  cacheDir: resolve(root, '.cache/conversation-captured-reading'),
  plugins: [...(base.plugins ?? []), { name: 'captured-reading-loaded-implementation', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (file !== resolve(root, 'apps/desktop/src/renderer/src/components/ActivityView.tsx')) return
    const mutation = process.env.AGENTMUX_CAPTURED_READING_MUTATION
    if (mutation && mutation !== 'remove-visible-native-boundary') throw Error('Unknown captured reading mutation')
    let code = source
    if (mutation) {
      const target = 'if (!nativeAnchor) return\n      anchorRef.current = nativeAnchor'
      if (source.split(target).length !== 2) throw Error('Captured reading mutation target is not unique')
      code = source.replace(target, 'if (nativeAnchor) anchorRef.current = nativeAnchor')
    }
    const log = process.env.AGENTMUX_CAPTURED_READING_LOADED
    if (log) appendFileSync(log, JSON.stringify({ file: relative(root, file),
      originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'),
      bytes: Buffer.byteLength(code), ...(mutation ? { mutation } : {}) }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/conversation-captured-reading.integration.test.tsx'], passWithNoTests: false }
})
