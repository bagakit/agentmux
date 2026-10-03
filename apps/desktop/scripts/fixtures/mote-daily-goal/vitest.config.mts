import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'
const repository = resolve(import.meta.dirname, '../../../../..')
const mutant = process.env.AGENTMUX_DAILY_GOAL_MUTANT ? JSON.parse(process.env.AGENTMUX_DAILY_GOAL_MUTANT) as { file: string; before: string; after: string } : undefined
export default defineConfig({ ...owning, plugins: [{ name: 'daily-goal-loaded-source', enforce: 'pre', transform(code, id) {
  const proof = process.env.AGENTMUX_DAILY_GOAL_PROOF, file = relative(repository, id.split('?')[0]!)
  if (proof && /^(packages\/core\/src\/|packages\/demand\/|apps\/desktop\/src\/)/.test(file)) appendFileSync(proof, JSON.stringify({ file, sha256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), consumer: 'actual-vite-module' }) + '\n')
  if (mutant && file === mutant.file) {
    if (code.split(mutant.before).length !== 2) throw new Error('One exact loaded mutant anchor is required')
    const changed = code.replace(mutant.before, mutant.after)
    if (proof) appendFileSync(proof, JSON.stringify({ file, consumer: 'actual-loaded-mutant', beforeSha256: createHash('sha256').update(code).digest('hex'), afterSha256: createHash('sha256').update(changed).digest('hex') }) + '\n')
    return changed
  }
} }], test: { ...owning.test, env: { AGENTMUX_DAILY_GOAL_REPOSITORY: repository }, include: ['test/mote-daily-goal.test.tsx', 'test/mote-daily-goal-owner.test.ts', 'test/continuous-progress-product.test.tsx', 'test/continuous-progress-loop-manager.test.ts', 'test/continuous-progress-loop-store.test.ts', 'test/goals-durable-adapter.test.ts','test/agent-schedules.test.ts','test/calendar-schedule-control.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
