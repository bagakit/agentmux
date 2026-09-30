import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import original from '../../../../../vitest.config'
const root=resolve(import.meta.dirname,'../../../../..')
export default defineConfig({ ...original,root,esbuild:{jsx:'automatic',jsxImportSource:'react'},cacheDir:resolve(root,'.bagakit/feature-tracker/conversation-input-cards-artifacts/T004/cache'),plugins:[...(original.plugins??[]),{name:'native-reasoning-actual-loaded',enforce:'pre',transform(code,id){
 const file=id.split('?')[0]!;if(!file.startsWith(root+'/apps/desktop/src/')&&!file.startsWith(root+'/packages/core/src/'))return
 const before=code, mutation=process.env.AGENTMUX_NATIVE_REASONING_MUTATION
 if(mutation){
  const replacements:Record<string,[string,string,string]>={
   'detach-caller':['components/SessionPane.tsx','nativeHistoryPage={nativeHistoryPage}','nativeHistoryPage={null}'],
   'drop-snapshot':['lib/session-user-messages.ts','    nativeHistoryPage,','    nativeHistoryPage: null,'],
   'hidden-clear-page':['lib/session-user-messages.ts','    : committed?.nativeHistoryPage ?? null','    : null'],
   'early-full-turn':['components/ConversationNativeReasoning.tsx','const [showTurn, setShowTurn] = useState(false)','const [showTurn, setShowTurn] = useState(true)'],
   'native-string-only':['components/ConversationNativeReasoning.tsx','content={item.contentParts}','content={item.contentParts.filter((part) => part.kind === \'text\').map((part) => part.text).join(\'\\n\')}'],
   'reverse-parts':['components/ConversationNativeReasoning.tsx','content={item.contentParts}','content={[...item.contentParts].reverse()}'],
   'empty-reasoning-selection':['components/ConversationNativeReasoning.tsx',"const records = page.items.filter((item) => item.kind !== 'user-message' &&\n    item.contentParts.some((part) => part.kind === 'reasoning'))",'const records = page.items.filter(() => false)']
  }
  const r=replacements[mutation];if(r&&file===root+'/apps/desktop/src/renderer/src/'+r[0]){if(code.split(r[1]).length!==2)throw new Error('Missing unique target '+mutation);code=code.replace(r[1],r[2])}
 }
 const log=process.env.AGENTMUX_NATIVE_REASONING_LOADED_SOURCE
 if(log)appendFileSync(log,JSON.stringify({path:relative(root,file),originalSHA256:createHash('sha256').update(before).digest('hex'),sha256:createHash('sha256').update(code).digest('hex'),bytes:Buffer.byteLength(code),...(before!==code?{mutation}:{})})+'\n')
 if(code!==before)return {code,map:null}
}}],test:{...original.test,include:['apps/desktop/test/conversation-native-reasoning.integration.test.tsx'],passWithNoTests:false,fileParallelism:false}})
