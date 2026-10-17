import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/renderer/src/lib/session-conversation-window.ts'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-coverage-batch', plugins: [...base.plugins ?? [], {
  name: 'original-coverage-batch', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== owner && path !== 'packages/client-ui/src/lib/use-conversation-view.ts') return
    const mutation = process.env.AGENTMUX_COVERAGE_BATCH_MUTATION
    const edits: Record<string, [string, string]> = {
      'unbounded-batch': ['    coverageDemand.current.remaining--', '    void 0'],
      'repaint-refill': ['const coverageDemand = useRef({ key, duration: coverageDuration, remaining: 2 })', 'const coverageDemand = { current: { key, duration: coverageDuration, remaining: 2 } }'],
      'ignore-source-share': ['Math.max(1, sources)', '1'],
      'ignore-shrink': ['coverageDuration < previous.duration ? 0', 'coverageDuration < previous.duration ? previous.remaining'],
      'tiny-frozen-packets': ['...(cursor ? { cursor, limit: 100 } : {})', '...(cursor ? { cursor } : {})'],
      'ignore-request-limit': ["limit === undefined ? {} : { limit }", '{}']
    }
    if (mutation && !edits[mutation]) throw new Error('Unknown coverage batch mutation')
    let code = source
    const edit = mutation ? edits[mutation] : undefined
    const target = ['ignore-request-limit', 'tiny-frozen-packets'].includes(mutation ?? '') ? 'packages/client-ui/src/lib/use-conversation-view.ts' : owner
    if (edit && path === target) {
      if (source.split(edit[0]).length !== 2) throw new Error('Coverage batch mutation must match exactly once')
      code = source.replace(edit[0], edit[1])
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_COVERAGE_BATCH_LOADED) appendFileSync(process.env.AGENTMUX_COVERAGE_BATCH_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), mutation: source === code ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-coverage-batch.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
