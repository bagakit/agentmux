import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.AGENTMUX_DISCORD_SETTINGS_MUTANT
const mutations: Record<string, { path: string; before: string; after: string }> = {
  'wrong-native-adapter': { path: 'apps/desktop/src/renderer/src/components/settings/modules/discord.tsx', before: 'channel="discord"', after: 'channel="lark"' },
  'expose-token-as-reference': { path: 'apps/desktop/src/renderer/src/components/settings/ExternalConnectionsSettings.tsx', before: 'input.connection.credentialRef = credential.credentialRef', after: 'input.connection.credentialRef = secret' },
  'hide-explicit-check': { path: 'packages/connectors/src/connection-host.ts', before: 'observation: { ...result.observation, authentication: observation.authentication }', after: 'observation: result.observation' }
}
if (mutant && !mutations[mutant]) throw Error('Unknown Discord Settings source mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/discord-settings'),
  resolve: { alias: [{ find: /^@agentmux\/connectors$/, replacement: resolve(root, 'packages/connectors/src/index.ts') }] },
  plugins: [{ name: 'discord-settings-loaded-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if ((!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/connectors/src/')) || !/\.tsx?$/u.test(path)) return
    const selected = mutant ? mutations[mutant]! : undefined, before = source
    if (selected?.path === path) { if (source.split(selected.before).length !== 2) throw Error('Discord Settings mutation anchor changed'); source = source.replace(selected.before, selected.after) }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_DISCORD_SETTINGS_LOADED) appendFileSync(process.env.AGENTMUX_DISCORD_SETTINGS_LOADED, JSON.stringify({ path, originalSHA256: sha(before), loadedSHA256: sha(source), mutation: before === source ? null : mutant }) + '\n')
    return before === source ? undefined : { code: source, map: null }
  } }], test: { ...original.test, fileParallelism: false, passWithNoTests: false, include: ['apps/desktop/test/discord-settings-consumer.test.tsx'] }
})
