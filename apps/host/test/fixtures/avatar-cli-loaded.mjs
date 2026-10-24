import { registerHooks } from 'node:module'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(import.meta.dirname, '../../../..'), hash = value => createHash('sha256').update(value).digest('hex')
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (process.env.MOTE_AVATAR_CLI_LOADED && url.startsWith('file:') && result.source != null) {
    const file = fileURLToPath(url), path = relative(root, file)
    if (path.startsWith('packages/core/')) appendFileSync(process.env.MOTE_AVATAR_CLI_LOADED, JSON.stringify({ path,
      originalSHA256: hash(readFileSync(file)), loadedSHA256: hash(result.source), mode: 'compiled' }) + '\n')
  }
  return result
} })
