import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { relative,resolve } from 'node:path'
import { instrumentOrigin } from './helpers/executor-origin-mutations.mjs'
const root=resolve(import.meta.dirname,'../../..')
export default defineConfig({ ...source, plugins:[...(source.plugins??[]),{name:'actual-original-invocation',enforce:'pre',transform(code,id){const loaded=instrumentOrigin(code,relative(root,id.split('?')[0]!), 'vitest');return loaded===code?undefined:{code:loaded,map:null}}}], test: { ...source.test, include: [
  'packages/core/test/executor-launch-origin.test.ts',
  'packages/core/test/provider-executor-history.test.ts'
], fileParallelism: false, maxWorkers: 1, testTimeout: 120000, hookTimeout: 30000, passWithNoTests: false } })
