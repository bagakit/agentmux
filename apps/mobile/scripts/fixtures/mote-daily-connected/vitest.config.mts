import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import owning from '../../../../desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts'

const repository = resolve(import.meta.dirname, '../../../../..')
const mutant = process.env.AGENTMUX_CONNECTED_GOAL_MUTANT ? JSON.parse(process.env.AGENTMUX_CONNECTED_GOAL_MUTANT) as { file: string; before: string; after: string } : undefined
export default defineConfig({
  root: resolve(repository, 'apps/mobile'),
  plugins: [react(), { name: 'connected-goal-source-proof', enforce: 'pre', transform(code, id) {
    const path = id.split('?')[0]!, file = relative(repository, path), proof = process.env.AGENTMUX_CONNECTED_GOAL_PROOF
    if (proof && /^(packages\/|apps\/mobile\/src\/)/.test(file)) appendFileSync(proof, JSON.stringify({ file, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), consumer: 'actual-vite-module' }) + '\n')
    if (mutant && mutant.file === file) {
      if (code.split(mutant.before).length !== 2) throw new Error('One exact loaded mutant anchor is required')
      const changed = code.replace(mutant.before, mutant.after)
      if (proof) appendFileSync(proof, JSON.stringify({ file, consumer: 'actual-loaded-mutant', beforeSha256: createHash('sha256').update(code).digest('hex'), afterSha256: createHash('sha256').update(changed).digest('hex') }) + '\n')
      return changed
    }
  } }],
  resolve: { ...owning.resolve, alias: [{ find: '@agentmux/relay/offer', replacement: resolve(repository, 'packages/relay/src/connection-offer.ts') }, ...owning.resolve!.alias as Array<{ find: RegExp; replacement: string }>], conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  test: { environment: 'happy-dom', include: ['test/connected-goal.test.tsx', 'test/device-workface.test.tsx', 'test/spatial-navigation.test.tsx'], restoreMocks: true, passWithNoTests: false, maxWorkers: 1 }
})
