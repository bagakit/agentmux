import{defineConfig}from'vitest/config'
import{prepareHookTransactionTargets}from'../../../packages/core/test/fixtures/hook-transaction/source-targets.mjs'
import{readFileSync,appendFileSync}from'node:fs'
import{resolve,relative}from'node:path'
import{createHash}from'node:crypto'
await prepareHookTransactionTargets()
const base=(await import('./vitest.mote-context.config.mts')).default
const root=resolve(import.meta.dirname,'../../..'),mutation=process.env.CONTINUITY_PROJECTION_INVERSE?JSON.parse(readFileSync(process.env.CONTINUITY_PROJECTION_INVERSE,'utf8')):undefined
export default defineConfig({...base,cacheDir:resolve(root,'.cache/continuity-projection'),plugins:[{
 name:'continuity-projection-source-proof',enforce:'pre',transform(original,id){
  const file=relative(root,id.split('?')[0]!)
  if((!file.startsWith('apps/')&&!file.startsWith('packages/'))||file.includes('/node_modules/'))return
  let source=original
  if(mutation?.file===file){if(source.split(mutation.before).length!==2)throw Error('Inverse must match exactly one production owner: '+mutation.name);source=source.replace(mutation.before,mutation.after)}
  if(process.env.CONTINUITY_PROJECTION_LOADED)appendFileSync(process.env.CONTINUITY_PROJECTION_LOADED,JSON.stringify({path:file,moduleId:id,sourceSHA256:createHash('sha256').update(original).digest('hex'),loadedSHA256:createHash('sha256').update(source).digest('hex'),...(file.startsWith('packages/core/bin/')?{assetModuleSource:original}:{}),...(source===original?{}:{mutation:mutation.name})})+'\n')
  return source===original?undefined:{code:source,map:null}
 }}],test:{...base.test,include:['apps/desktop/test/continuity-projection.test.tsx','apps/desktop/test/session-admission-wire.test.tsx','apps/desktop/test/session-continuity-live-projection.test.ts','apps/desktop/test/session-frontend-recovery.test.ts'],passWithNoTests:false,testTimeout:30000,testNamePattern:process.env.CONTINUITY_PROJECTION_PATTERN||undefined}})
