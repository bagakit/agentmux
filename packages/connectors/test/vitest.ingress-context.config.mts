import { defineConfig } from 'vitest/config'
import native from './vitest.channel-history.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
export default defineConfig({ ...native, cacheDir: native.cacheDir + '-position', plugins: [...native.plugins!, {
  name: 'original-context-position-retirement', enforce: 'pre', transform(original, id) {
    const path = relative(native.root!, id.split('?')[0]!)
    if (path !== 'packages/connectors/src/ingress-context.ts') return
    let loaded = original
    const mutation = process.env.CHANNEL_POSITION_MUTANT
    if (mutation) {
      if (mutation !== 'retirement-disconnect') throw Error('Unknown position mutation')
      const anchor = 'if (alreadyIncluded) this.database.prepare('
      if (original.split(anchor).length !== 2) throw Error('Original retirement mutation must load once')
      loaded = original.replace(anchor, 'if (false && alreadyIncluded) this.database.prepare(')
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.CHANNEL_POSITION_LOADED) appendFileSync(process.env.CHANNEL_POSITION_LOADED, JSON.stringify({ path,
      originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(mutation ? { mutation } : {}) }) + '\n')
    return loaded === original ? undefined : loaded
  }
}], test: { ...native.test, include: ['packages/connectors/test/ingress-context.test.ts'] } })
