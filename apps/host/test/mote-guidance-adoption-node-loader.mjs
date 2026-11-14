import './mote-presence-node-loader.mjs'
import { registerHooks } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { instrumentGuidance } from './mote-guidance-adoption-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const file = relative(root, fileURLToPath(url)), code = String(result.source), loaded = instrumentGuidance(code, file)
  if (process.env.MOTE_GUIDANCE_TRACE_PATH && (file.startsWith('apps/host/src/') || file.startsWith('packages/core/src/'))) appendFileSync(process.env.MOTE_GUIDANCE_TRACE_PATH, JSON.stringify({ file, hash: createHash('sha256').update(loaded).digest('hex') }) + '\n')
  return loaded === code ? result : { ...result, source: loaded }
} })
