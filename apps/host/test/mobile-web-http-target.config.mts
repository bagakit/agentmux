import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './mobile-web.config.mts'
const root = resolve(import.meta.dirname, '../../..'), owner = 'apps/host/src/mobile-assets-owner.ts'
const mutant = process.env.MOBILE_WEB_HTTP_TARGET_MUTANT
if (mutant && mutant !== 'remove-target-catch') throw Error('Unknown HTTP target mutant')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...original, plugins: [{ name: 'mobile-http-target-proof', enforce: 'pre', transform(before, id) {
  if (id.split('?')[0] !== resolve(root, owner)) return
  const anchor = 'catch { mobileResourceUnavailable(request, response, 400); return }'
  if (before.split(anchor).length !== 2) throw Error('One actual owner URL catch must be loaded')
  const source = mutant ? before.replace(anchor, 'catch (error) { throw error }') : before
  const path = process.env.MOBILE_WEB_HTTP_TARGET_LOADED
  if (!path) throw Error('Original HTTP target loaded receipt is required')
  const row = { path: owner, originalSHA256: hash(before), loadedSHA256: hash(source), mutant: mutant ?? null }
  return "import { appendFileSync as __targetProof } from 'node:fs'; __targetProof(" + JSON.stringify(path) +
    ',JSON.stringify({... ' + JSON.stringify(row) + ',pid:process.pid})+"\\n");\n' + source
} }], test: { ...original.test, include: ['apps/host/test/mobile-web-http-target.test.ts'] } })
