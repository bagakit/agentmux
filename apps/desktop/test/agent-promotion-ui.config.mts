import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'
const mutations = {
  'settings-save': ['components/settings/TopicDirectorySettingsPane.tsx', 'promotion: { ...current.promotion, enabled }', 'promotion: { ...current.promotion, enabled: true }'],
  'new-disabled': ['components/AgentPromotionDialog.tsx', 'const blocked = !receipt && allowed !== true', 'const blocked = false'],
  'continue-disabled': ['components/AgentPromotionDialog.tsx', 'const blocked = !receipt && allowed !== true', 'const blocked = allowed !== true'],
  'original-intent': ['components/AgentPromotionDialog.tsx', 'operationId: original.operationId', 'operationId: mintObjectId()'],
  'destination': ['components/AgentPromotionDialog.tsx', "target: club.target })", "target: { ...club.target, spaceId: 'unrelated-club' } })"],
  'dismissed-intent': ['lib/use-agent-promotion.tsx', 'initialIntent={intents.current.get(selectedKey!) ?? null}', 'initialIntent={null}'],
  'discovery-gap': ['components/AgentPromotionDialog.tsx', '[previous.issue, result.discovery!.issue]', '[result.discovery!.issue]'],
  'late-intent': ['lib/use-agent-promotion.tsx', 'intents.current.delete(key)', 'intents.current.clear()'],
  'header-menu': ['components/AgentRegionHeader.tsx', 'onPromote={promotion.open ? () => { handoffFocus.current = true; promotion.open?.() } : undefined}', 'onPromote={undefined}']
} as const
const identityModule = '\0agent-promotion:identity-runtime-source'
let identity: ReturnType<typeof bundleIdentityRuntime> | undefined
const mutation = process.env.AGENT_PROMOTION_UI_MUTATION as keyof typeof mutations | undefined
if (mutation && !mutations[mutation]) throw Error('Unknown Agent Promotion UI mutation')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: [{ find: /^@agentmux\/identity\/runtime-source$/u, replacement: identityModule }, ...aliases] },
  plugins: [{ name: 'agent-promotion-ui-source', enforce: 'pre', resolveId(source, importer) { return source === identityModule ? source : installedDependency(source, importer) },
    async load(id) { if (id === identityModule) { const { source } = await (identity ??= bundleIdentityRuntime()); return 'export const identityRuntimeSource = ' + JSON.stringify(source) + ';' } },
    transform(original, id) {
      const file = relative(root, id.split('?')[0]!)
      if (!file.startsWith('apps/desktop/src/')) return
      let loaded = original
      if (mutation) {
        const [suffix, before, after] = mutations[mutation]
        if (file.endsWith('/' + suffix)) {
          if (original.split(before).length !== 2) throw Error('Promotion UI mutation anchor is not unique: ' + suffix)
          loaded = original.replace(before, after)
          console.log('AGENT_PROMOTION_UI_MUTATION_LOADED ' + mutation)
        }
      }
      if (process.env.AGENT_PROMOTION_UI_LOADED) appendFileSync(process.env.AGENT_PROMOTION_UI_LOADED, JSON.stringify({ file, original: createHash('sha256').update(original).digest('hex'), loaded: createHash('sha256').update(loaded).digest('hex') }) + '\n')
      return loaded === original ? undefined : { code: loaded, map: null }
    } }],
  test: { include: ['apps/desktop/test/agent-promotion-ui.test.tsx', 'apps/desktop/test/agent-promotion-settings.test.ts'], setupFiles: ['vitest.setup.ts'], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 }
})
