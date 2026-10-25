import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { aliases, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'
import providerConfig from '../../../packages/core/test/fixtures/provider-contract/vitest.config.mts'
const hostExports = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports
const hostAliases = Object.entries(hostExports).map(([key, value]) => ({
  find: new RegExp('^@agentmux/host' + (key === '.' ? '' : key.slice(1)) + '$'),
  replacement: resolve(root, 'apps/host', (typeof value === 'string' ? value : (value as { import: string }).import)
    .replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))
const localRequire = createRequire(resolve(root, 'apps/desktop/package.json'))
const reactAliases = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => ({
  find: new RegExp('^' + name + '$'), replacement: localRequire.resolve(name)
}))
export default defineConfig({ ...providerConfig,
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: [...reactAliases, ...hostAliases, ...aliases] },
  plugins: providerConfig.plugins,
  test: { ...providerConfig.test, include: ['apps/desktop/test/settings-yolo-core-consumer.test.tsx'], setupFiles: ['vitest.setup.ts'], testTimeout: 20000 }
})
