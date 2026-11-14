import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = new URL('../../../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('packages/core/package.json', root), 'utf8'))
// This candidate consumes Core source directly, never a shared root dist or a skipped freshness guard.
const alias = Object.entries(manifest.exports).map(([name, value]: [string, any]) => ({
  find: new RegExp('^' + ('@agentmux/core' + (name === '.' ? '' : name.slice(1))).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
  replacement: fileURLToPath(new URL('packages/core/' + value.types.replace('./dist/', 'src/').replace('.d.ts', '.ts'), root))
}))
export default { root: fileURLToPath(root), resolve: { alias }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: {
  include: ['apps/desktop/test/browser-profile-extension-online.test.ts', 'apps/desktop/test/browser-profile-extensions.test.ts'],
  maxWorkers: 1, cache: false, setupFiles: [fileURLToPath(new URL('vitest.setup.ts', root))]
} }
