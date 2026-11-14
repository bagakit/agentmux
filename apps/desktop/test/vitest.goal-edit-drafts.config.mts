import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import original from './vitest.goals-workflow.config.mts'
import { goalEditProofScope } from './helpers/goal-edit-proof-scopes.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const coreSources = new Map<string, string>()
if (process.env.GOAL_EDIT_CORE_BASE) {
  const base = process.env.GOAL_EDIT_CORE_BASE
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'packages/core/src'], { cwd: repository, encoding: 'utf8' }).trim().split('\n').filter(path => /\.(ts|json)$/u.test(path))
  const bytes = execFileSync('git', ['cat-file', '--batch'], { cwd: repository, input: paths.map(path => `${base}:${path}\n`).join(''), maxBuffer: 64 * 1024 * 1024 })
  let offset = 0
  for (const path of paths) {
    const end = bytes.indexOf(10, offset), size = Number(bytes.subarray(offset, end).toString().split(' ')[2])
    if (!Number.isSafeInteger(size)) throw Error('Committed Core source is unavailable: ' + path)
    coreSources.set(path, bytes.subarray(end + 1, end + 1 + size).toString()); offset = end + 2 + size
  }
}
const mutant = process.env.GOAL_EDIT_MUTANT ? JSON.parse(process.env.GOAL_EDIT_MUTANT) : null
const owners = new Set(['apps/desktop/src/renderer/src/lib/goal-edit-drafts.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx', 'apps/desktop/src/renderer/src/components/GoalDetail.tsx',
  'apps/desktop/src/renderer/src/components/GoalProperties.tsx', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts',
  'apps/desktop/src/renderer/src/lib/launcher-state.ts', 'apps/desktop/src/main/workbench-user-state.ts',
  'apps/host/src/goals.ts', 'packages/demand/src/demand-store.ts'])
export default { ...original, plugins: [...(original.plugins ?? []), {
  name: 'goal-edit-loaded-owner', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(repository, id.split('?')[0]!)
    if (process.env.GOAL_EDIT_CORE_BASE && path.startsWith('packages/core/src/') && /\.(ts|json)$/u.test(path)) {
      source = coreSources.get(path)!
      if (source === undefined) throw Error('Missing committed Core source: ' + path)
      if (process.env.GOAL_EDIT_CORE_LOADED) appendFileSync(process.env.GOAL_EDIT_CORE_LOADED, JSON.stringify({ path, sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
      return source
    }
    if (!owners.has(path)) return
    const hash = (value: string) => createHash('sha256').update(value).digest('hex'), originalSHA256 = hash(source)
    const originalScopeSHA256 = hash(goalEditProofScope(path, source))
    if (mutant?.path === path) {
      if (source.split(mutant.anchor).length !== 2) throw Error('One current mutation anchor is required: ' + mutant.id)
      source = source.replace(mutant.anchor, () => mutant.replacement)
    }
    if (['store.ts', 'desktop-user-state.ts', 'launcher-state.ts'].some(name => path.endsWith('/' + name))) source = source.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
    const output = process.env.GOAL_EDIT_LOADED
    if (!output) return source
    const row = { path, originalSHA256, originalScopeSHA256, loadedSHA256: hash(source), ...(mutant?.path === path ? { mutant: mutant.id } : {}) }
    appendFileSync(output, '')
    return `import { appendFileSync as __goalEditLoaded } from 'node:fs'; __goalEditLoaded(${JSON.stringify(output)}, ${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { ...original.test, include: ['apps/desktop/test/goal-edit-drafts-product.test.tsx'],
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 60_000, hookTimeout: 60_000 } }
