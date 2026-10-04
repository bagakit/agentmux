import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'
const repository = resolve(import.meta.dirname, '../../../../..')
const mutant = process.env.AGENTMUX_GOAL_CONTENT_MUTANT ? JSON.parse(process.env.AGENTMUX_GOAL_CONTENT_MUTANT) as { file: string; before: string; after: string } : undefined
export default defineConfig({ ...owning, cacheDir: resolve(repository, '.tmp/goal-content/vite'), plugins: [{ name: 'goal-content-loaded-source', enforce: 'pre', transform(code, id) {
  const proof = process.env.AGENTMUX_GOAL_CONTENT_PROOF, path = id.split('?')[0]!, file = relative(repository, path)
  if (proof && /^(packages\/(core|demand)\/src\/|apps\/desktop\/src\/)/.test(file)) appendFileSync(proof, JSON.stringify({ file, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), consumer: 'actual-source-module' }) + '\n')
  if (mutant && file === mutant.file) {
    if (code.split(mutant.before).length !== 2) throw new Error('One exact loaded mutation anchor required')
    const changed = code.replace(mutant.before, mutant.after)
    if (proof) appendFileSync(proof, JSON.stringify({ file, consumer: 'loaded-mutant', sha256: createHash('sha256').update(changed).digest('hex') }) + '\n')
    return changed
  }
} }], test: { ...owning.test, root: repository, env: { AGENTMUX_DAILY_GOAL_REPOSITORY: repository }, include: ['packages/demand/test/content-references.test.ts', 'apps/desktop/test/mote-daily-goal.test.tsx', 'apps/desktop/test/mote-goal-content-references.test.tsx'], exclude: ['**/node_modules/**'], passWithNoTests: false, maxWorkers: 1 } })
