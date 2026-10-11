import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'
import { radixOverlayAliases } from '../scripts/radix-overlay-aliases'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../package.json', import.meta.url))
const reactAliases = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-dom/server']
  .map(name => ({ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: require.resolve(name) }))

// Match the actual Renderer primitive stacks and client-ui browser source exports.
export default defineConfig({ ...original, resolve: { conditions: ['browser', 'module', 'import'],
  alias: [...reactAliases, ...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement }))] },
  test: { ...original.test, passWithNoTests: false, maxWorkers: 2 } })
