import { defineConfig } from 'vitest/config'
import base from './vitest.continuity-projection.config.mts'
// GC belongs to the private test fork; never enable it in an installed Renderer.
export default defineConfig({...base,test:{...base.test,include:['apps/desktop/test/focus-speaker-retention.test.tsx'],pool:'forks',poolOptions:{forks:{execArgv:['--expose-gc']}},testTimeout:15000}})
