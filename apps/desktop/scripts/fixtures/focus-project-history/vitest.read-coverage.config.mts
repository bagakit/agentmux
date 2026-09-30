import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.renderer-history.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
const changes: Record<string, readonly [string, string]> = {
  "clear-other-sources": [
    "const partitions = new Map(windowRef.current.partitions)\n    partitions.delete(next.scope)",
    "const partitions = new Map<string, NativeWindow>()\n    partitions.delete(next.scope)"
  ],
  "partition-budget": [
    "while (nativeCount > MAX_NATIVE_RECORDS || capturedCount > MAX_CAPTURED_RECORDS || bytes > MAX_WINDOW_BYTES)",
    "while (nativeCount > MAX_NATIVE_RECORDS * partitions.size || capturedCount > MAX_CAPTURED_RECORDS * partitions.size || bytes > MAX_WINDOW_BYTES * partitions.size)"
  ],
  "late-scope": [
    "const valid = () => enabledRef.current && request === lifetime.current",
    "const valid = () => enabledRef.current"
  ],
  "pinned-recipient-hidden": [
    '</> : <><p className="recent-focus__message-caption">To {targetName} · {roleName}',
    '</> : <><p className="recent-focus__message-caption">{roleName}'
  ]
}
export default defineConfig({
  ...original,
  plugins: [...(original.plugins ?? []), {
    name: 'focus-read-coverage-loaded-source', enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const before = code, mutation = process.env.AGENTMUX_FOCUS_READ_COVERAGE_MUTATION
      const owner = mutation === 'pinned-recipient-hidden' ? 'FocusMessagePreview' : 'RecentFocusTimeline'
      if (mutation && file === `${root}/apps/desktop/src/renderer/src/components/${owner}.tsx`) {
        const change = changes[mutation]
        if (!change) throw new Error(`Unknown mutation ${mutation}`)
        if (code.split(change[0]).length !== 2) throw new Error(`Missing unique loaded owner for ${mutation}`)
        code = code.replace(change[0], change[1])
      }
      const destination = process.env.AGENTMUX_FOCUS_READ_COVERAGE_LOADED_SOURCE
      if (destination) appendFileSync(destination, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== before ? { mutation } : {}) })}\n`)
      if (code !== before) return { code, map: null }
    }
  }],
  cacheDir: resolve(root, '.tmp/focus-timeline-read-coverage-cache'),
  test: { ...original.test, include: ['apps/desktop/test/focus-timeline-read-coverage.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 }
})
