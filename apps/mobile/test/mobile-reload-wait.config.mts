import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mobile-web.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.MOBILE_RELOAD_WAIT_MUTANT
const variants: Record<string, { file: string; before: string; after: string }> = {
  'ignore-observation-cancel': { file: 'apps/mobile/src/mobile-web/update-safety.ts', before: 'preparePageReload(abort.signal)', after: 'preparePageReload()' },
  'duplicate-write-observers': { file: 'apps/mobile/src/recovery/device-workface.ts', before: 'if (!wait || wait.tail !== this.tail)', after: 'if (true)' }
}
if (mutant && !variants[mutant]) throw Error('Unknown reload wait mutation')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), { name: 'loaded-reload-wait', enforce: 'pre', transform(original, id) {
  const file = relative(root, id.split('?')[0]!), variant = mutant ? variants[mutant] : undefined
  if (!Object.values(variants).some(value => value.file === file)) return
  let code = original
  if (variant?.file === file) {
    if (original.split(variant.before).length !== 2) throw Error('Reload wait mutation must match exactly once')
    code = original.replace(variant.before, variant.after)
  }
  if (process.env.MOBILE_RELOAD_WAIT_LOADED) {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.MOBILE_RELOAD_WAIT_LOADED, JSON.stringify({ file, originalSHA256: sha(original), loadedSHA256: sha(code), mutation: variant?.file === file ? mutant : null }) + '\n')
  }
  return code === original ? undefined : { code, map: null }
} }], test: { ...base.test, include: ['test/mobile-reload-wait.test.tsx'] } })
