import { defineConfig } from 'vitest/config'
import { appendFileSync,readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import source from '../../desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
export default defineConfig({...source,cacheDir:'.local/cache/arrangement-input-cut',plugins:[{name:'arrangement-loaded-source',enforce:'pre',load(id){const path=id.split('?')[0],output=process.env.ARRANGEMENT_TEST_SOURCE_LOADS;if(output&&/\/(?:packages\/core|apps\/host|apps\/desktop)\/src\/.*\.tsx?$/u.test(path))appendFileSync(output,JSON.stringify({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})+'\n',{mode:0o600});return null}}],test:{...source.test,include:['apps/host/test/arrangement-input-cut.test.ts','apps/host/test/continuous-progress-manual-check.test.ts','apps/host/test/agent-automation-boundaries.test.ts'],fileParallelism:false,passWithNoTests:false,testTimeout:30_000}})
