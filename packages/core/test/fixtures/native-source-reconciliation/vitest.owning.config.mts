import {createHash} from 'node:crypto'
import {appendFileSync} from 'node:fs'
import {relative,resolve} from 'node:path'
import {defineConfig} from 'vitest/config'
const root=resolve(import.meta.dirname,'../../../../..')
const changes: Record<string,Array<[string,string,string]>>={
 'skip-current':[['packages/core/src/client.ts',"const wantsCurrent = !options.nativeSource && (handle === undefined || purpose === 'observe' || options.refreshNativeSource === true)",'const wantsCurrent = handle === undefined']],
 'split-page-source':[['packages/core/src/client.ts',".filter(resource => !resource.controller.signal.aborted && resource.binding?.transient)",'.filter(() => false)']],
 'retain-old-fence':[['packages/core/src/client.ts',"transient = false\n        assertWitness = undefined\n        return true","return true"]],
 'ignore-pid':[['packages/core/src/client.ts','run.pid !== firstRun.pid','false']],
 'ignore-run':[['packages/core/src/client.ts','!sameRun(current.run, expected.run)','false']],
 'ignore-handle':[
  ['packages/core/src/client.ts','(!sameNativeHandle(current.nativeHandle, retained) && !sameNativeHandle(current.nativeHandle, handle))','false'],
  ['packages/core/src/client.ts','(!sameNativeHandle(value.nativeHandle, retained) && !sameNativeHandle(value.nativeHandle, handle))','false']
 ]
}
export default defineConfig({root,cacheDir:resolve(root,'.local/cache/native-source-reconciliation'),plugins:[{name:'native-current-loaded',enforce:'pre',transform(code,id){
 const path=relative(root,id.split('?')[0]!)
 if(!path.startsWith('packages/core/src/') || !/\.ts$/u.test(path))return
 const before=code,mutation=process.env.AMX_CURRENT_MUTATION
 if(mutation){const edits=changes[mutation];if(!edits)throw new Error('Unknown mutation '+mutation)
  for(const [target,anchor,replacement] of edits){if(path===target){if(code.split(anchor).length!==2)throw new Error('Mutation anchor not unique '+mutation);code=code.replace(anchor,replacement)}}
 }
 if(process.env.AMX_CURRENT_LOADED)appendFileSync(process.env.AMX_CURRENT_LOADED,JSON.stringify({path,originalSHA256:createHash('sha256').update(before).digest('hex'),sha256:createHash('sha256').update(code).digest('hex'),...(before!==code?{mutation}:{})})+'\n')
if(before!==code)return {code,map:null}
}}],test:{include:['packages/core/test/native-source-reconciliation.test.ts'],passWithNoTests:false,fileParallelism:false,maxWorkers:1,testTimeout:20000,hookTimeout:15000}})
