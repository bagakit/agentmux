import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import owning from '../note-restore/vitest.owning.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
const aliases = ['identity', 'capsule'].flatMap(pkg => {
  const p = JSON.parse(readFileSync(resolve(root, 'packages', pkg, 'package.json'), 'utf8'))
  return Object.entries(p.exports).map(([key, value]: [string, any]) => ({
    find: key === '.' ? p.name : p.name + key.slice(1),
    replacement: resolve(root, 'packages', pkg, value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  }))
}).sort((a, b) => b.find.length - a.find.length)
export default { ...owning,
  ssr: { resolve: { conditions: ['node'] } },
  resolve: { ...owning.resolve, conditions: ['node'], alias: [...aliases, ...(owning.resolve?.alias as any[] ?? []).filter(entry => entry.find !== '@agentmux/core'),
    { find: '@agentmux/core', replacement: resolve(import.meta.dirname, 'core-observation.ts') },
    { find: '../../host/dist/macos-service.js', replacement: resolve(root, 'apps/host/src/macos-service.ts') }] },
  plugins: [{ name: 'installed-terminal-owner', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    const mutation = process.env.INSTALL_TERMINAL_MUTANT ? JSON.parse(process.env.INSTALL_TERMINAL_MUTANT) : null
    let code = source
    if (mutation?.file === file) {
      if (source.split(mutation.before).length !== 2) throw new Error('Unique actual production mutation anchor required')
      code = source.replace(mutation.before, mutation.after)
    }
    if (process.env.INSTALL_TERMINAL_LOADED && /^(apps\/desktop\/(src|scripts)|packages\/core\/src)\//.test(file))
      appendFileSync(process.env.INSTALL_TERMINAL_LOADED, JSON.stringify({ file, sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? null : { code, map: null }
  } }, ...(owning.plugins ?? [])],
  test: { ...owning.test, include: ['apps/desktop/test/package-install-workbench-continuity.test.ts'], hookTimeout: 30_000, testTimeout: 20_000 }
}
