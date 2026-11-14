import { defineConfig } from 'vitest/config'
import { appendFileSync,readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import isolation from '../scripts/fixtures/agent-schedules/vitest.config.mjs'
import base from '../scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts'
export default defineConfig({...base,cacheDir:'../../../.local/cache/arrangement-ui',resolve:{alias:[{find:'@agentmux/identity/runtime-source',replacement:fileURLToPath(new URL('../../../packages/identity/dist/runtime-source.js',import.meta.url))},...base.resolve!.alias as any[]]},plugins:[{name:'arrangement-ui-loaded-source',enforce:'pre',load(id){const path=id.split('?')[0],output=process.env.ARRANGEMENT_TEST_SOURCE_LOADS;if(output&&/\/(?:packages\/core|apps\/desktop|apps\/host)\/src\/.*\.tsx?$/u.test(path))appendFileSync(output,JSON.stringify({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})+'\n',{mode:0o600});return null}}],test:{...base.test,setupFiles:[...base.test!.setupFiles as string[],...isolation.test.setupFiles],include:['test/arrangement-input-cut.test.tsx','test/arrangement-ipc-input-cut.test.ts'],maxWorkers:1,passWithNoTests:false,testTimeout:20_000}})
