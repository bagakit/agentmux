import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import source from './mote-presence.config.mts'
import { instrumentGuidance } from './mote-guidance-adoption-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'exact-guidance-source', enforce: 'pre', transform(code, id) {
  const file = relative(root, id.split('?')[0]!), loaded = instrumentGuidance(code, file)
  if (process.env.MOTE_GUIDANCE_TRACE_PATH && (file.startsWith('apps/host/src/') || file.startsWith('packages/core/src/'))) appendFileSync(process.env.MOTE_GUIDANCE_TRACE_PATH, JSON.stringify({ file, hash: createHash('sha256').update(loaded).digest('hex') }) + '\n')
  return loaded === code ? undefined : { code: loaded, map: null }
} }], test: { ...source.test, include: ['apps/host/test/mote-guidance-adoption.test.ts'], passWithNoTests: false, testTimeout: 30000 } })
