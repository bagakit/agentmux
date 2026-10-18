import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.AGENTMUX_CHANNEL_ENTRY_MUTANT
const mutations: Record<string, { path: string; before: string; after: string }> = {
  'wrong-settings-destination': { path: 'apps/desktop/src/renderer/src/App.tsx', before: "section: presentation?.section ?? 'overview', channelOrigin", after: "section: 'lark', channelOrigin" },
  'invent-create-control': { path: 'apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx', before: "const creationUnsupported = connection?.capabilities?.roomCreation === false", after: 'const creationUnsupported = false' },
  'disconnect-leaf-presentation': { path: 'apps/desktop/src/renderer/src/components/settings/settings-catalog.ts', before: 'return matches.length === 1 ? matches[0]! : null', after: 'return null' },
  'hide-exact-target-gap': { path: 'apps/desktop/src/renderer/src/components/settings/ExternalConnectionsSettings.tsx', before: "if (view !== 'loading') setRouteIssue(", after: 'if (false) setRouteIssue(' }
}
if (mutant && !mutations[mutant]) throw Error('Unknown Channel entry mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/channel-entry'),
  resolve: { alias: [{ find: /^@agentmux\/connectors$/, replacement: resolve(root, 'packages/connectors/src/index.ts') }] },
  plugins: [{ name: 'loaded-channel-entry', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if ((!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/connectors/src/')) || !/\.tsx?$/u.test(path)) return
    const selected = mutant ? mutations[mutant]! : undefined, before = source
    if (selected?.path === path) {
      if (source.split(selected.before).length !== 2) throw Error('Channel entry mutation anchor changed')
      source = source.replace(selected.before, selected.after)
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_CHANNEL_ENTRY_LOADED) appendFileSync(process.env.AGENTMUX_CHANNEL_ENTRY_LOADED, JSON.stringify({ path, originalSHA256: sha(before), loadedSHA256: sha(source), mutation: before === source ? null : mutant }) + '\n')
    return before === source ? undefined : { code: source, map: null }
  } }], test: { ...original.test, fileParallelism: false, passWithNoTests: false, include: ['apps/desktop/test/channel-entry-consumer.test.tsx'] }
})
