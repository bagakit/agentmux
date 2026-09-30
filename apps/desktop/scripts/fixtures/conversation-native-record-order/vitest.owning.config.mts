import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync,existsSync,appendFileSync } from 'node:fs'
import original from '../../../../../vitest.config'
const root=resolve(import.meta.dirname,'../../../../..')
const pkg=JSON.parse(readFileSync(resolve(root,'packages/core/package.json'),'utf8'))
const aliases=Object.entries(pkg.exports).flatMap(([name,value])=>{const source=resolve(root,'packages/core/src/'+(value as {import:string}).import.replace('./dist/','').replace(/\.js$/u,'.ts'));const spec=name==='.'?'@agentmux/core':'@agentmux/core'+name.slice(1);return existsSync(source)?[{find:new RegExp('^'+spec.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'),replacement:source}]:[]})
export default defineConfig({...original,root,esbuild:{jsx:'automatic',jsxImportSource:'react'},resolve:{alias:[...aliases,{find:'react',replacement:resolve(root,'apps/desktop/node_modules/react')},{find:'react-dom',replacement:resolve(root,'apps/desktop/node_modules/react-dom')}]},cacheDir:resolve(root,'.bagakit/feature-tracker/conversation-input-cards-artifacts/T007/cache'),plugins:[{name:'native-record-order-actual-loaded',enforce:'pre',transform(code,id){
 const file=id.split('?')[0]!;if(!file.startsWith(root+'/apps/desktop/src/')&&!file.startsWith(root+'/packages/core/src/'))return
 const before=code, mutation=process.env.AGENTMUX_NATIVE_ORDER_MUTATION
 const replacements:Record<string,[string,string,string]>={
  'drop-native-thread':['components/ActivityView.tsx','{nativeHistoryPage ? <ConversationNativeThread','{false ? <ConversationNativeThread'],
  'timestamp-native-order':['components/ConversationNativeThread.tsx','const records = page.items.filter((item) => {','const records = [...page.items].sort((a,b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).filter((item) => {'],
  'drop-native-user':['components/ConversationNativeThread.tsx','if (seen.has(item.id)) return false',"if (item.kind === 'user-message' || seen.has(item.id)) return false"],
  'reverse-native-parts':['components/ConversationNativeThread.tsx','content={item.contentParts}','content={[...item.contentParts].reverse()}'],
  'empty-observation-axis':['components/ActivityView.tsx','unifiedItems.length > 0 ? <Ruler','true ? <Ruler'],
  'drop-native-continue':['components/ConversationNativeThread.tsx','user && onContinue ?','false ?'],
  'leak-future-prefix':['lib/session-continuation.ts','page.items.slice(0, index + 1)','page.items.slice(0)'],
  'repeat-native-id':['components/ConversationNativeThread.tsx','if (seen.has(item.id)) return false','if (false) return false']
 }
 const r=mutation?replacements[mutation]:undefined
 if(r&&file===root+'/apps/desktop/src/renderer/src/'+r[0]){if(code.split(r[1]).length!==2)throw Error('Missing unique mutation '+mutation);code=code.replace(r[1],r[2])}
 const log=process.env.AGENTMUX_NATIVE_ORDER_LOADED
 if(log)appendFileSync(log,JSON.stringify({path:relative(root,file),originalSHA256:createHash('sha256').update(before).digest('hex'),sha256:createHash('sha256').update(code).digest('hex'),bytes:Buffer.byteLength(code),...(before!==code?{mutation}:{})})+'\n')
 if(code!==before)return {code,map:null}
}}],test:{...original.test,globalSetup:[],include:['apps/desktop/test/conversation-native-record-order.integration.test.tsx'],passWithNoTests:false,fileParallelism:false}})
