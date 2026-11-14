import {defineConfig} from 'vitest/config'
import {relative,resolve} from 'node:path'
import original from './mote-initialization.config.mts'
import {transformMoteWorkCycleSource} from './mote-work-cycle-mutations.mjs'
const root=resolve(import.meta.dirname,'../../..')
export default defineConfig({...original,plugins:[...(original.plugins??[]),{name:'original-mote-work-cycle',enforce:'pre',transform(source,id){const loaded=transformMoteWorkCycleSource(source,relative(root,id.split('?')[0]!), 'vitest');return loaded===source?null:{code:loaded,map:null}}}],test:{...original.test,include:process.env.MOTE_CYCLE_ORIGINAL?['packages/core/test/mote-supervision.test.ts','apps/host/test/mote-presence.test.ts']:['apps/desktop/test/mote-work-cycle.test.tsx'],...(process.env.MOTE_CYCLE_ORIGINAL?{testNamePattern:'actual source CLI reads the original first-task report|current Main collects a formal Goal report|wire results reject detached observations|a supervision heartbeat freezes|a retained supervision heartbeat body'}:{}),maxWorkers:1,fileParallelism:false,testTimeout:60000,passWithNoTests:false}})
