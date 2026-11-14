import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './mote-settings-placement.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  desktop: { file: 'apps/desktop/src/renderer/src/lib/mote-main-action.ts', before: ", includeChoices: 'executors' as const", after: '' },
  mobile: { file: 'apps/mobile/src/navigation/MobileMoteMainActions.tsx', before: ", includeChoices: 'executors' as const", after: '' }
}
const mutation = process.env.MOTE_MAIN_DISCOVERY_MUTATION
if (mutation && !Object.hasOwn(variants, mutation)) throw Error('Unknown Main discovery mutation')
export default defineConfig({ ...source, cacheDir: resolve(root, '.tmp/mote-main-executor-discovery', mutation ?? 'baseline'),
  plugins: [{ name: 'original-main-discovery-consumers', enforce: 'pre', transform(original, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!Object.values(variants).some(value => value.file === file)) return
    const variant = mutation ? variants[mutation as keyof typeof variants] : null
    let loaded = original
    if (variant?.file === file) {
      if (original.split(variant.before).length !== 2) throw Error('One original Main discovery selector required')
      loaded = original.replace(variant.before, variant.after)
    }
    const report = process.env.MOBILE_SETTINGS_LOADED
    if (!report) return loaded === original ? undefined : { code: loaded, map: null }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const record = { file, rawSHA256: sha(readFileSync(resolve(root, file), 'utf8')), sourceSHA256: sha(original), loadedSHA256: sha(loaded), mutation: loaded === original ? null : mutation }
    return { code: "import { appendFileSync as __mainDiscoveryLoaded } from 'node:fs'; __mainDiscoveryLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(record) + '\n') + ');\n' + loaded, map: null }
  } }, ...(source.plugins ?? [])],
  test: { ...source.test, include: ['apps/mobile/test/mote-main-executor-discovery.test.tsx', 'apps/mobile/test/mote-presence-settings.test.tsx'] }
})
