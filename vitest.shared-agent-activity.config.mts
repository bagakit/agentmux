import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.config'
const root=import.meta.dirname
export default defineConfig({...original,root,plugins:[...(original.plugins??[]),{name:'readonly-source-binding',enforce:'pre',transform(code,id){if(id.startsWith(root+'/apps/desktop/src/'))appendFileSync(process.env.AGENT_ACTIVITY_LOADED!,JSON.stringify({path:relative(root,id),sha256:createHash('sha256').update(code).digest('hex')})+'\n')}}],cacheDir:root+'/.tmp/agent-activity-cache',test:{...original.test,include:['apps/desktop/test/shared-agent-activity-presentations.test.tsx'],passWithNoTests:false,maxWorkers:1,fileParallelism:false,testTimeout:15000}})
