import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../..')
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const path = fileURLToPath(url), original = String(result.source)
  let served = original
  if (process.env.PORTABLE_HOST_MUTANT === 'mix-runtime-versions' && path === resolve(root, 'scripts/package-dependencies.mjs')) {
    const anchor = 'relative(dirname(link), packagePath(dependency.packageId))'
    if (original.split(anchor).length !== 2) throw Error('The materializer mutation must match its one original dependency link')
    served = original.replace(anchor, 'relative(dirname(link), packagePath(closure.packages.find(value => value.name === dependency.name).id))')
  }
  if (process.env.PORTABLE_HOST_TRACE && (path.startsWith(process.env.PORTABLE_HOST_ARTIFACT + '/') || path === resolve(root, 'scripts/package-dependencies.mjs'))) {
    const hash = value => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.PORTABLE_HOST_TRACE, JSON.stringify({ path: path.startsWith(root + '/') ? relative(root, path) : path,
      originalSHA256: hash(original), loadedSHA256: hash(served), ...(served === original ? {} : { mutation: 'mix-runtime-versions' }) }) + '\n')
  }
  return served === original ? result : { ...result, source: served }
} })
