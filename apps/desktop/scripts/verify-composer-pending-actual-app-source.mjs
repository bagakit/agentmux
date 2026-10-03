import {createRequire} from 'node:module'
import {resolve,join,relative,dirname} from 'node:path'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import assert from 'node:assert/strict'
const root=resolve(import.meta.dirname,'../../..'),require=createRequire(import.meta.url),ts=require('typescript')
const output=resolve(process.argv[2]),base=process.argv[3]
assert.ok(base);await mkdir(output,{recursive:true})
const owned=['apps/desktop/src/renderer/src/components/ComposerPendingDelivery.tsx','apps/desktop/src/renderer/src/components/TerminalView.tsx']
const roots=[...owned,'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx','apps/desktop/src/renderer/src/components/SessionMailbox.tsx','apps/desktop/src/renderer/src/components/SessionPane.tsx','apps/desktop/src/renderer/src/global.d.ts'].map(p=>join(root,p))
// The private dependency owner keeps Vite at the consuming Desktop package.
// Use that real declaration file rather than looking for it at the repository root.
roots.push(join(dirname(createRequire(join(root,'apps/desktop/package.json')).resolve('vite/package.json')),'client.d.ts'))
const config=ts.readConfigFile(join(root,'apps/desktop/tsconfig.json'),ts.sys.readFile)
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,join(root,'apps/desktop'))
const paths={'@agentmux/layout':['packages/layout/src/index.ts']}
for(const pkg of ['core','demand','relay'])for(const [key,t]of Object.entries(JSON.parse(await readFile(join(root,'packages/'+pkg+'/package.json'),'utf8')).exports))if(t.import)paths['@agentmux/'+pkg+(key==='.'?'':key.slice(1))]=['packages/'+pkg+'/'+t.import.replace('./dist/','./src/').replace('./src/src/','./src/').replace(/\.js$/,'.ts')]
const options={...parsed.options,types:parsed.options.types.filter(t=>t!=='vite/client'),baseUrl:root,paths}
const before=new Map(owned.map(p=>[join(root,p),execFileSync('git',['show',base+':'+p],{cwd:root,encoding:'utf8'})]))
function program(overrides=new Map()){
  const host=ts.createCompilerHost(options),read=host.readFile
  host.readFile=p=>overrides.get(p)??read(p)
  host.getSourceFile=(p,v)=>{const s=host.readFile(p);return s===undefined?undefined:ts.createSourceFile(p,s,v,true)}
  const p=ts.createProgram(roots,options,host)
  const diagnostics=ts.getPreEmitDiagnostics(p).map(d=>({file:d.file?relative(root,d.file.fileName):'<config>',code:d.code,line:d.file?d.file.getLineAndCharacterOfPosition(d.start??0).line+1:0,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return {p,diagnostics}
}
const previous=program(before),current=program()
const own=current.diagnostics.filter(d=>owned.includes(d.file)),other=current.diagnostics.filter(d=>!owned.includes(d.file)),baseline=previous.diagnostics.filter(d=>!owned.includes(d.file))
const callerSpecifications=[['apps/desktop/src/renderer/src/components/SessionMailbox.tsx','ComposerPendingDelivery'],['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx','SessionMailbox'],['apps/desktop/src/renderer/src/components/SessionPane.tsx','TerminalView']]
const callers=[]
for(const [path,name]of callerSpecifications){
  const file=current.p.getSourceFile(join(root,path)),calls=[]
  function visit(n){if((ts.isJsxSelfClosingElement(n)||ts.isJsxOpeningElement(n))&&n.tagName.getText(file)===name)calls.push({line:file.getLineAndCharacterOfPosition(n.pos).line+1,text:n.getText(file)});ts.forEachChild(n,visit)}
  visit(file);assert.ok(calls.length);callers.push({path,name,calls})
}
const report={passed:own.length===0&&JSON.stringify(other)===JSON.stringify(baseline),owned:own,other,baseline,callers,consumedSources:current.p.getSourceFiles().length,scope:'Two changed TS owners and definition-external production callers; unrelated diagnostics must equal the same complete candidate before owner changes.'}
await writeFile(join(output,'source.json'),JSON.stringify(report,null,2))
assert.deepEqual(own,[]);assert.deepEqual(other,baseline)
console.log(JSON.stringify({passed:true,consumedSources:report.consumedSources,callerCount:callers.length,otherDiagnostics:other.length}))
