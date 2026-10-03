import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync,existsSync,appendFileSync } from 'node:fs'
import original from '../../../../../vitest.config'
const root=resolve(import.meta.dirname,'../../../../..')
const pkg=JSON.parse(readFileSync(resolve(root,'packages/core/package.json'),'utf8'))
const aliases=Object.entries(pkg.exports).flatMap(([name,value])=>{const source=resolve(root,'packages/core/src/'+(value as {import:string}).import.replace('./dist/','').replace(/\.js$/u,'.ts'));const spec=name==='.'?'@agentmux/core':'@agentmux/core'+name.slice(1);return existsSync(source)?[{find:new RegExp('^'+spec.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'),replacement:source}]:[]})
export default defineConfig({
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },...original,root,esbuild:{jsx:'automatic',jsxImportSource:'react'},resolve:{conditions:['browser','import','default'],alias:[...aliases,{find:'react',replacement:resolve(root,'apps/desktop/node_modules/react')},{find:'react-dom',replacement:resolve(root,'apps/desktop/node_modules/react-dom')}]},cacheDir:resolve(root,'.local/history-reuse-cache'),plugins:[{name:'history-reuse-actual-loaded',enforce:'pre',transform(code,id){
 const file=id.split('?')[0]!;if(!file.startsWith(root+'/apps/desktop/src/')&&!(file.startsWith(root+'/packages/core/src/')||file.startsWith(root+'/packages/client-ui/src/')))return
 const before=code, mutation=process.env.AGENTMUX_HISTORY_MUTATION
 const replacements:Record<string,[string,string,string]>={
  'drop-shared-history':['apps/desktop/src/renderer/src/components/SessionHistoryView.tsx','{page ? <ConversationNativeThread','{false ? <ConversationNativeThread'],
  'lose-raw-identity':['packages/client-ui/src/components/ConversationNativeThread.tsx','messageIdForRecord?.(item) ?? user?.id ?? recordId','user?.id ?? recordId'],
  'drop-anchor':['apps/desktop/src/renderer/src/components/SessionHistoryView.tsx','viewport.scrollTop += rect.top - bounds.top - anchor.offset','viewport.scrollTop += 0'],
  'hidden-read':['apps/desktop/src/renderer/src/components/SessionHistoryView.tsx','if (!visibleRef.current) return','if (false) return'],
  'drop-range-fence':['apps/desktop/src/renderer/src/components/SessionHistoryView.tsx','if (anchorInNewest || selectionInNewest)','if (anchorInNewest)'],
  'drop-trace-state':['apps/desktop/src/renderer/src/components/SessionHistoryView.tsx','expandedTraces={openedTraces} onToggleTrace={handleToggleTrace}','expandedTraces={new Set<string>()} onToggleTrace={handleToggleTrace}'],
  'fabricate-boundary':['apps/desktop/src/renderer/src/components/SessionHistoryView.tsx','boundaryRecord?.completedAt ?? boundaryRecord?.startedAt','0']
 }
 const r=mutation?replacements[mutation]:undefined
 if(r&&file===resolve(root,r[0])){if(code.split(r[1]).length!==2)throw Error('Missing unique mutation '+mutation);code=code.replace(r[1],r[2])}
 const log=process.env.AGENTMUX_HISTORY_LOADED
 if(log)appendFileSync(log,JSON.stringify({path:relative(root,file),originalSHA256:createHash('sha256').update(before).digest('hex'),sha256:createHash('sha256').update(code).digest('hex'),bytes:Buffer.byteLength(code),...(before!==code?{mutation}:{})})+'\n')
 if(code!==before)return {code,map:null}
}}],test:{...original.test,server:{deps:{inline:['@agentmux/client-ui']}},globalSetup:[],include:['apps/desktop/test/history-shared-native-process.test.tsx','apps/desktop/test/history-process-collapsed-prepend.test.tsx','apps/desktop/test/conversation-reading-state.integration.test.tsx','apps/desktop/test/session-history-entry-views.test.tsx','apps/desktop/test/conversation-history-reuse.test.tsx'],passWithNoTests:false,fileParallelism:false}})
