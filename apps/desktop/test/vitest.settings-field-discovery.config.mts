import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sourceConfig from '../scripts/fixtures/settings-overview/vitest.config.mts'

const clientRoot = resolve(import.meta.dirname, '../../../packages/client-ui')
const clientExports = JSON.parse(readFileSync(resolve(clientRoot, 'package.json'), 'utf8')).exports
const clientAliases = Object.entries(clientExports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
  .map(([key, target]) => ({ find: new RegExp(`^@agentmux/client-ui${key === '.' ? '' : key.slice(1).replace('*', '(.*)')}$`),
    replacement: resolve(clientRoot, typeof target === 'string' ? target.replace('*', '$1') : (target as { types: string }).types.replace('*', '$1')) }))

// Transform the actual production module, leaving the shared source tree untouched.
const mutations = {
  fieldDiscovery: ['settings/settings-catalog.ts', '|| (module as SettingsModule).searchTargets?.some(target => targetText(target).includes(normalized))', '|| false'],
  explicitTarget: ['SettingsPanel.tsx', 'onChoose={chooseSection}', 'onChoose={() => {}}'],
  originalReading: ['SettingsPanel.tsx', 'setActive(origin.section); restoreReading.current = origin.scrollTop', 'restoreReading.current = null'],
  originalSearchScope: ['SettingsPanel.tsx', 'if (!searchOrigin.current) searchOrigin.current =', 'searchOrigin.current ='],
  imeEscape: ['SettingsPanel.tsx', ' || isImeOwnedKeyboardEvent(event)', ''],
  noPremount: ['SettingsPanel.tsx', "initialSection === 'overview' ? [] : [initialSection]", 'settingsModules.map(module => module.id)'],
  exactTarget: ['SettingsPanel.tsx', 'node.dataset.settingsField === destination.target', 'true'],
  actualContribution: ['settings/modules/general.tsx', "id: 'crash-log'", "id: 'disconnected-crash-log'"],
  revealTarget: ['SettingsPanel.tsx', "target.dataset.settingsSearchHighlight = ''", 'delete target.dataset.settingsSearchHighlight'],
  resultSelection: ['SettingsPanel.tsx', "value={showResults ? '' : active}", 'value={active}']
} as const
const mutation = process.env.SETTINGS_FIELD_MUTANT
if (mutation && !Object.hasOwn(mutations, mutation)) throw new Error(`Unknown Settings mutant: ${mutation}`)

export default defineConfig({
  ...sourceConfig,
  resolve: { ...sourceConfig.resolve, alias: [...clientAliases, ...(sourceConfig.resolve!.alias as { find: RegExp; replacement: string }[])] },
  plugins: mutation ? [{ name: 'settings-field-actual-source-mutation', enforce: 'pre', transform(code, id) {
    const [suffix, before, after] = mutations[mutation as keyof typeof mutations]
    if (!id.endsWith(`/components/${suffix}`)) return
    const hits = code.split(before).length - 1
    if (hits !== 1) throw new Error(`Expected one real source hit for ${mutation}; got ${hits}`)
    const changed = code.replace(before, after)
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    console.log('SETTINGS_FIELD_MUTANT_HIT ' + JSON.stringify({ mutation, suffix, hits, originalSha256: sha(code), mutatedSha256: sha(changed) }))
    return changed
  } }] : [],
  test: { ...sourceConfig.test, include: ['apps/desktop/test/settings-field-discovery.test.tsx'] }
})
