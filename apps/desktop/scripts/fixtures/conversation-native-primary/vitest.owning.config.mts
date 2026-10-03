import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync,existsSync,appendFileSync } from 'node:fs'
import original from '../../../../../vitest.config'
const root=resolve(import.meta.dirname,'../../../../..')
const pkg=JSON.parse(readFileSync(resolve(root,'packages/core/package.json'),'utf8'))
const aliases=Object.entries(pkg.exports).flatMap(([name,value])=>{const source=resolve(root,'packages/core/src/'+(value as {import:string}).import.replace('./dist/','').replace(/\.js$/u,'.ts'));const spec=name==='.'?'@agentmux/core':'@agentmux/core'+name.slice(1);return existsSync(source)?[{find:new RegExp('^'+spec.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'),replacement:source}]:[]})
export default defineConfig({
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },...original,root,esbuild:{jsx:'automatic',jsxImportSource:'react'},resolve:{conditions:['browser','import','default'],alias:[...aliases,{find:'react',replacement:resolve(root,'apps/desktop/node_modules/react')},{find:'react-dom',replacement:resolve(root,'apps/desktop/node_modules/react-dom')}]},cacheDir:resolve(root,'.tmp/native-primary-cache'),plugins:[{name:'native-record-order-actual-loaded',enforce:'pre',transform(code,id){
 const file=id.split('?')[0]!;if(!file.startsWith(root+'/apps/desktop/src/')&&!(file.startsWith(root+'/packages/core/src/')||file.startsWith(root+'/packages/client-ui/src/')))return
 const before=code, mutation=process.env.AGENTMUX_NATIVE_PRIMARY_MUTATION
 if (file===resolve(root,'apps/desktop/src/renderer/src/components/ActivityView.tsx') && mutation==='reading-tail-front') {
   const start=code.indexOf('      {nativeHistoryPage ? <ConversationNativeThread'),end=code.indexOf('      {showWorkingIndicator',start)
   if(start<0||end<0)throw Error('Missing exact NativeThread tail')
   const block=code.slice(start,end);code=code.slice(0,start)+code.slice(end)
   const insert=code.indexOf('      {placed.length > 0 ?');if(insert<0)throw Error('Missing source boundary');code=code.slice(0,insert)+block+code.slice(insert)
 }
 const replacements:Record<string,[string,string,string]>={
  'drop-native-tail-signature':['apps/desktop/src/renderer/src/components/ActivityView.tsx','const nativeTail = page?.items.at(-1)','const nativeTail = undefined as typeof page extends null ? never : import("@agentmux/core").AgentSessionHistoryItem | undefined'],
  'force-follow-reader':['apps/desktop/src/renderer/src/components/ActivityView.tsx','if (decision.scrollToBottom) pinToBottom()','if (true) pinToBottom()'],
  'process-open-default':['apps/desktop/src/renderer/src/components/NativeProcessObservation.tsx','export function NativeProcessObservation({ id, items, renderRecord }: ConversationProcessProps) {\n  const [expanded, setExpanded] = useState(false)','export function NativeProcessObservation({ id, items, renderRecord }: ConversationProcessProps) {\n  const [expanded, setExpanded] = useState(true)'],
  'forget-read-body':['apps/desktop/src/renderer/src/components/workflow/WorkflowCard.tsx','expanded || readOnce ? children : null','expanded ? children : null']
 }
 const r=mutation?replacements[mutation]:undefined
 if(r&&file===resolve(root,r[0])){if(code.split(r[1]).length!==2)throw Error('Missing unique mutation '+mutation);code=code.replace(r[1],r[2])}
 const log=process.env.AGENTMUX_NATIVE_PRIMARY_LOADED
 if(log)appendFileSync(log,JSON.stringify({path:relative(root,file),originalSHA256:createHash('sha256').update(before).digest('hex'),sha256:createHash('sha256').update(code).digest('hex'),bytes:Buffer.byteLength(code),...(before!==code?{mutation}:{})})+'\n')
 if(code!==before)return {code,map:null}
}}],test:{...original.test,server:{deps:{inline:['@agentmux/client-ui']}},globalSetup:[],include:process.env.AGENTMUX_NATIVE_PRIMARY_BASELINE ? ['apps/desktop/test/conversation-native-record-order.integration.test.tsx'] : process.env.AGENTMUX_NATIVE_PRIMARY_ADJACENT ? ['apps/desktop/test/conversation-native-record-order.integration.test.tsx','apps/desktop/test/native-process-reading.test.tsx','apps/desktop/test/history-shared-native-process.test.tsx','apps/desktop/test/activity-autoscroll.test.ts'] : ['apps/desktop/test/conversation-native-primary.integration.test.tsx'],passWithNoTests:false,fileParallelism:false}})
