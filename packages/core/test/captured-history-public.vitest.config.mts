import { defineConfig } from 'vitest/config'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative, basename } from 'node:path'
const root=resolve(import.meta.dirname,'../../..')
export default defineConfig({
 root,cacheDir:resolve(root,'.local/cache/captured-history-public-vite',process.env.AGENTMUX_CAPTURED_MUTATION?basename(process.env.AGENTMUX_CAPTURED_MUTATION):'base'),
 plugins:[{name:'captured-history-exact-source',enforce:'pre',load(id){
   const file=id.split('?')[0]!
   if(!file.startsWith(root+'/packages/core/src/')||!file.endsWith('.ts'))return null
   let source=readFileSync(file,'utf8'),originalSHA256=createHash('sha256').update(source).digest('hex')
   if(process.env.AGENTMUX_CAPTURED_MUTATION){
     const mutation=JSON.parse(readFileSync(process.env.AGENTMUX_CAPTURED_MUTATION,'utf8'))
     if(relative(root,file)===mutation.file){if(source.split(mutation.from).length!==2)throw new Error('Mutation must identify one exact source owner');source=source.replace(mutation.from,mutation.to)}
   }
   if(process.env.AGENTMUX_CAPTURED_LOADED)appendFileSync(process.env.AGENTMUX_CAPTURED_LOADED,JSON.stringify({path:relative(root,file),originalSHA256,sha256:createHash('sha256').update(source).digest('hex')})+'\n')
   return source
 }}],
 test:{include:['packages/core/test/captured-history-public.test.ts','packages/core/test/captured-history-durability.test.ts','packages/core/test/session-timeline.test.ts','packages/core/test/session-timeline-retention.test.ts','packages/core/test/session-timeline-processing-cost.test.ts','packages/core/test/agent-session-store.test.ts','packages/core/test/agent-session-store-cas.test.ts','packages/core/test/session-context-reference.test.ts','packages/core/test/session-history-query.test.ts','packages/core/test/agent-session-history-cli.test.ts'],setupFiles:[resolve(root,'vitest.setup.ts')],passWithNoTests:false,maxWorkers:1,fileParallelism:false,testTimeout:60000,hookTimeout:30000}
})
