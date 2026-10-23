import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(resolve(root, 'packages/connectors/package.json'))
const variants = {
  'foreign-host-route': ['apps/desktop/src/main/runtime-controller.ts', 'client = this.configuredClient(hostId)', "client = this.configuredClient('owner-b')"],
  'pending-target-lost': ['apps/desktop/src/renderer/src/lib/manual-connection-intent.ts', 'result[key] = { channel: raw.channel, target, draft,', 'result[key] = { channel: raw.channel, target: null, draft,']
  , 'destination-fence-lost': ['packages/core/src/hosted-client.ts', 'runtimeFence: expectedOwner ?? fence()', 'runtimeFence: fence()']
  , 'default-owner-lost': ['apps/desktop/src/main/connection-host-ipc.ts', 'runtime.connectionHostingTarget()', "runtime.connectionHostingTarget('owner-b')"]
  , 'metadata-reader-scope-lost': ['apps/desktop/src/preload/index.ts', 'if (live && value?.watchId === watchId) listener(value.change)', 'if (live) listener(value.change)']
  , 'metadata-renderer-lifetime-lost': ['apps/desktop/src/main/ipc.ts', 'controlBridge.dispose(); releaseHtmlPreviews(); channelMetadata?.releaseReaders()', 'controlBridge.dispose(); releaseHtmlPreviews()']
} as const
const mutation = process.env.MANUAL_OWNER_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown manual-owner mutation')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, plugins: [{ name: 'manual-owner-consumer-source', enforce: 'pre',
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
    let loaded = original
    const selected = mutation && variants[mutation]
    if (selected && selected[0] === path) {
      if (original.split(selected[1]).length !== 2) throw Error('Owning mutation expression is not unique')
      loaded = original.replace(selected[1], selected[2])
    }
    if (!process.env.MANUAL_OWNER_LOADED) return loaded === original ? undefined : loaded
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    const marker = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(loaded === original ? {} : { mutation }) }
    return { code: "import { appendFileSync as __manualOwnerLoaded } from 'node:fs'; __manualOwnerLoaded(" + JSON.stringify(process.env.MANUAL_OWNER_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { include: ['apps/desktop/test/manual-connection-owner.test.tsx'], environment: 'node', fileParallelism: false, passWithNoTests: false, testTimeout: 35_000, hookTimeout: 20_000 } })
