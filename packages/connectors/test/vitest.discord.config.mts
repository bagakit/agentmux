import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/discord-channel'), plugins: [{ name: 'native-discord-product-source', enforce: 'pre',
  transform(code, id) {
    const mutant = process.env.DISCORD_MUTANT
    const changes = {
      transport: ['adapters/discord/index.ts', 'await input.receive({ raw: witness.raw, transportProof: witness }, () => undefined)', 'await Promise.resolve()'],
      publication: ['adapters/discord/render.ts', '+ text }] }]', '+ \"Lost public reply\" }] }]'],
      identity: ['adapters/discord/protocol.ts', 'userId: discordId(author.id)', 'userId: discordId(botId)']
    } as const
    const change = changes[mutant as keyof typeof changes]
    if (!change || !id.endsWith(change[0])) return
    if (code.split(change[1]).length !== 2) throw Error('The exact Discord mutant was not loaded once')
    process.stderr.write('DISCORD_LOADED_MUTANT:' + mutant + '\n')
    return code.replace(change[1], change[2])
  },
  resolveId(source, importer) {
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    if (source.startsWith('@agentmux/core/')) {
      const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
      const entry = exports['./' + source.slice('@agentmux/core/'.length)]?.import as string | undefined
      if (entry?.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  }
}], test: { include: ['packages/connectors/test/discord-channel.test.ts'], environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
