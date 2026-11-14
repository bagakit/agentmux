import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import source from './mote-supervision.config.mts'

const file = 'apps/host/src/mote-dialogue.ts'
const variants = {
  'repeat-source-read': ['const pending = sources.get(sourceKey)', 'const pending = undefined'],
  'omit-source-host': ['JSON.stringify([link.origin.hostId, link.origin.messageId])', 'JSON.stringify([link.origin.messageId])'],
  'retain-source-between-requests': ['const sources = new Map<string, Promise<DispatchObservation>>()',
    'const sources = ((globalThis as any).__moteSourceReads ??= new Map<string, Promise<DispatchObservation>>())'],
  'borrow-sibling-validation': ['return observeMoteWorkSource(link, observed)',
    'return observeMoteWorkSource({ ...link, origin: { ...link.origin, threadId: observed.dispatch.threadId } }, observed)']
} as const
const mutation = process.env.MOTE_SOURCE_READ_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Choose an exact source-read mutation')
export default defineConfig({ ...source, cacheDir: resolve(source.root!, '.local/mote-supervision-closure/cache', mutation ?? 'baseline'),
  plugins: [{ name: 'mote-source-read-evaluated-owner', enforce: 'pre', transform(original, id) {
    if (relative(source.root!, id.split('?')[0]!) !== file) return
    let loaded = original
    if (mutation) {
      const [before, after] = variants[mutation]
      if (loaded.split(before).length !== 2) throw Error('One exact current source-read anchor is required')
      loaded = loaded.replace(before, after)
    }
    const trace = process.env.MOTE_SOURCE_READ_LOADED
    if (trace) {
      const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
      const row = { path: file, rawSHA256: sha(readFileSync(resolve(source.root!, file), 'utf8')),
        originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: mutation ?? null }
      loaded = "import { appendFileSync as __sourceReadLoaded } from 'node:fs'; __sourceReadLoaded(" + JSON.stringify(trace) + ', ' +
        JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded
    }
    return loaded === original ? undefined : { code: loaded, map: null }
  } }, ...source.plugins!], test: { ...source.test, include: ['packages/core/test/mote-supervision-source-read.test.ts'], testTimeout: 60000, hookTimeout: 15000 } })
