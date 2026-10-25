import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const mutation = process.env.AGENTMUX_SPATIAL_TEST_MUTATION
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'source-dependencies', enforce: 'pre', resolveId: installedDependency },
    { name: 'spatial-ack-production-mutation', enforce: 'pre', transform(source, id) {
      const change = mutation === 'drop-pending' && id.endsWith('/renderer/src/store.ts')
        ? ['const pendingLauncher=surface?.kind', 'const pendingLauncher=false && surface?.kind']
        : mutation === 'borrow-incoming' && id.endsWith('/lib/desktop-spatial-state.ts')
          ? ['apply(state, baseline);', 'apply(state, state.graph);'] : null
      if (!change) return
      if (source.split(change[0]!).length !== 2) throw new Error('The exact production mutation anchor must occur once')
      return source.replace(change[0]!, change[1]!)
    } }],
  test: { include: ['apps/desktop/test/launcher-spatial-ack.test.ts', 'apps/desktop/test/desktop-spatial-latest-intent.test.ts'],
    maxWorkers: 1, passWithNoTests: false, testTimeout: 20000 } })
