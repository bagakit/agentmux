import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from '../../mobile/test/mote-settings-placement.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const variants: Record<string, { file: string; before: string; after: string }> = {
  'wait-for-choices': { file: 'apps/desktop/src/renderer/src/components/MoteQuickMode.tsx', before: 'void readMoteQuickDefaults(scope, false).then(source => {', after: 'void readMoteQuickDefaults(scope).then(source => {' },
  'replace-original-baseline': { file: 'apps/desktop/src/renderer/src/components/MoteQuickMode.tsx', before: '{ ...previous, choices: mergeMoteQuickChoices(previous.choices, discovery.choices!) }', after: '{ ...discovery, pending: previous.pending }' },
  'hide-source-failure': { file: 'apps/desktop/src/renderer/src/components/MoteQuickMode.tsx', before: '{saved?.choices?.issues ? <div', after: '{false ? <div' }
}
const mutation = process.env.DESKTOP_SETTINGS_MUTATION
if (mutation && !variants[mutation]) throw Error('Unknown Desktop settings mutation')
export default defineConfig({ ...source, cacheDir: resolve(root, '.tmp/desktop-settings-robustness', mutation ?? 'baseline'),
  plugins: [{ name: 'desktop-settings-actual-consumer', enforce: 'pre', transform(original, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!['apps/desktop/src/renderer/src/components/MoteQuickMode.tsx', 'apps/desktop/src/renderer/src/lib/mote-quick-mode.ts'].includes(file)) return
    let loaded = original
    const variant = mutation && variants[mutation]
    if (variant && variant.file === file) {
      if (loaded.split(variant.before).length !== 2) throw Error('One exact Desktop settings source anchor is required')
      loaded = loaded.replace(variant.before, variant.after)
    }
    const report = process.env.DESKTOP_SETTINGS_LOADED
    if (!report) return loaded === original ? undefined : { code: loaded, map: null }
    const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
    const record = { file, rawSHA256: sha(readFileSync(resolve(root, file), 'utf8')), sourceSHA256: sha(original), loadedSHA256: sha(loaded), mutation: loaded === original ? null : mutation }
    return { code: "import { appendFileSync as __desktopSettingsLoaded } from 'node:fs'; __desktopSettingsLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(record) + '\n') + ');\n' + loaded, map: null }
  } }, ...(source.plugins ?? [])],
  test: { ...source.test, include: ['apps/desktop/test/mote-settings-save.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')], testTimeout: 15000 }
})
