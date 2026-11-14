import { defineConfig } from 'vitest/config'
import original from './a2a-resumed-inbox.config.mts'
import { relative } from 'node:path'
import { instrument } from '../../../apps/host/test/mote-executor-rollover-mutations.mjs'
export default defineConfig({ ...original, plugins: [{ name: 'original-executor-rollover', enforce: 'pre', transform(source,id) {
  const loaded=instrument(source,relative(original.root!,id.split('?')[0]!))
  return loaded===source?null:{code:loaded,map:null}
} }, ...(original.plugins??[])], test: { ...original.test,
  include: ['apps/host/test/mote-executor-rollover.test.ts'], testTimeout: 45_000, maxWorkers: 1, passWithNoTests: false } })
