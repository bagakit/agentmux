import { defineConfig } from 'vitest/config'
import base from './vitest.conversation-unified-consumers.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const root = process.cwd(), mutation = process.env.AGENTMUX_A2A_READING_MUTATION
export default defineConfig({ ...base, cacheDir: '.tmp/a2a-input-reading-boundary/cache', plugins: [...base.plugins ?? [], {
  name: 'original-input-boundary', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file !== 'packages/client-ui/src/lib/conversation-input-source.ts') return
    const needle = mutation === 'ignore-captured-body' ? '!capturedExternalBody' : "key?.kind === 'message' && !capturedExternalBody ? 'wire' : 'body'"
    if (mutation && source.split(needle).length !== 2) throw Error('Reading boundary mutation anchor is not unique')
    const code = mutation ? source.replace(needle, mutation === 'ignore-captured-body' ? 'true' : "'body'") : source
    if (process.env.AGENTMUX_A2A_READING_LOADED) appendFileSync(process.env.AGENTMUX_A2A_READING_LOADED, JSON.stringify({ file,
      source: createHash('sha256').update(source).digest('hex'), consumed: createHash('sha256').update(code).digest('hex'), mutated: Boolean(mutation) }) + '\n')
    return code
  }
}], test: { ...base.test, include: ['apps/desktop/test/a2a-input-reading-boundary.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
