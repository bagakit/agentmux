import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(resolve(root, 'packages/connectors/package.json'))
const variants = {
  'owner-callback-disconnected': ['packages/connectors/src/channel-metadata.ts', 'if (!closed) listener(change)', 'if (false) listener(change)'],
  'public-stream-disconnected': ['packages/core/src/public-rpc-service.ts', "emit({ type: 'change', data: parseChannelMetadataChange(change) })", 'undefined'],
  'main-ipc-disconnected': ['apps/desktop/src/main/connector-ipc.ts', 'options.metadata!.publish(event.data)', 'void event.data'],
  'listener-release-disconnected': ['packages/connectors/src/channel-metadata.ts', 'closed = true; release()', 'closed = true'],
  'runtime-fence-disconnected': ['packages/core/src/public-rpc-service.ts', 'if (!context.runtimeFence) return', 'if (true) return'],
  'observation-blocks-business': ['apps/desktop/src/main/connector-ipc.ts', 'void observeMetadata().catch', 'await observeMetadata().catch'],
  'opening-reload-disconnected': ['apps/desktop/src/renderer/src/lib/use-connector-room-name.ts', "if (state === 'ready') load(false)", 'if (false) load(false)']
} as const
const mutation = process.env.METADATA_WATCH_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown metadata watch owning mutation')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, plugins: [{ name: 'actual-metadata-watch-owner', enforce: 'pre',
  resolveId(source, importer) {
    if (source === '@larksuiteoapi/node-sdk' || source === '@discordjs/rest') return require.resolve(source)
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    if (source.startsWith('@agentmux/core/')) {
      const entry = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports['./' + source.slice('@agentmux/core/'.length)]?.import
      if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const dist = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (dist) return resolve(root, 'packages', dist[1]!, 'src', dist[2]! + '.ts')
  },
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/(?:host|desktop)|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    const selected = mutation && variants[mutation]
    let served = original
    if (selected && selected[0] === path) {
      if (original.split(selected[1]).length !== 2) throw Error('The exact metadata watch mutation anchor must be unique')
      served = original.replace(selected[1], selected[2])
    }
    if (!process.env.METADATA_WATCH_TRACE) return original === served ? undefined : served
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const marker = { path, originalSHA256: hash(original), loadedSHA256: hash(served), ...(served !== original ? { mutation } : {}) }
    return { code: "import { appendFileSync as __metadataWatchLoad } from 'node:fs'; __metadataWatchLoad(" + JSON.stringify(process.env.METADATA_WATCH_TRACE) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + served, map: null }
  }
}], test: { include: ['apps/desktop/test/channel-metadata-watch.test.tsx', 'packages/core/test/channel-metadata-contract.test.ts', 'apps/desktop/test/channel-metadata-bridge.test.tsx'], environment: 'node', fileParallelism: false, passWithNoTests: false, testTimeout: 25_000, hookTimeout: 15_000 } })
