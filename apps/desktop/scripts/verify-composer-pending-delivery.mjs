import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root=resolve(import.meta.dirname,'../../..'),desktop=join(root,'apps/desktop'),require=createRequire(import.meta.url),exec=promisify(execFile)
const mode=process.argv[2],base='4b38c4cf540de04f9de2ea70793a965b2e96c30d'
assert.ok(['--mutations','--source','--native','--card-mutations'].includes(mode))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const typedPaths=['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx','apps/desktop/src/renderer/src/components/SessionMailbox.tsx','apps/desktop/src/renderer/src/components/ComposerOutbox.tsx','apps/desktop/src/renderer/src/components/ComposerPendingDelivery.tsx','apps/desktop/src/renderer/src/store.ts','packages/client-ui/src/components/AgentComposer.tsx','apps/desktop/src/renderer/src/components/TerminalView.tsx','apps/desktop/src/renderer/src/components/ComposerQueuedMessageEditor.tsx']
const styles=['packages/client-ui/src/styles/composer.css','packages/client-ui/src/styles/conversation-message.css'],dependencyPaths=['patches/@xterm__xterm@6.1.0-beta.303.patch','pnpm-lock.yaml'], originals=Object.fromEntries(await Promise.all([...typedPaths,...styles,...dependencyPaths].map(async p=>[p,await readFile(join(root,p),'utf8')])))
const privateRoot=await realpath(await mkdtemp(join(tmpdir(),'amx-pending-delivery-'))),evidence=join(root,'.tmp/composer-pending-delivery',mode.slice(2)+'-'+globalThis.crypto.randomUUID())
await mkdir(evidence,{recursive:true})
const result={schema:'agentmux.composer-pending-delivery-proof.v1',mode,base,passed:false,userRunTouched:false,sharedSourceWritten:false,aestheticReview:'not-performed',productSources:Object.fromEntries(Object.entries(originals).map(([p,b])=>[p,hash(b)])),mutations:[]}
let dependency
async function prepareXterm(){
 if(dependency)return dependency
 const patch=join(root,dependencyPaths[0]),patchBytes=originals[dependencyPaths[0]],patchHash=hash(patchBytes),lock=originals[dependencyPaths[1]],cached=dirname(require.resolve('@xterm/xterm/package.json'))
 assert.ok(lock.includes("'@xterm/xterm@6.1.0-beta.303': "+patchHash));for(const match of lock.matchAll(/\(patch_hash=([a-f0-9]{64})\)/g))assert.equal(match[1],patchHash)
 const baselinePatch=process.env.AGENTMUX_PENDING_BASE_PATCH?await readFile(process.env.AGENTMUX_PENDING_BASE_PATCH,'utf8'):execFileSync('git',['show',base+':'+dependencyPaths[0]],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024}),baselinePatchPath=join(privateRoot,'baseline-xterm.patch')
 await writeFile(baselinePatchPath,baselinePatch)
 const patchedFiles=[...new Set([...patchBytes.matchAll(/^diff --git a\/(.+) b\//gm)].map(match=>match[1]))],cachedHashes=Object.fromEntries(await Promise.all(patchedFiles.map(async p=>[p,hash(await readFile(join(cached,p)))])))
 const pristine=join(privateRoot,'xterm-pristine'),candidate=join(privateRoot,'xterm-candidate/node_modules/@xterm/xterm'),baseline=join(privateRoot,'xterm-baseline/node_modules/@xterm/xterm'),applyLogs=[]
 if(process.env.AGENTMUX_PENDING_PRISTINE)await cp(process.env.AGENTMUX_PENDING_PRISTINE,pristine,{recursive:true})
 else{
  await cp(cached,pristine,{recursive:true});let inverse
  for(const p of [patch,baselinePatchPath]){try{await exec('patch',['-p1','--batch','--reverse','--dry-run','--input',p],{cwd:pristine,maxBuffer:4*1024*1024});inverse=p;break}catch{}}
  assert.ok(inverse,'Cached package must match the current or implementation-baseline repository patch')
  applyLogs.push((await exec('patch',['-p1','--batch','--reverse','--input',inverse],{cwd:pristine,maxBuffer:4*1024*1024})).stdout)
 }
 for(const [directory,p]of [[candidate,patch],[baseline,baselinePatchPath]]){await cp(pristine,directory,{recursive:true});applyLogs.push((await exec('patch',['-p1','--batch','--input',p],{cwd:directory,maxBuffer:4*1024*1024})).stdout)}
 const manifest=JSON.parse(await readFile(join(candidate,'package.json'),'utf8'));assert.equal(manifest.version,'6.1.0-beta.303');assert.equal(manifest.main,'lib/xterm.js');assert.equal(manifest.module,'lib/xterm.mjs')
 const candidateHashes=Object.fromEntries(await Promise.all(patchedFiles.map(async p=>[p,hash(await readFile(join(candidate,p)))])))
 dependency={pristine,candidate,baseline,baselinePatch,baselinePatchPath,cached,cachedHashes,patchedFiles}
 result.dependency={version:manifest.version,patchSha256:patchHash,lockSha256:hash(lock),baselinePatchSha256:hash(baselinePatch),candidateHashes,cachedHashes,sharedDependencyWritten:false,sourceAndBothCompiledEntriesReconstructed:true}
 await writeFile(join(evidence,'dependency-apply.log'),applyLogs.join('\n'));return dependency
}
async function dependencySource(ts){
 const d=await prepareXterm(),options={strict:true,skipLibCheck:true,experimentalDecorators:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,types:[],noEmit:true}
 function check(directory,roots){
  const program=ts.createProgram(roots.map(p=>join(directory,p)),options),checker=program.getTypeChecker(),diagnostics=ts.getPreEmitDiagnostics(program).map(item=>({file:item.file?relative(directory,item.file.fileName):'<config>',line:item.file?item.file.getLineAndCharacterOfPosition(item.start??0).line+1:0,code:item.code,message:ts.flattenDiagnosticMessageText(item.messageText,'\n')})),callers=[]
  for(const file of program.getSourceFiles().filter(file=>file.fileName.startsWith(directory+'/'))){function visit(node){const scroll=ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='scrollToLine',construct=ts.isNewExpression(node)&&node.expression.getText(file)==='TerminalCore';if(scroll||construct){let symbol=checker.getSymbolAtLocation(scroll?node.expression.name:node.expression);if(symbol?.flags&ts.SymbolFlags.Alias)symbol=checker.getAliasedSymbol(symbol);const declarations=symbol?.getDeclarations()??[];callers.push({kind:construct?'construct':'scroll',file:relative(directory,file.fileName),line:file.getLineAndCharacterOfPosition(node.pos).line+1,text:node.getText(file),declarations:declarations.map(declaration=>({file:relative(directory,declaration.getSourceFile().fileName),line:declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.pos).line+1}))})}ts.forEachChild(node,visit)}visit(file)}
  return{roots,consumedSources:program.getSourceFiles().length,diagnostics,callers}
 }
 const owner=check(d.candidate,['src/browser/Viewport.ts','typings/xterm.d.ts']),roots=['src/browser/Viewport.ts','src/browser/CoreBrowserTerminal.ts','src/browser/public/Terminal.ts','typings/xterm.d.ts'],current=check(d.candidate,roots),baseline=check(d.baseline,roots)
 assert.ok(owner.consumedSources>1);assert.deepEqual(owner.diagnostics,[]);assert.deepEqual(current.diagnostics,baseline.diagnostics)
 assert.ok(current.callers.length);assert.ok(current.callers.every(caller=>caller.declarations.length));assert.ok(current.callers.some(caller=>caller.kind==='construct'&&caller.file==='src/browser/public/Terminal.ts'&&caller.declarations.some(declaration=>declaration.file==='src/browser/CoreBrowserTerminal.ts')));assert.ok(current.callers.some(caller=>caller.kind==='scroll'&&caller.file==='src/browser/public/Terminal.ts'&&caller.declarations.some(declaration=>declaration.file==='typings/xterm.d.ts')));assert.ok(current.callers.some(caller=>caller.file==='src/browser/CoreBrowserTerminal.ts'&&caller.declarations.some(declaration=>declaration.file==='src/browser/Viewport.ts')))
 result.dependencySource={owner,current,baseline};await writeFile(join(evidence,'dependency-source.json'),JSON.stringify(result.dependencySource,null,2))
}
async function mounted(label,red){
 let code=0,output='';try{const r=await exec(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config','apps/desktop/scripts/fixtures/composer-pending-delivery/vitest.config.mts','--maxWorkers=1'],{cwd:privateRoot,timeout:60000,maxBuffer:4*1024*1024});output=r.stdout+r.stderr}catch(e){code=e.code;output=(e.stdout??'')+(e.stderr??'')}
 await writeFile(join(evidence,label+'.log'),output)
 const discovery=JSON.parse(await readFile(join(privateRoot,'.tmp/composer-pending-delivery/mounted/discovery.json'),'utf8'))
 assert.equal(discovery.passed,true);assert.equal(discovery.found.length,3)
 if(red){assert.equal(typeof code,'number');assert.notEqual(code,0);assert.match(output,/AssertionError:/)}else assert.equal(code,0,label+': all owning tests pass')
 return{code,assertionRed:red,discovery,log:label+'.log'}
}
async function nativeMutation(label,red,expectedFailure=/actual original terminal cursor remains in its viewport/){
 const d=await prepareXterm(),bannerSnapshot=join(privateRoot,'fixture-settings-banner.png');await writeFile(bannerSnapshot,execFileSync('git',['show',base+':apps/desktop/resources/settings-banner.png'],{cwd:root,maxBuffer:4*1024*1024}));let code=0,output='';try{const r=await exec(process.execPath,[join(privateRoot,'apps/desktop/scripts/verify-composer-pending-delivery.mjs'),'--native'],{cwd:privateRoot,env:{...process.env,AGENTMUX_PENDING_PRISTINE:d.pristine,AGENTMUX_PENDING_BASE_PATCH:d.baselinePatchPath,AGENTMUX_PENDING_BANNER_SNAPSHOT:bannerSnapshot},timeout:120000,maxBuffer:4*1024*1024});output=r.stdout+r.stderr}catch(e){code=e.code;output=(e.stdout??'')+(e.stderr??'')}
 await writeFile(join(evidence,label+'.log'),output)
 const summaries=output.trim().split('\n').filter(line=>line.startsWith('{"mode":"--native"'));assert.equal(summaries.length,1)
 const summary=JSON.parse(summaries[0]),proofDirectory=join(privateRoot,summary.evidence),receipt=JSON.parse(await readFile(join(proofDirectory,'receipt.json'),'utf8'))
 await cp(proofDirectory,join(evidence,label),{recursive:true})
 const rendered=JSON.parse(await readFile(join(proofDirectory,'candidate/render.json'),'utf8'))
 assert.equal(receipt.privateRootRemoved,true);assert.equal(receipt.userRunTouched,false);assert.ok(rendered.frames.length)
 if(red){assert.equal(typeof code,'number');assert.notEqual(code,0);assert.equal(receipt.passed,false);assert.equal(rendered.failure?.name,'AssertionError');assert.match(rendered.failure.message,expectedFailure)}else{assert.equal(code,0);assert.equal(receipt.passed,true);assert.equal(rendered.passed,true);assert.equal(rendered.frames.length,88);assert.deepEqual(rendered.rendererErrors,[])}
 return{code,assertionRed:red,frames:rendered.frames.length,evidence:label,receipt}
}
async function cardMutations(){
 for(const dir of ['apps/desktop/src','apps/desktop/test/helpers','apps/desktop/scripts','apps/desktop/resources','packages/core/src','packages/client-ui/src','packages/demand/src','packages/layout/src','patches'])await cp(join(root,dir),join(privateRoot,dir),{recursive:true})
 for(const p of ['package.json','pnpm-workspace.yaml','pnpm-lock.yaml','tsconfig.base.json','apps/desktop/package.json','apps/desktop/tsconfig.json',...['core','client-ui','demand','layout'].map(p=>'packages/'+p+'/package.json')])await cp(join(root,p),join(privateRoot,p))
 for(const p of ['node_modules','apps/desktop/node_modules',...['core','client-ui','demand','layout'].map(p=>'packages/'+p+'/node_modules')])await symlink(join(root,p),join(privateRoot,p),'dir')
 console.log('Captured private UI source snapshot for card mutation proof')
 const cases=[
  {name:'normal-flow-height-restored',edits:[{file:styles[0],from:'.composer-pending { position: fixed;',to:'.composer-pending { position: relative;'},{file:typedPaths[3],from:'return <WindowOverlayPortal>',to:'return <>'},{file:typedPaths[3],from:'</WindowOverlayPortal>',to:'</>'}],failure:/original editor geometry exactly|zero normal-flow height|original terminal rectangle|original unfinished terminal prompt|zero terminal rows/},
  {name:'intrinsic-width-removed',from:'width: max-content; max-width: min(360px,',to:'width: 360px; max-width: min(360px,',failure:/Short pending card sizes to its content/},
  {name:'real-card-depth-flattened',from:'transform: perspective(520px) rotateX(calc(6deg + var(--queue-depth) * 4deg)) rotateY(calc(var(--queue-depth) * -3deg)) translateZ(calc(var(--queue-depth) * -8px));',to:'transform: none;',failure:/Real queued cards preserve depth while idle/},
  {name:'real-card-traversal-capped',file:typedPaths[3],from:'{queued.map((entry, index) => {',to:'{queued.slice(0, 4).map((entry, index) => {',failure:/Every queued operation has its own real card/},
  {name:'nonhead-send-borrows-head',file:typedPaths[3],from:'onSend?.(entry.id)',to:'onSend?.(queued[0]!.id)',failure:/Nonhead Send submits only that original card/},
  {name:'copy-borrows-head-text',file:typedPaths[3],from:'onCopy?.(entry.text)',to:'onCopy?.(queued[0]!.text)',failure:/Each card copies its own complete original text/},
  {name:'edit-save-bypasses-owner',file:typedPaths[7],from:'await onSave(entry.id, original, text); onCancel()',to:'onCancel()',failure:/Save preserves original operation, Run, time and order/},
  {name:'edit-rejection-discards-draft',file:typedPaths[7],from:'catch (failure) { setError(presentError(failure)); textareaRef.current?.focus({ preventScroll: true }) }',to:'catch (failure) { onCancel() }',failure:/Actual Renderer fact did not arrive/}
 ]
 for(const item of cases){
  const edits=item.edits??[{file:item.file??styles[0],from:item.from,to:item.to}],changed=new Map()
  for(const edit of edits){const bytes=changed.get(edit.file)??originals[edit.file];assert.equal(bytes.split(edit.from).length,2);changed.set(edit.file,bytes.replace(edit.from,edit.to))}
  for(const [file,bytes]of changed)await writeFile(join(privateRoot,file),bytes)
  const red=await nativeMutation(item.name,true,item.failure)
  const files=[];for(const [file,bytes]of changed){await writeFile(join(privateRoot,file),originals[file]);assert.equal(hash(await readFile(join(privateRoot,file))),hash(originals[file]));files.push({file,originalSha256:hash(originals[file]),mutatedSha256:hash(bytes)})}
  result.mutations.push({name:item.name,files,red,exactRestoration:true});console.log(JSON.stringify({mutation:item.name,assertionRed:true,exactRestoration:true}))
 }
 result.restored=await nativeMutation('card-original-restored',false)
 assert.equal(result.mutations.length,8)
}
async function mutations(){
 for(const dir of ['apps/desktop/src','apps/desktop/test','apps/desktop/scripts','apps/desktop/resources','apps/desktop/browser-extension','packages/core/src','packages/client-ui/src','packages/demand/src','packages/layout/src','patches'])await cp(join(root,dir),join(privateRoot,dir),{recursive:true})
 for(const p of ['package.json','pnpm-workspace.yaml','pnpm-lock.yaml','tsconfig.base.json','vitest.setup.ts','apps/desktop/package.json','apps/desktop/tsconfig.json',...['core','client-ui','demand','layout'].map(p=>'packages/'+p+'/package.json')])await cp(join(root,p),join(privateRoot,p))
 for(const p of ['node_modules','apps/desktop/node_modules',...['core','client-ui','demand','layout'].map(p=>'packages/'+p+'/node_modules')])await symlink(join(root,p),join(privateRoot,p),'dir')
 result.baseline=await mounted('baseline',false)
 const cases=[{name:'pending-strip-hidden',file:typedPaths[3],from:'if (!queued.length || !selected) return null',to:'if (true) return null'},
 {name:'preparation-misreported',file:typedPaths[0],from:"preparing: entry.operationId === sendingId && sendingPhase !== 'submitting',",to:'preparing: false,'},
 {name:'send-borrows-old-head',file:typedPaths[3],from:'onSend?.(entry.id)',to:'onSend?.(queued[0]!.id)'}]
 for(const item of cases){const original=originals[item.file];assert.equal(original.split(item.from).length,2);const changed=original.replace(item.from,item.to)
  await writeFile(join(privateRoot,item.file),changed);const red=await mounted(item.name,true)
  await writeFile(join(privateRoot,item.file),original);const restored=await mounted(item.name+'-restored',false)
  result.mutations.push({...item,originalSha256:hash(original),mutatedSha256:hash(changed),red,restored})}
 const item={name:'latest-row-stale-scroll-cache',file:typedPaths[6],from:"if (target.kind === 'latest') terminal.scrollToLine(buffer.baseY)",to:"if (target.kind === 'latest') terminal.scrollToBottom()"},original=originals[item.file]
 assert.equal(original.split(item.from).length,2);const changed=original.replace(item.from,item.to)
 await writeFile(join(privateRoot,item.file),changed);const red=await nativeMutation(item.name,true)
 await writeFile(join(privateRoot,item.file),original);const restored=await nativeMutation(item.name+'-restored',false)
 result.mutations.push({...item,originalSha256:hash(original),mutatedSha256:hash(changed),red,restored})
 const d=await prepareXterm(),patchOriginal=originals[dependencyPaths[0]],lockOriginal=originals[dependencyPaths[1]],patchChanged=d.baselinePatch,lockChanged=lockOriginal.replaceAll(hash(patchOriginal),hash(patchChanged))
 assert.notEqual(hash(patchOriginal),hash(patchChanged));assert.notEqual(lockOriginal,lockChanged)
 await writeFile(join(privateRoot,dependencyPaths[0]),patchChanged);await writeFile(join(privateRoot,dependencyPaths[1]),lockChanged);const dimensionsRed=await nativeMutation('absolute-scroll-old-dimensions',true)
 await writeFile(join(privateRoot,dependencyPaths[0]),patchOriginal);await writeFile(join(privateRoot,dependencyPaths[1]),lockOriginal);const dimensionsRestored=await nativeMutation('absolute-scroll-old-dimensions-restored',false)
 result.mutations.push({name:'absolute-scroll-old-dimensions',files:dependencyPaths,originalSha256:hash(patchOriginal),mutatedSha256:hash(patchChanged),lockOriginalSha256:hash(lockOriginal),lockMutatedSha256:hash(lockChanged),red:dimensionsRed,restored:dimensionsRestored})
}
async function source(){
 const ts=await import('typescript');await dependencySource(ts);const app=ts.getParsedCommandLineOfConfigFile(join(desktop,'tsconfig.json'),{},ts.sys),shared=ts.getParsedCommandLineOfConfigFile(join(root,'packages/client-ui/tsconfig.json'),{},ts.sys)
 assert.ok(app.fileNames.length&&shared.fileNames.length)
 const paths={'@agentmux/client-ui/components/*':['packages/client-ui/src/components/*.tsx'],'@agentmux/client-ui/terminal/*':['packages/client-ui/src/terminal/*.ts'],'@agentmux/client-ui/platform':['packages/client-ui/src/platform.tsx'],'@agentmux/client-ui':['packages/client-ui/src/index.ts'],'@agentmux/client-ui/*':['packages/client-ui/src/lib/*.ts'],'@agentmux/layout':['packages/layout/src/index.ts']}
 for(const pkg of ['core','demand'])for(const [key,entry]of Object.entries(JSON.parse(readFileSync(join(root,'packages/'+pkg+'/package.json'),'utf8')).exports))if(typeof entry==='object'&&entry.import)paths['@agentmux/'+pkg+(key==='.'?'':key.slice(1))]=['packages/'+pkg+'/'+entry.import.replace('./dist/','./src/').replace('./src/src/','./src/').replace(/\.js$/,'.ts')]
 const roots=[...new Set([...app.fileNames,...shared.fileNames])],options={...app.options,baseUrl:root,paths}
 const tracked=execFileSync('git',['ls-tree','-r','--name-only',base],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(p=>/^(apps\/desktop|packages\/(core|demand|layout|client-ui))\//.test(p)&&/\.(tsx?|json)$/.test(p));assert.ok(tracked.length)
 const blobs=execFileSync('git',['cat-file','--batch'],{cwd:root,input:tracked.map(p=>base+':'+p+'\n').join(''),maxBuffer:64*1024*1024}),baselineFiles=new Map();let offset=0
 for(const p of tracked){const end=blobs.indexOf(10,offset),size=Number(blobs.subarray(offset,end).toString().split(' ').at(-1));assert.ok(Number.isFinite(size));baselineFiles.set(join(root,p),blobs.subarray(end+1,end+1+size).toString());offset=end+2+size}
 function build(baseline=false,override=new Map()){
  const host=ts.createCompilerHost(options),read=host.readFile,exists=host.fileExists
  host.readFile=p=>override.has(p)?override.get(p):baseline&&baselineFiles.has(p)?baselineFiles.get(p):baseline&&typedPaths.includes(relative(root,p))&&!baselineFiles.has(p)?undefined:read(p)
  host.fileExists=p=>baseline&&typedPaths.includes(relative(root,p))&&!baselineFiles.has(p)?false:baselineFiles.has(p)||exists(p)
  host.getSourceFile=(p,v)=>{const text=host.readFile(p);return text===undefined?undefined:ts.createSourceFile(p,text,v,true)}
  const program=ts.createProgram(baseline?roots.filter(p=>baselineFiles.has(p)):roots,options,host)
  const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({file:d.file?relative(root,d.file.fileName):'<config>',line:d.file?d.file.getLineAndCharacterOfPosition(d.start??0).line+1:0,character:d.file?d.file.getLineAndCharacterOfPosition(d.start??0).character+1:0,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return{program,diagnostics}
 }
 const candidateSnapshot=new Map(Object.entries(originals).filter(([p])=>typedPaths.includes(p)).map(([p,b])=>[join(root,p),b]));const baseline=build(true),candidate=build(false,candidateSnapshot),owned=candidate.diagnostics.filter(d=>typedPaths.includes(d.file)),others=candidate.diagnostics.filter(d=>!typedPaths.includes(d.file)),baselineOthers=baseline.diagnostics.filter(d=>!typedPaths.includes(d.file))
 result.program={appRoots:app.fileNames.length,sharedRoots:shared.fileNames.length,consumedSources:candidate.program.getSourceFiles().length,owned,others,baselineOthers,baselineAll:baseline.diagnostics}
 await writeFile(join(evidence,'program.json'),JSON.stringify(result.program,null,2))
 assert.equal(owned.length,0,'Owned Source diagnostics zero');assert.deepEqual(others,baselineOthers,'Other complete Source diagnostics equal the actual implementation baseline')
 result.callers=[]
 for(const [p,name,prop]of [[typedPaths[0],'SessionMailbox','queued'],[typedPaths[0],'AgentComposer','aboveInput'],[typedPaths[1],'ComposerPendingDelivery','queued'],[typedPaths[1],'ComposerOutbox','queued'],[typedPaths[3],'ComposerQueuedMessageEditor','entry'],[typedPaths[2],'ComposerQueuedMessageEditor','entry'],['apps/desktop/src/renderer/src/components/SessionPane.tsx','TerminalView','session']]){
  const file=candidate.program.getSourceFile(join(root,p)),calls=[];assert.ok(file)
  function visit(n){if((ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n))&&n.tagName.getText(file)===name&&n.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.getText(file)===prop))calls.push({line:file.getLineAndCharacterOfPosition(n.pos).line+1,text:n.getText(file)});ts.forEachChild(n,visit)}visit(file);assert.ok(calls.length,p+' production JSX '+name+'.'+prop);result.callers.push({p,name,prop,calls})
 }
 for(const [p,name]of [[typedPaths[0],'sendQueuedAgentSteer'],[typedPaths[0],'agentSteerCanEdit'],[typedPaths[0],'agentSteerExecution'],[typedPaths[0],'useAppStore.getState().editQueuedAgentSteer'],[typedPaths[7],'onSave'],[typedPaths[3],'queuedMessageState'],[typedPaths[4],'api.sessions.submitPrompt'],[typedPaths[6],'terminal.scrollToLine']]){
  const file=candidate.program.getSourceFile(join(root,p)),calls=[];function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(file)===name)calls.push({line:file.getLineAndCharacterOfPosition(n.pos).line+1,text:n.getText(file)});ts.forEachChild(n,visit)}visit(file);assert.ok(calls.length,p+' production call '+name);result.callers.push({p,name,calls})
 }
 const file=candidate.program.getSourceFile(join(root,typedPaths[0]));let attribute
 function locate(n){if(ts.isJsxAttribute(n)&&n.name.getText(file)==='queued')attribute=n;ts.forEachChild(n,locate)}locate(file);assert.ok(attribute)
 const original=originals[typedPaths[0]],changed=original.slice(0,attribute.initializer.getStart(file))+'{"invalid queue"}'+original.slice(attribute.initializer.end)
 const red=build(false,new Map([...candidateSnapshot,[join(root,typedPaths[0]),changed]])).diagnostics.filter(d=>d.file===typedPaths[0]);assert.ok(red.some(d=>d.code===2322));assert.equal(hash(candidateSnapshot.get(join(root,typedPaths[0]))),hash(original))
 result.mutations.push({name:'actual-invalid-queued-prop',originalSha256:hash(original),mutatedSha256:hash(changed),red,restoredOwnedDiagnostics:owned})
}
async function native(){
 const d=await prepareXterm()
 const {build}=await import('vite'),fixture=join(desktop,'scripts/fixtures/composer-pending-delivery'),directory=join(evidence,'candidate'),processRoot=join(privateRoot,'native'),outDir=join(processRoot,'out'),main=join(processRoot,'main.cjs'),wrapper=join(processRoot,'xterm.mjs')
 await mkdir(directory,{recursive:true});await mkdir(processRoot,{recursive:true});const mainBytes=await readFile(join(fixture,'main.cjs'));await writeFile(main,mainBytes)
 await writeFile(wrapper,`import xterm from ${JSON.stringify(join(d.candidate,'lib/xterm.js'))};export class Terminal extends xterm.Terminal{constructor(...args){super(...args);const entries=globalThis.resultReadyTerminals??=[];this.probeIdentity={id:entries.length,terminal:this,disposed:false};entries.push(this.probeIdentity)}dispose(){this.probeIdentity.disposed=true;return super.dispose()}}`)
 const banner=join(processRoot,'settings-banner.png'),bannerBytes=process.env.AGENTMUX_PENDING_BANNER_SNAPSHOT?await readFile(process.env.AGENTMUX_PENDING_BANNER_SNAPSHOT):execFileSync('git',['show',base+':apps/desktop/resources/settings-banner.png'],{cwd:root,maxBuffer:4*1024*1024});await writeFile(banner,bannerBytes);result.fixtureResourceSnapshot={path:'apps/desktop/resources/settings-banner.png',source:base,sha256:hash(bannerBytes)};const loaded={},styleInputs={};let runtimeLoaded
 await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:[
  {find:/^@agentmux\/client-ui\/components\/(.+)$/,replacement:join(root,'packages/client-ui/src/components/$1.tsx')},{find:/^@agentmux\/client-ui\/styles\/(.+)$/,replacement:join(root,'packages/client-ui/src/styles/$1')},{find:/^@agentmux\/client-ui\/terminal\/(.+)$/,replacement:join(root,'packages/client-ui/src/terminal/$1.ts')},{find:/^@agentmux\/client-ui\/platform$/,replacement:join(root,'packages/client-ui/src/platform.tsx')},{find:/^@agentmux\/client-ui\/(.+)$/,replacement:join(root,'packages/client-ui/src/lib/$1.ts')},{find:/^@agentmux\/client-ui$/,replacement:join(root,'packages/client-ui/src/index.ts')},{find:/^@xterm\/xterm$/,replacement:wrapper},{find:/^@agentmux\/layout$/,replacement:join(root,'packages/layout/src/index.ts')},...Object.entries(JSON.parse(readFileSync(join(root,'packages/core/package.json'),'utf8')).exports).filter(([key,target])=>key!=='.'&&typeof target==='object'&&target.import).map(([key,target])=>({find:new RegExp('^@agentmux/core'+key.slice(1)+'$'),replacement:join(root,'packages/core',target.import.replace('./dist/','./src/').replace(/\.js$/,'.ts'))}))
 ]},plugins:[{name:'actual-pending-source',enforce:'pre',resolveId(source){if(source.endsWith('/resources/settings-banner.png'))return banner},transform(bytes,id){const captured=originals[relative(root,id)];if(captured!==undefined)bytes=captured;if(id===join(d.candidate,'lib/xterm.js'))runtimeLoaded=hash(bytes);if((id.startsWith(join(desktop,'src')+'/')||id.startsWith(join(root,'packages/client-ui/src')+'/')||id.startsWith(fixture+'/'))&&!id.includes('?'))loaded[relative(root,id)]=hash(bytes);if(captured!==undefined)return bytes},async generateBundle(){for(const p of this.getWatchFiles())if(p.endsWith('.css')&&(p.startsWith(join(desktop,'src')+'/')||p.startsWith(join(root,'packages/client-ui/src')+'/')))styleInputs[relative(root,p)]=hash(originals[relative(root,p)]??await readFile(p))}}],define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},build:{outDir,emptyOutDir:true,minify:false,reportCompressedSize:false,commonjsOptions:{include:[/node_modules/,/xterm-locked-925/]}}})
 for(const p of typedPaths)assert.equal(loaded[p],hash(originals[p]),'Actual loaded Source '+p);for(const p of styles)assert.equal(styleInputs[p],hash(originals[p]))
 const compiled={};for(const file of await readdir(outDir,{recursive:true,withFileTypes:true}))if(file.isFile()){const p=join(file.parentPath,file.name);compiled[relative(outDir,p)]=hash(await readFile(p))}assert.ok(Object.keys(compiled).length)
 assert.equal(runtimeLoaded,result.dependency.candidateHashes['lib/xterm.js'],'Vite consumes the actual reconstructed runtime bytes')
 await writeFile(join(directory,'compiled.json'),JSON.stringify({loaded,styleInputs,compiled,dependency:result.dependency,runtimeLoaded,mainSha256:hash(mainBytes),wrapperSha256:hash(await readFile(wrapper)),electron:require('electron/package.json').version},null,2))
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const lines=[]
 const outcome=await runProbeProcess(require('electron'),[main,join(outDir,'index.html'),processRoot,directory,'capture'],{temporaryRoot:processRoot,cwd:root,env,timeoutMs:90000,onLine:l=>lines.push(l)})
 await writeFile(join(directory,'process.log'),lines.join('\n'));const rendered=JSON.parse(await readFile(join(directory,'render.json'),'utf8'));assert.equal(outcome.timedOut,false);assert.equal(outcome.exitCode,0,rendered.failure?.message);assert.equal(rendered.passed,true);assert.ok(rendered.frames.length)
 assert.equal(rendered.frames.length,88);assert.deepEqual(rendered.rendererErrors,[]);assert.equal((await listProbeProcesses(-1,processRoot)).length,0);result.candidate={directory:relative(root,directory),outcome,rendered}
}
try{if(mode==='--card-mutations')await cardMutations();else if(mode==='--mutations')await mutations();else if(mode==='--source')await source();else await native();result.passed=true}catch(e){result.failure={name:e.name,message:e.message,stack:e.stack};process.exitCode=1}finally{result.sharedSourceChangesDuringProof=[];for(const [p,b]of Object.entries(originals)){const current=hash(await readFile(join(root,p)));if(current!==hash(b))result.sharedSourceChangesDuringProof.push({path:p,capturedSha256:hash(b),currentSha256:current})}if(dependency)for(const [p,h]of Object.entries(dependency.cachedHashes))assert.equal(hash(await readFile(join(dependency.cached,p))),h,'Shared dependency unchanged during proof');await rm(privateRoot,{recursive:true,force:true});result.privateRootRemoved=true;await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({mode,passed:result.passed,evidence:relative(root,evidence),failure:result.failure?.message}))}
