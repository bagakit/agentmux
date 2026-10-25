import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const { build } = createRequire(resolve(root, 'apps/host/package.json'))('esbuild')
const mutation = process.env.DESKTOP_CONNECTION_MUTANT
if (mutation && !['omit-cold-namespace', 'drop-destination-fence', 'drop-business-caller', 'profile-runtime-match'].includes(mutation)) throw Error('Unknown Desktop connection owner mutation')
const artifact = resolve(root, 'apps/desktop/.tmp/connection-host', mutation ?? 'normal'), directory = resolve(artifact, 'out/main')
mkdirSync(directory, { recursive: true })
const entry = resolve(directory, 'desktop-host.mjs'), host = resolve(directory, 'agentmux-host.js')
await build({ entryPoints: [resolve(root, 'apps/desktop/src/main/desktop-host.ts')], outfile: entry,
  bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
// The same Desktop out/main + resources layout, with the actual small compiled
// Node entry and original protocol helper. No replacement embedding or symlink.
copyFileSync(resolve(root, 'apps/host/dist/index.js'), host)
mkdirSync(resolve(artifact, 'resources/bin'), { recursive: true })
copyFileSync(resolve(root, 'apps/host/resources/bin/agentmux-workspace-move'), resolve(artifact, 'resources/bin/agentmux-workspace-move'))
const variants = {
  'profile-runtime-match': [resolve(root, 'apps/desktop/src/main/runtime-controller.ts'), "owner?.availability === 'connected' && owner.runtimeId === source.runtimeId", "owner?.availability === 'connected'"],
  'omit-cold-namespace': [entry, 'AGENTMUX_CONNECTOR_DIRECTORY: configuration.connectorDirectory', 'AGENTMUX_CONNECTOR_DIRECTORY: void 0'],
  'drop-business-caller': [resolve(root, 'apps/desktop/src/main/runtime-controller.ts'), 'callOriginalDesktopHost(original.client, method, params, context, original.expectedOwner)', 'callOriginalDesktopHost(original.client, method, params, {}, original.expectedOwner)'],
  'drop-destination-fence': [resolve(root, 'apps/desktop/src/main/runtime-controller.ts'), 'callOriginalDesktopHost(original.client, method, params, context, original.expectedOwner)', 'callOriginalDesktopHost(original.client, method, params, context)']
} as const
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, plugins: [{
  name: 'actual-desktop-connection-host', enforce: 'pre',
  resolveId(source, importer) {
    if (importer && source.startsWith('.') && resolve(dirname(importer), source) === resolve(root, 'apps/desktop/src/main/desktop-host.js')) return entry
  },
  transform(original, id) {
    const path = id.split('?')[0]!
    if (path !== entry && path !== resolve(root, 'apps/desktop/src/main/runtime-controller.ts')) return
    let loaded = original
    const selected = mutation && variants[mutation as keyof typeof variants]
    if (selected && selected[0] === path) {
      if (original.split(selected[1]).length !== 2) throw Error('The actual loaded Desktop owner mutation must match exactly once')
      loaded = original.replace(selected[1], selected[2])
    }
    const report = process.env.DESKTOP_CONNECTION_LOADED
    if (!report) return loaded === original ? undefined : { code: loaded, map: null }
    const marker = { path: relative(root, path), diskSHA256: sha(readFileSync(path, 'utf8')), originalSHA256: sha(original), loadedSHA256: sha(loaded), ...(loaded === original ? {} : { mutation }) }
    return { code: "import { appendFileSync as __desktopConnectionLoaded } from 'node:fs'; __desktopConnectionLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { include: ['apps/desktop/test/channel-profile-runtime.test.ts', 'apps/desktop/test/desktop-connection-host.test.ts', 'apps/desktop/test/desktop-host-startup.test.ts'],
  setupFiles: [resolve(root, 'vitest.setup.ts')], environment: 'node', fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 35_000, hookTimeout: 20_000 } })
