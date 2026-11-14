import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = new URL('../../../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('packages/core/package.json', root), 'utf8'))
// This candidate consumes Core source directly, never a shared root dist or a skipped freshness guard.
const alias = Object.entries(manifest.exports).map(([name, value]: [string, any]) => ({
  find: new RegExp('^' + ('@agentmux/core' + (name === '.' ? '' : name.slice(1))).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
  replacement: fileURLToPath(new URL('packages/core/' + value.types.replace('./dist/', 'src/').replace('.d.ts', '.ts'), root))
}))
export default { root: fileURLToPath(root), resolve: { alias }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [{ name: 'extension-check-source-mutation', enforce: 'pre' as const, transform(code: string, id: string) {
  if (process.env.EXTENSIONS_ONLINE_UNIT_MUTATION !== 'hide-update-candidate' || !id.endsWith('/apps/desktop/src/main/browser-profile-extensions.ts')) return
  const target = 'compareExtensionVersions(observed.candidate.version, record.version) > 0'
  if (code.split(target).length !== 2) throw Error('The exact extension update production comparison was not loaded')
  const changed = code.replace(target, 'false'), sha = (value: string) => createHash('sha256').update(value).digest('hex')
  console.log(JSON.stringify({ schema: 'agentmux.extension-update.loaded-mutation.v1', productionSource: id, originalSha256: sha(code), loadedSha256: sha(changed), target }))
  return { code: changed, map: null }
} }], test: {
  include: ['apps/desktop/test/browser-profile-extension-online.test.ts', 'apps/desktop/test/browser-profile-extensions.test.ts'],
  maxWorkers: 1, cache: false, setupFiles: [fileURLToPath(new URL('vitest.setup.ts', root))]
} }
