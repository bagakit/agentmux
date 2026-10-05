import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../demand-activity/vitest.config.mts'
const repository = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...original, plugins: [...(original.plugins ?? []), { name: 'collaboration-mobile-source', enforce: 'pre', transform(_code, id) {
  const file = relative(repository, id.split('?')[0]!), proof = process.env.AGENTMUX_DAILY_GOAL_PROOF
  if (proof && file.startsWith('apps/mobile/src/')) appendFileSync(proof, JSON.stringify({ file, sha256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), consumer: 'actual-vite-module' }) + '\n')
} }], test: { ...original.test, include: ['test/mote-daily-goal.test.tsx', '../../packages/demand/test/**/*.test.ts'], passWithNoTests: false } })
