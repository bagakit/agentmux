import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../../../..')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild')
await esbuild.build({ entryPoints: [resolve(import.meta.dirname, 'owner-server.ts')], outfile: resolve(root, '.tmp/theme-system/owner-server.mjs'),
  bundle: true, platform: 'node', format: 'esm',
  alias: { '@agentmux/client-ui/theme': resolve(root, 'packages/client-ui/dist/theme/index.js') },
  plugins: [{ name: 'workspace-public-exports', setup(build) { build.onResolve({ filter: /^@agentmux\/(core|demand)(\/|$)/ }, args => {
    const parts = args.path.split('/'), packageRoot = resolve(root, 'packages', parts[1])
    const exports = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).exports
    const entry = exports[parts.length === 2 ? '.' : './' + parts.slice(2).join('/')]
    return { path: resolve(packageRoot, typeof entry === 'string' ? entry : entry.import), external: true }
  }) } }, { name: 'isolated-electron-paths', setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'theme-proof' }))
    build.onLoad({ filter: /.*/, namespace: 'theme-proof' }, () => ({ contents: `export const app = { getPath: () => process.env.AGENTMUX_THEME_PROOF_DATA, getAppPath: () => ${JSON.stringify(resolve(root, 'apps/desktop'))} };` }))
  } }] })
