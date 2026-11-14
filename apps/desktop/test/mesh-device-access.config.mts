import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const changedKey = process.env.AGENTMUX_DEVICE_ACCESS_MUTANT === 'changed-key'
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'mesh-device-fixture', enforce: 'pre', resolveId: installedDependency,
    transform(code, id) {
      if (!changedKey || !id.endsWith('/mesh-device-partition.ts')) return
      const source = '[offer.serverId, offer.daemonPublicKeyB64]'
      if (code.split(source).length !== 2) throw Error('Partition mutation no longer binds to the endpoint identity')
      return { code: code.replace(source, '[offer.serverId]'), map: null }
    } }],
  test: { include: ['apps/desktop/test/mesh-device-access.test.tsx'], environment: 'happy-dom', testTimeout: 15000, fileParallelism: false } })
