import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from './conversation-process-detail.config.mts'
const owner = 'packages/client-ui/src/lib/use-conversation-record-layout.ts'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-deferred-boundary', plugins: [...base.plugins ?? [], {
  name: 'deferred-boundary-proof', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!, path = relative(process.cwd(), file)
    if (path !== owner) return
    const from = "|| record.source.kind === 'native' && record.rawId === options?.beforeRecordId"
    if (source.split(from).length !== 2) throw Error('Missing unique deferred boundary owner')
    const code = process.env.AGENTMUX_DEFERRED_BOUNDARY_MUTATION === '1' ? source.replace(from, from.replace('source.kind', 'original.kind')) : source
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_LAZY_BOUNDARY_LOADED) appendFileSync(process.env.AGENTMUX_LAZY_BOUNDARY_LOADED,
      JSON.stringify({ path, fileSHA256: hash(readFileSync(file)), originalSHA256: hash(source), sha256: hash(code), mutation: code !== source }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/client-ui/test/conversation-deferred-boundary.test.tsx'], passWithNoTests: false } })
