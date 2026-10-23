import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.CHANNEL_JOIN_MUTANT, marker = process.env.CHANNEL_JOIN_LOADED
const mutations = {
  audience: ['packages/connectors/src/publication-host.ts', 'active = this.options.bindings.listActive()', 'active = this.options.bindings.listActive().slice(0, 1)'],
  echo: ['packages/connectors/src/publication-content.ts', 'if (external && external.connectionId === binding.connectionId', 'if (false && external && external.connectionId === binding.connectionId']
} as const
if (mutation && !(mutation in mutations)) throw Error('Unknown cross-channel join mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/channel-native-join'), plugins: [{ name: 'actual-cross-channel-owner', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!), selected = mutations[mutation as keyof typeof mutations]
    if (!/^packages\/(?:core|connectors)\/src\/.+\.ts$/u.test(path) && path !== 'packages/connectors/src/connection-services.ts') return
    let code = original
    if (selected?.[0] === path) {
      if (code.split(selected[1]).length !== 2) throw Error('Cross-channel join mutation anchor missing or ambiguous')
      code = code.replace(selected[1], selected[2])
    }
    if (!marker) return code === original ? undefined : { code, map: null }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(code), ...(code !== original ? { mutation } : {}) })
    return { code: "import { appendFileSync as __markNativeJoin } from 'node:fs'; __markNativeJoin(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + code, map: null }
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
}], test: { include: ['packages/connectors/test/cross-channel-conversation-consumer.test.ts'], environment: 'node',
  globalSetup: [], passWithNoTests: false, fileParallelism: false, testTimeout: 30_000 } })
