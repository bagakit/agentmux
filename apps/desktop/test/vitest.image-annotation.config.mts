import { mergeConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import base from '../../../vitest.config.ts'
import { radixOverlayAliases } from '../scripts/radix-overlay-aliases.ts'

// The real Renderer shares Dialog's dismissal/focus owners across its menus and dialogs.
// Source, private mutations and restored-source tests must consume that same library stack.
const require = createRequire(new URL('../package.json', import.meta.url))
export default mergeConfig(base, { resolve: { alias: { ...radixOverlayAliases,
  react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) }, dedupe: ['react', 'react-dom'] } })
