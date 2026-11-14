import { appendFileSync, realpathSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.goals-workflow.config.mts'
const root = process.cwd(), bridge = process.env.GOAL_IDENTITIES_BRIDGE === '1'
const mutation = process.env.GOAL_IDENTITIES_MUTANT ? JSON.parse(process.env.GOAL_IDENTITIES_MUTANT) : null
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
const host = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8'))
const hostAliases = Object.entries(host.exports).flatMap(([key, value]) => {
  const file = resolve(root, 'apps/host/src', (value as { import: string }).import.replace(/^\.\/dist\//u, '').replace(/\.js$/u, '.ts'))
  return existsSync(file) ? [{ find: new RegExp('^@agentmux/host/' + key.slice(2) + '$'), replacement: file }] : []
})
export default { ...original, root, define: { ...original.define, __AGENTMUX_WEB_PREVIEW__: String(!bridge) },
  resolve: { ...original.resolve, alias: [
    { find: /^@agentmux\/demand\/relations$/u, replacement: resolve(root, 'packages/demand/src/relations.ts') },
    ...hostAliases,
    ...(original.resolve?.alias as Array<{ find: RegExp; replacement: string }> ?? [])
  ] },
  plugins: [...original.plugins ?? [], { name: 'goal-exact-identities-loaded-owner', enforce: 'pre' as const, transform(source: string, id: string) {
    if (id.includes('?') || !/\.(?:tsx?|m?js)$/u.test(id)) return
    const path = relative(root, id)
    if (!path.startsWith('apps/') && !path.startsWith('packages/')) return
    const originalSHA256 = sha(source)
    if (mutation?.path === path) {
      if (source.split(mutation.anchor).length !== 2) throw Error('One exact original identity owner anchor required: ' + mutation.id)
      source = source.replace(mutation.anchor, () => mutation.replacement)
    }
    if (process.env.GOAL_IDENTITIES_LOADED) {
      const row = { path, realpath: realpathSync(id), originalSHA256, loadedSHA256: sha(source), mutant: mutation?.path === path ? mutation.id : null }
      source = `import { appendFileSync as __identityLoaded } from 'node:fs'; __identityLoaded(${JSON.stringify(process.env.GOAL_IDENTITIES_LOADED)}, ${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
    }
    return source
  } }],
  test: { ...original.test, root, include: bridge ? ['apps/desktop/test/collaboration-identity-bridge.test.tsx'] : [
    'apps/desktop/test/goal-team-identities.test.tsx', 'apps/desktop/test/collaboration-identities.test.tsx',
    'packages/demand/test/relations.test.ts', 'apps/host/test/goal-supervisor-identity.test.ts'
  ], passWithNoTests: false, testTimeout: 20000, maxWorkers: 1, fileParallelism: false }
}
