import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
registerHooks({ load(url, context, next) {
  const loaded = next(url, context)
  if (!process.env.MANUAL_OWNER_LOADED || !url.startsWith('file:') || loaded.source == null) return loaded
  const path = relative(root, fileURLToPath(url))
  if (!path.startsWith('packages/core/dist/') && path !== 'packages/core/bin/amux') return loaded
  const hash = createHash('sha256').update(loaded.source).digest('hex')
  appendFileSync(process.env.MANUAL_OWNER_LOADED, JSON.stringify({ path, originalSHA256: hash, loadedSHA256: hash, producer: 'compiled-cli-module' }) + '\n')
  return loaded
} })
