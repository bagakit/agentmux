import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { listProbeProcesses, stopProbeProcesses, runProbeProcess } from './probe-process.mjs'
import { reapDetachedRuns } from './probe-owned-run.mjs'

const desktop=resolve(import.meta.dirname,'..'), repository=resolve(desktop,'../..')
const require=createRequire(import.meta.url), exec=promisify(execFile), {build}=await import('vite'), ts=require('typescript')
const evidence=join(repository,'.tmp/agent-region-identity-menu',("attempt-" + (globalThis.crypto.randomUUID()) + "")), fixture=join(desktop,'scripts/fixtures/agent-region-identity-menu')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const visualOnly=process.argv.includes('--visual-only')
const agentMenuOwning=process.argv.includes('--agent-menu-owning')
assert.ok(!agentMenuOwning||visualOnly,'Agent menu proof uses the private Renderer fixture')
const progressLayoutOwning=process.argv.includes('--progress-layout-owning')
const terminalLoadingOwning=process.argv.includes('--terminal-loading-owning')
const messageFeedbackOwning=process.argv.includes('--message-feedback-owning')
const mailboxMotionOwning=process.argv.includes('--mailbox-motion-owning')
const mailboxHoverMutation=process.argv.includes('--mailbox-hover-mutation')
const composerToolbarOwning=process.argv.includes('--composer-toolbar-owning')
const mailboxLayoutOwning=process.argv.includes('--mailbox-layout-owning')
assert.ok(!mailboxLayoutOwning||visualOnly,'Mailbox layout uses only the private visual fixture')
assert.ok(!composerToolbarOwning||visualOnly,'Composer toolbar uses only the private visual fixture')
assert.ok(!mailboxHoverMutation||visualOnly,'Mailbox hover mutation stays in the private visual compilation')
assert.ok(!progressLayoutOwning||visualOnly,'Progress layout owning uses only the private visual fixture')
assert.ok(!terminalLoadingOwning||visualOnly,'Terminal loading owning uses only the private visual fixture')
assert.ok(!terminalLoadingOwning||!progressLayoutOwning,'The private owning modes have distinct scenes')
assert.ok(!messageFeedbackOwning||visualOnly,'Message feedback owning uses only the private visual fixture')
assert.ok(!mailboxMotionOwning||visualOnly,'Mailbox motion owning uses only the private visual fixture')
const result={schema:'agentmux.region-identity-menu-delivery.v1',passed:false,sourceBefore:{},sourceAfter:{},mutations:[],callers:[],cleanup:{},userRunTouched:false,
  ...(visualOnly?{captureOnly:true,aestheticReview:'not-performed'}:{})}
const menuOwnerFiles=[...['AgentMenuContent','AgentMenuIdentityActions','AgentAvatar','AgentRegionHeader','FocusContextMenu','FocusAgentWorkspaceMenu','AgentSessionReadingSurface','AgentCurrentForkControls','SessionTakeoverSurface','AgentConnections','RegionContextMenu','TerminalContextMenu','TerminalMenuTools','AgentNativeSourceControls','SessionStop','SessionRestart','WorkbenchMenuSubmenu','WorkbenchCopyLinkRow','WorkbenchActionRows'].map(name=>`apps/desktop/src/renderer/src/components/${name}.tsx`),
  ...['agent-current-fork','session-takeover','agent-new-tab-destination','focus-agent-menu-location'].map(name=>`apps/desktop/src/renderer/src/lib/${name}.ts`),
  'apps/desktop/src/renderer/src/lib/use-agent-connector-menu.tsx',
  ...['agent-region-header','agent-session-action-surface','focus','terminal','chrome'].map(name=>`apps/desktop/src/renderer/src/styles/${name}.css`)]
async function menuOwnerHashes(){return Object.fromEntries(await Promise.all(menuOwnerFiles.map(async path=>[path,hash(await readFile(join(repository,path)))])))}
async function positioningBinding(){
  const files={},entries={}
  async function bind(name,resolver){
    const entry=resolver.resolve(name),directory=dirname(dirname(entry)),manifestPath=join(directory,'package.json')
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));assert.equal(manifest.name,name)
    entries[name]=entry
    for(const path of new Set([manifestPath,entry,...[manifest.main,manifest.module].filter(Boolean).map(target=>join(directory,target))]))files[path]=hash(await readFile(path))
    return createRequire(entry)
  }
  const context=createRequire(require.resolve('@radix-ui/react-context-menu'))
  const menu=createRequire(context.resolve('@radix-ui/react-menu'))
  const popper=await bind('@radix-ui/react-popper',menu)
  const reactDom=await bind('@floating-ui/react-dom',popper)
  const dom=await bind('@floating-ui/dom',reactDom)
  const core=await bind('@floating-ui/core',dom)
  await bind('@floating-ui/utils',core)
  const yaml=createRequire(join(repository,'packages/core/package.json'))('yaml'),key='@radix-ui/react-popper@1.3.3'
  const workspace=yaml.parse(await readFile(join(repository,'pnpm-workspace.yaml'),'utf8')),lock=yaml.parse(await readFile(join(repository,'pnpm-lock.yaml'),'utf8'))
  const path=workspace.patchedDependencies[key];assert.ok(path&&lock.patchedDependencies[key],'The original Popper patch is declared in both manifests')
  return{files,entries,patch:{key,path,sha256:hash(await readFile(join(repository,path))),lock:lock.patchedDependencies[key]}}
}
if(process.env.AGENTMUX_AGENT_MENU_SCENE_RECEIPT){
  assert.ok(visualOnly&&agentMenuOwning,'An explicit Agent-menu scene receipt requires its original owning mode')
  const path=resolve(process.env.AGENTMUX_AGENT_MENU_SCENE_RECEIPT),saved=JSON.parse(await readFile(path,'utf8'))
  assert.equal(saved.schema,result.schema);assert.equal(saved.passed,true);assert.equal(saved.userRunTouched,false)
  assert.equal(saved.render.outcome.exitCode,0);assert.equal(saved.render.rendered.passed,true)
  assert.deepEqual(saved.menuOwnerSources,await menuOwnerHashes())
  assert.ok(saved.positioningInputs,'Actual captured Popper/Floating inputs are required')
  assert.deepEqual(saved.positioningInputs,await positioningBinding())
  await productionCallers()
  const callerFacts=items=>items.map(({symbol,definition,caller,kind,hits})=>({symbol,definition,caller,kind,hits}))
  assert.ok(saved.callers.length>0);assert.deepEqual(callerFacts(result.callers),callerFacts(saved.callers))
  const directory=join(path,'..'),fixed=JSON.parse(await readFile(join(directory,'fixed/compiled.json'),'utf8'))
  assert.ok(Object.keys(fixed.loadedSourceInputs).length>0&&Object.keys(fixed.compiledFiles).length>0)
  for(const[name,sha]of Object.entries(fixed.harnessInputs)){
    assert.equal(hash(await readFile(join(fixture,name))),sha);assert.equal(hash(await readFile(join(directory,'fixed','driver-'+name))),sha)
  }
  for(const[name,sha]of Object.entries(saved.menuOwnerSources)){
    const loaded=name.endsWith('.css')?fixed.importedStyleInputs[name]:fixed.loadedSourceInputs[name]
    if(loaded!==undefined)assert.equal(loaded,sha,'Original menu owner was actually compiled: '+name)
  }
  assert.ok(saved.render.rendered.frames.length>0)
  for(const frame of saved.render.rendered.frames){const bytes=await readFile(join(directory,'fixed',frame.file));assert.ok(bytes.length>0);assert.equal(hash(bytes),frame.png)}
  const mutants=saved.mutations.filter(item=>item.label==='shared-source-check-consumer-removed');assert.equal(mutants.length,1)
  const red=mutants[0].red;assert.equal(red.outcome.exitCode,1);assert.equal(red.rendered.failure.name,'AssertionError')
  assert.match(red.rendered.failure.message,/Maintenance preserves source checking and observation refresh/)
  const redCompiled=JSON.parse(await readFile(join(directory,'menu-shared-maintenance-red/compiled.json'),'utf8'))
  assert.ok(Object.keys(redCompiled.compiledFiles).length>0);assert.equal(redCompiled.sourceMutations.length,1)
  const mutation=redCompiled.sourceMutations[0];assert.equal(mutation.original,saved.menuOwnerSources[mutation.path]);assert.notEqual(mutation.original,mutation.mutated)
  for(const[label,message]of [['identity-header-layout-removed','Agent identity and copy actions share one compact header'],['tool-label-column-shifted','Tool labels align with the ordinary menu icon column']]){
    const entries=saved.mutations.filter(item=>item.label===label);assert.equal(entries.length,1)
    assert.equal(entries[0].red.outcome.exitCode,1);assert.equal(entries[0].red.rendered.failure.name,'AssertionError');assert.ok(entries[0].red.rendered.failure.message.includes(message))
    const compiled=JSON.parse(await readFile(join(entries[0].red.directory,'compiled.json'),'utf8'));assert.equal(compiled.progressCssMutations.length,1)
    assert.equal(compiled.progressCssMutations[0].productionWritten,false)
  }
  assert.equal(saved.cleanup.rootRemoved,true);assert.deepEqual(saved.cleanup.remaining,[])
  console.log(JSON.stringify({passed:true,exactEvidenceReused:true,receipt:path,frames:saved.render.rendered.frames.length,mutants:3}));process.exit(0)
}
const privateRoot=await mkdtemp(_hygiene_fixturePath("tmp/amx-identity-menu-"))
if(agentMenuOwning){result.menuOwnerSources=await menuOwnerHashes();result.positioningInputs=await positioningBinding()}
const sourceFiles=visualOnly?[]:(await exec('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:repository,maxBuffer:32*1024*1024})).stdout.split('\0').filter(Boolean)
if(!visualOnly)assert.ok(sourceFiles.length>0)
async function sources(){return Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,hash(await readFile(join(repository,name)))])))}
async function compiled(directory){
  const entries=await readdir(directory,{recursive:true,withFileTypes:true}),files={}
  for(const entry of entries){if(!entry.isFile())continue;const path=join(entry.parentPath,entry.name);files[path.slice(directory.length+1)]=hash(await readFile(path))}
  assert.ok(Object.keys(files).length>0,'The actual private renderer outputs are nonempty');return files
}
async function renderer(label,probe='complete',unreadableProgressActions=false,focusMutation=false,mailboxMutation='',menuMutation=false,menuRhythmMutation=''){
  const directory=join(evidence,label), outDir=join(privateRoot,label);await mkdir(directory,{recursive:true})
  const xtermFile=require.resolve('@xterm/xterm'), wrapper=join(privateRoot,'record-xterm.mjs')
  await writeFile(wrapper,`import xterm from ${JSON.stringify(xtermFile)};
    export class Terminal extends xterm.Terminal { constructor(...args){super(...args);const entries=globalThis.identityTerminals??=[];this.probeIdentity={id:entries.length,terminal:this,disposed:false};entries.push(this.probeIdentity)}
      dispose(){this.probeIdentity.disposed=true;return super.dispose()} }
  `)
  const cssPath=agentMenuOwning?join(desktop,'src/renderer/src/styles/agent-region-header.css'):composerToolbarOwning||mailboxLayoutOwning?join(repository,'packages/client-ui/src/styles/composer.css'):join(desktop,'src/renderer/src/styles',terminalLoadingOwning?'terminal.css':'agent.css'),cssBefore=await readFile(cssPath)
  const loadedSourceInputs={},importedStyleInputs={},progressCssMutations=[],sourceMutations=[],isolatedSourceInputs=[],positioningImports={}
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',worker:{format:'es'},resolve:{alias:[{find:/^@xterm\/xterm$/,replacement:wrapper}]},
    plugins:[{name:'record-private-renderer-inputs',enforce:'pre',async transform(source,id){
      if((id.startsWith(join(desktop,'src')+'/')||id.startsWith(join(repository,'packages/client-ui/src')+'/')||id.startsWith(fixture+'/'))&&!id.includes('?'))loadedSourceInputs[id.slice(repository.length+1)]=hash(source)
      if(agentMenuOwning&&['EditorPane','FileSurfaceView','GitBranchDiffPane'].some(name=>id===join(desktop,`src/renderer/src/components/${name}.tsx`))){
        const name=id.slice(id.lastIndexOf('/')+1,-4),code=`export function ${name}(){throw new Error('No File or Git editor belongs to the Agent menu scene.')}`
        isolatedSourceInputs.push({path:id.slice(repository.length+1),originalSHA256:hash(source),loadedSHA256:hash(code),boundary:'No File/Git Region in this scene; attempting to render its editor fails explicitly'})
        return code
      }
      if(menuMutation&&id===join(desktop,'src/renderer/src/components/AgentMenuContent.tsx')){
        const anchor='{nativeSourceCheck}'
        assert.equal(source.split(anchor).length,2,'Actual shared maintenance source-check consumer is unique')
        const altered=source.replace(anchor,'{null}')
        sourceMutations.push({path:id.slice(repository.length+1),original:hash(source),mutated:hash(altered),productionWritten:false})
        return altered
      }
      if(mailboxMutation==='compact'&&id===join(desktop,'src/renderer/src/components/SessionMailbox.tsx')){
        const anchor=/<InputMailboxRecords\s+compact(?=\s)/g
        assert.equal([...source.matchAll(anchor)].length,1,'The actual Desktop journal compact consumer is unique')
        const altered=source.replace(anchor,'<InputMailboxRecords ')
        sourceMutations.push({path:id.slice(repository.length+1),original:hash(source),mutated:hash(altered),productionWritten:false})
        return altered
      }
      if(focusMutation&&id===join(repository,'packages/client-ui/src/components/AgentComposer.tsx')){
        const anchor='onFocusCapture={(event) => {'
        assert.equal(source.split(anchor).length,2,'The actual Composer scroll handler is unique')
        const altered=source.replace(anchor,anchor+' return; // private mutation: remove focus scrolling\n')
        sourceMutations.push({path:id.slice(repository.length+1),original:hash(source),mutated:hash(altered),productionWritten:false})
        return altered
      }
      if(mailboxHoverMutation&&id===join(desktop,'src/renderer/src/components/SessionMailbox.tsx')){
        const anchor=';(popover.current!.showPopover as (options: { source: HTMLButtonElement }) => void)\n      .call(popover.current, { source: trigger.current! })'
        assert.equal(source.split(anchor).length,2,'The private mutation cuts exactly the actual hover-open call')
        const altered=source.replace(anchor,'void 0 // private mutation: cut actual hover open')
        await writeFile(join(directory,'mailbox-original.tsx'),source);await writeFile(join(directory,'mailbox-mutated.tsx'),altered)
        result.mutations.push({kind:'private-renderer-transform',file:id.slice(repository.length+1),original:hash(source),mutated:hash(altered),productionWritten:false})
        return altered
      }
    },async generateBundle(){
      for(const file of this.getWatchFiles())if((file.startsWith(join(desktop,'src')+'/')||file.startsWith(join(repository,'packages/client-ui/src')+'/'))&&file.endsWith('.css'))importedStyleInputs[file.slice(repository.length+1)]=hash(await readFile(file))
      if(agentMenuOwning)for(const file of this.getWatchFiles())if(Object.hasOwn(result.positioningInputs.files,file))positioningImports[file]=hash(await readFile(file))
    }}],
    css:{postcss:{plugins:[{postcssPlugin:'private-progress-controls',async Once(sheet){
      if(menuRhythmMutation){
        const identity=menuRhythmMutation==='identity',selector=identity?'.agent-region-menu__identity':':is(.agent-region-menu, .focus-context-menu) .workbench-layout-menu'
        const property=identity?'display':'padding',from=identity?'grid':'0 var(--sp-4)',to=identity?'block':'0 var(--sp-3)',declarations=[]
        sheet.walkRules(selector,rule=>{if(rule.source?.input.file===cssPath)rule.walkDecls(property,declaration=>declarations.push(declaration))})
        if(!declarations.length)return
        assert.equal(declarations.length,1,'The actual menu rhythm declaration is unique');assert.equal(declarations[0].value,from)
        declarations[0].value=to;progressCssMutations.push({path:cssPath.slice(repository.length+1),selector,property,from,to,productionWritten:false})
        return
      }
      if(mailboxMutation==='navigation'){
        const owners=[]
        sheet.walkRules('.composer-mailbox__folders',rule=>{if(rule.source?.input.file===cssPath)owners.push(rule)})
        if(!owners.length)return
        assert.equal(owners.length,1,'Actual imported Mailbox navigation rule is unique')
        owners[0].append({prop:'display',value:'flex'},{prop:'flex-wrap',value:'wrap'})
        sheet.append({selector:'.composer-mailbox__folders > button',nodes:[{prop:'flex',value:'1 1 calc(50% - var(--sp-1))'}]})
        progressCssMutations.push({path:cssPath.slice(repository.length+1),restoredOriginalLayout:'two-column flex navigation',productionWritten:false})
        return
      }
      if(!unreadableProgressActions)return
      if(composerToolbarOwning){
        const queries=[]
        sheet.walkAtRules('container',rule=>{if(rule.source?.input.file===cssPath&&rule.params==='composer (max-width: 400px)')queries.push(rule)})
        if(!queries.length)return
        assert.equal(queries.length,1,'The actual imported narrow Composer query is unique')
        const originalRules=".composer:not(:has(.composer-tools[data-mode='collapsed'])) .composer__toolbar { flex-wrap: wrap; gap: var(--sp-1); }\n.composer:not(:has(.composer-tools[data-mode='collapsed'])) .composer__toolbar > div:first-child { flex-basis: 100%; }\n.composer:not(:has(.composer-tools[data-mode='collapsed'])) .composer__toolbar > div:last-child { margin-inline-start: auto; }"
        queries[0].append(originalRules)
        progressCssMutations.push({path:cssPath.slice(repository.length+1),restoredOriginalRules:originalRules,productionWritten:false})
        return
      }
      const declarations=[]
      sheet.walkDecls('font',declaration=>{if(declaration.source?.input.file===cssPath&&declaration.parent.selector==='.continuous-progress-panel__actions button')declarations.push(declaration)})
      if(!declarations.length)return
      assert.equal(declarations.length,1,'Actual imported Progress control font is unique and nonempty')
      assert.equal(declarations[0].value,'inherit')
      declarations[0].value='0px sans-serif'
      progressCssMutations.push({path:cssPath.slice(repository.length+1),selector:'.continuous-progress-panel__actions button',property:'font',from:'inherit',to:'0px sans-serif',productionWritten:false})
    }}]}},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},
    build:{outDir,emptyOutDir:true,...(agentMenuOwning?{minify:false,cssMinify:false}:{}),commonjsOptions:{include:[/node_modules/,/xterm-locked-925/]}}})
  const compiledFiles=await compiled(outDir),terminalWrapperSha256=hash(await readFile(wrapper))
  assert.ok(Object.keys(loadedSourceInputs).length>0,'Actual renderer input collection is nonempty')
  assert.ok(cssBefore.length>0,'The actual owner stylesheet is nonempty')
  const cssKey=cssPath.slice(repository.length+1),cssAfter=await readFile(cssPath)
  assert.equal(importedStyleInputs[cssKey],hash(cssBefore),'The compiled renderer watches the exact owner CSS')
  assert.equal(hash(cssAfter),hash(cssBefore),'The owner CSS stays unchanged through compilation')
  assert.equal(progressCssMutations.length,unreadableProgressActions||mailboxMutation==='navigation'||menuRhythmMutation?1:0,'Requested actual CSS mutation is applied exactly once')
  assert.equal(sourceMutations.length,focusMutation||mailboxMutation==='compact'||menuMutation?1:0)
  const harnessInputs={}
  if(mailboxLayoutOwning||agentMenuOwning)for(const name of agentMenuOwning?['main.cjs','menu-product.cjs','entry.tsx']:['main.cjs','mailbox-layout.cjs']){
    const source=await readFile(join(fixture,name));harnessInputs[name]=hash(source)
    await writeFile(join(directory,`driver-${name}`),source)
  }
  if(agentMenuOwning){assert.ok(Object.keys(positioningImports).some(path=>path.includes('/@radix-ui/react-popper/')),'The actual Popper runtime entry was compiled');for(const[path,sha]of Object.entries(positioningImports))assert.equal(sha,result.positioningInputs.files[path])}
  await writeFile(join(directory,'compiled.json'),JSON.stringify({compiledFiles,terminalWrapperSha256,loadedSourceInputs,importedStyleInputs,progressCssMutations,sourceMutations,isolatedSourceInputs,positioningImports,harnessInputs,ownerCss:{path:cssKey,before:hash(cssBefore),after:hash(cssAfter)}},null,2))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const log=[]
  const outcome=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),join(outDir,'index.html'),privateRoot,directory,probe],{
    temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:90000,onLine:line=>log.push(line)})
  await writeFile(join(directory,'process.log'),log.join('\n'))
  const rendered=JSON.parse(await readFile(join(directory,'render.json'),'utf8'))
  assert.equal(outcome.timedOut,false);assert.equal(outcome.interruption,null)
  if(mailboxLayoutOwning||agentMenuOwning)await rm(outDir,{recursive:true})
  return{outcome,rendered,directory,compiledFiles,terminalWrapperSha256}
}
async function mutation(label,file,from,to,probe,message){
  const original=await readFile(file),text=original.toString()
  assert.equal(text.split(from).length,2,'Exactly one real source mutation anchor')
  const altered=Buffer.from(text.replace(from,to));let red
  await writeFile(join(evidence,`${label}-original.tsx`),original)
  await writeFile(join(evidence,`${label}-mutated.tsx`),altered)
  try{
    await writeFile(file,altered);red=await renderer(`${label}-red`,probe)
    assert.equal(red.outcome.exitCode,1);assert.equal(red.rendered.passed,false)
    assert.equal(red.rendered.failure.name,'AssertionError');assert.match(red.rendered.failure.message,message)
  }finally{await writeFile(file,original);assert.equal(hash(await readFile(file)),hash(original))}
  const control=await renderer(`${label}-restored`,probe)
  assert.equal(control.outcome.exitCode,0);assert.equal(control.rendered.passed,true)
  result.mutations.push({label,file,originalSha256:hash(original),mutatedSha256:hash(altered),red,control,restoredExactly:true})
}
async function productionCallers(){
  const contracts=[
    {symbol:'AgentRegionHeader',definition:'components/AgentRegionHeader.tsx',caller:'components/SessionPane.tsx',kind:'jsx'},
    {symbol:'useRegionMenuEntries',definition:'components/RegionContextMenu.tsx',caller:'components/AgentRegionHeader.tsx',kind:'call'},
    {symbol:'AgentMenuContent',definition:'components/AgentMenuContent.tsx',caller:'components/AgentRegionHeader.tsx',kind:'jsx'},
    {symbol:'AgentMenuContent',definition:'components/AgentMenuContent.tsx',caller:'components/FocusContextMenu.tsx',kind:'jsx'},
    {symbol:'useSessionStop',definition:'components/SessionStop.tsx',caller:'components/AgentRegionHeader.tsx',kind:'call'},
    {symbol:'RegionMenuEntryView',definition:'components/RegionContextMenu.tsx',caller:'components/AgentRegionHeader.tsx',kind:'jsx'},
    {symbol:'agentDisplayName',definition:'lib/workbench-tabs.ts',caller:'components/SessionPane.tsx',kind:'call'},
    {symbol:'closeRegion',definition:'store.ts',caller:'components/WorkspaceWorkbench.tsx',kind:'call'},
    {symbol:'useWorkbenchRegionLabels',definition:'lib/workbench-session-subscriptions.ts',caller:'components/WorkspaceWorkbench.tsx',kind:'call'},
    {symbol:'regionSwapMenuEntries',definition:'lib/workbench-tab-actions.ts',caller:'components/WorkspaceWorkbench.tsx',kind:'call'},
    {symbol:'swapRegions',definition:'store.ts',caller:'components/WorkspaceWorkbench.tsx',kind:'call'}
  ]
  for(const contract of contracts){
    assert.notEqual(contract.definition,contract.caller)
    const file=join(desktop,'src/renderer/src',contract.caller),text=await readFile(file,'utf8'),source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),hits=[]
    const visit=node=>{
      if(contract.kind==='call'&&ts.isCallExpression(node)&&node.expression.getText(source)===contract.symbol)hits.push(node.getText(source))
      if(contract.kind==='jsx'&&(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(source)===contract.symbol)hits.push(node.getText(source))
      ts.forEachChild(node,visit)
    };visit(source);assert.ok(hits.length>0,'Non-definition, non-import production caller '+contract.symbol)
    result.callers.push({...contract,hits,sourceSha256:hash(text)})
  }
}
async function restart(swapNames=false){
  const directory=join(privateRoot,swapNames?'restart-swap':'restart');await mkdir(directory)
  const receiptPath=join(evidence,swapNames?'restart-swap-raw-receipt.json':'restart-raw-receipt.json')
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  let outcome,detachedRuns;const log=[]
  const args=[join(desktop,'scripts/verify-workbench-persistence-restart.mjs'),'--identity-menu',`--probe-root=${directory}`,`--receipt-path=${receiptPath}`]
  if(swapNames)args.push('--swap-names')
  try{outcome=await runProbeProcess(process.execPath,args,{
    temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:125000,onLine:line=>log.push(line)})}
  finally{detachedRuns=await reapDetachedRuns(directory);await writeFile(join(evidence,swapNames?'restart-swap.log':'restart.log'),log.join('\n'))}
  assert.equal(outcome.exitCode,0);assert.equal(outcome.timedOut,false);assert.equal(outcome.interruption,null)
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'))
  assert.equal(receipt.passed,true);assert.equal(receipt.regionClose,false);assert.equal(receipt.identityMenu.passed,true)
  assert.equal(receipt.second.visibleRegions.length,swapNames?3:2);assert.equal(receipt.sameRunPid,true);assert.equal(receipt.privateInputAccepted,true)
  if(swapNames){assert.equal(receipt.swapNames.passed,true);assert.equal(receipt.swapNames.peers.length,2)}
  await writeFile(join(evidence,swapNames?'restart-swap.json':'restart.json'),JSON.stringify(receipt,null,2))
  return{outcome,detachedRuns,receipt}
}
try{
  await mkdir(evidence,{recursive:true});result.sourceCommit=(await exec('git',['rev-parse','HEAD'],{cwd:repository})).stdout.trim()
  if(!visualOnly)result.sourceBefore=await sources()
  const swapOnly=process.argv.includes('--swap-render-only')
  result.render=await renderer('fixed',visualOnly?(agentMenuOwning?'agent-menu-owning':mailboxLayoutOwning?'mailbox-layout-owning':composerToolbarOwning?'composer-toolbar-owning':mailboxMotionOwning?'mailbox-motion-owning':messageFeedbackOwning?'message-feedback-owning':terminalLoadingOwning?'terminal-loading-owning':progressLayoutOwning?'composer-layout-owning':'composer-visual'):swapOnly?'swap-full':'complete');assert.equal(result.render.outcome.exitCode,0,JSON.stringify(result.render.rendered.failure));assert.equal(result.render.rendered.passed,true)
  if(visualOnly){
    if(agentMenuOwning){
      await productionCallers()
      const red=await renderer('menu-shared-maintenance-red','agent-menu-owning',false,false,'',true)
      assert.equal(red.outcome.exitCode,1);assert.equal(red.rendered.failure.name,'AssertionError')
      assert.match(red.rendered.failure.message,/Maintenance preserves source checking and observation refresh/)
      // The mutant exists only in its private compilation. Reuse the unchanged
      // fixed candidate's successful run instead of rebuilding and rerunning it.
      const restored=result.render
      assert.equal(restored.outcome.exitCode,0,JSON.stringify(restored.rendered.failure));assert.equal(restored.rendered.passed,true)
      result.mutations.push({label:'shared-source-check-consumer-removed',red,restored,productionWritten:false})
      for(const[label,kind,message]of [['identity-header-layout-removed','identity','Agent identity and copy actions share one compact header'],['tool-label-column-shifted','alignment','Tool labels align with the ordinary menu icon column']]){
        const red=await renderer(label,'agent-menu-owning',false,false,'',false,kind)
        assert.equal(red.outcome.exitCode,1);assert.equal(red.rendered.failure.name,'AssertionError');assert.ok(red.rendered.failure.message.includes(message),JSON.stringify(red.rendered.failure))
        result.mutations.push({label,red,restored:result.render,productionWritten:false})
      }
    }
    if(mailboxLayoutOwning){
      const navigationRed=await renderer('mailbox-navigation-red','mailbox-layout-owning',false,false,'navigation')
      assert.equal(navigationRed.outcome.exitCode,1);assert.equal(navigationRed.rendered.failure.name,'AssertionError');assert.match(navigationRed.rendered.failure.message,/Mailbox navigation uses the original regular grid/)
      const compactRed=await renderer('mailbox-compact-red','mailbox-layout-owning',false,false,'compact')
      assert.equal(compactRed.outcome.exitCode,1);assert.equal(compactRed.rendered.failure.name,'AssertionError');assert.match(compactRed.rendered.failure.message,/Desktop input journal consumes the shared compact record frame/)
      result.mutations.push({label:'mailbox-original-flex-navigation',red:navigationRed,productionWritten:false},{label:'mailbox-desktop-compact-consumer-removed',red:compactRed,productionWritten:false})
    }
    if(composerToolbarOwning){
      const red=await renderer('toolbar-wrap-red','composer-toolbar-owning',true)
      assert.equal(red.outcome.exitCode,1);assert.equal(red.rendered.failure.name,'AssertionError');assert.match(red.rendered.failure.message,/Left tools and Session controls share one toolbar row/)
      result.mutations.push({label:'original-narrow-toolbar-wrap',red,productionWritten:false})
      const focusRed=await renderer('toolbar-focus-red','composer-toolbar-owning',false,true)
      assert.equal(focusRed.outcome.exitCode,1);assert.equal(focusRed.rendered.failure.name,'AssertionError');assert.match(focusRed.rendered.failure.message,/Keyboard-reached tool has a real visible hit target/)
      result.mutations.push({label:'toolbar-focus-scroll-removed',red:focusRed,productionWritten:false})
    }
    if(progressLayoutOwning){
      const red=await renderer('progress-controls-red','composer-layout-owning',true)
      assert.equal(red.outcome.exitCode,1);assert.equal(red.rendered.failure.name,'AssertionError');assert.match(red.rendered.failure.message,/Progress action text is readable/)
      const restored=await renderer('progress-controls-restored','composer-layout-owning')
      assert.equal(restored.outcome.exitCode,0,JSON.stringify(restored.rendered.failure));assert.equal(restored.rendered.passed,true)
      result.mutations.push({label:'actual-progress-control-text-hidden',red,restored,productionWritten:false})
    }
    await writeFile(join(evidence,'review.md'),[
      '# 本次采图：等待独立 Agent 实际看图',
      '',
      '采集成功不等于审美通过。实际场景使用 WorkspaceWorkbench → SessionPane → AgentSessionComposer 和产品 CSS；数据来自 preview API，不证明真实 CLI、Native 或安装。未操作用户 App/Run。',
      `HEAD 诊断：\`${result.sourceCommit}\`。采集当前工作树的私有编译；HEAD 不代表未提交内容。实际产物身份见 [compiled.json](fixed/compiled.json)，采集结果见 [render.json](fixed/render.json)。`,
      '',
      ...result.render.rendered.frames.map(frame=>`- ${frame.width}px viewport / ${frame.state}：[截图](fixed/${frame.file}) · SHA-256 \`${frame.png}\``),
      '',
      '独立 Agent：先读 docs/design/agentmux-desktop-interaction.md 与 docs/design/agentmux-surface-density.md 的有关约束，逐张打开以上完整截图，结合真实操作顺序判断主次、紧凑、对齐、留白、可读性和控件清晰性。说明具体位置、观感与修正建议；未看到或未确认的范围写明未知。不要用像素阈值、差异分数或 CSS 在场替代看图。',
      '在短评审记录中写下实际看过的截图、结论和边界。需修改时修正后重新采集同一场景，并由独立 Agent 再看图；不能把这份采图清单当作已完成评审。',
      ''
    ].join('\n'))
  }else if(!process.argv.includes('--render-only')&&!swapOnly){
    await mutation('name',join(desktop,'src/renderer/src/components/AgentRegionHeader.tsx'),'>{name}</strong>',">{''}</strong>",'name',/Actual Agent name is nonempty/)
    await mutation('target',join(desktop,'src/renderer/src/components/WorkspaceWorkbench.tsx'),
      'split: (direction) => splitRegion(tab.workspaceId, tab.id, node.regionId, direction)',
      'split: (direction) => splitRegion(tab.workspaceId, tab.id, tab.layout.activeRegionId, direction)','target',/^Expected values to be strictly deep-equal:/)
    await mutation('swap-name',join(desktop,'src/renderer/src/components/WorkspaceWorkbench.tsx'),
      'label: facts ? agentDisplayName(facts) : regionSurfaceLabel(region, sessions)',
      'label: regionSurfaceLabel(region, sessions)','swap-name',/Swap targets use the actual current Header display-name chain/)
    await mutation('swap-target',join(desktop,'src/renderer/src/components/WorkspaceWorkbench.tsx'),
      'swap: (a, b) => swapRegions(tab.workspaceId, tab.id, a, b)',
      'swap: (a, b) => swapRegions(tab.workspaceId, tab.id, a, tab.layout.activeRegionId)','swap-target',/The original source swaps only with the selected third target/)
    await productionCallers();result.restart=await restart();result.swapRestart=await restart(true)
  }else result.diagnosticOnly=true
  if(!visualOnly){result.sourceAfter=await sources();assert.deepEqual(result.sourceAfter,result.sourceBefore)}
  if(agentMenuOwning){assert.deepEqual(await menuOwnerHashes(),result.menuOwnerSources,'The exact menu candidate remains unchanged');assert.deepEqual(await positioningBinding(),result.positioningInputs,'The actual positioning dependency and patch remain unchanged')}
  result.passed=true
}catch(error){result.failure={name:error.name,message:error.message}}
finally{
  result.cleanup.errors=[]
  try{await stopProbeProcesses(process.pid+1000000000,privateRoot)}catch(error){result.cleanup.errors.push({step:'stop-owned-processes',name:error.name,message:error.message,signal:error.signal??null})}
  try{result.cleanup.remaining=await listProbeProcesses(process.pid+1000000000,privateRoot)}catch(error){result.cleanup.remaining=null;result.cleanup.errors.push({step:'observe-owned-processes',name:error.name,message:error.message,signal:error.signal??null})}
  if(Array.isArray(result.cleanup.remaining)&&result.cleanup.remaining.length===0){await rm(privateRoot,{recursive:true});result.cleanup.rootRemoved=true}
  if(result.cleanup.errors.length||result.cleanup.remaining?.length){result.passed=false;result.cleanup.privateRoot=privateRoot;result.failure??={name:'Error',message:'Owned probe cleanup is unconfirmed; its private root is retained.'}}
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2))
}
console.log(JSON.stringify({passed:result.passed,captureOnly:result.captureOnly,aestheticReview:result.aestheticReview,diagnosticOnly:result.diagnosticOnly,frames:result.render?.rendered.frames.length,receipt:join(evidence,'receipt.json'),...(visualOnly?{review:join(evidence,'review.md')}:{}) ,failure:result.failure}))
if(!result.passed)process.exitCode=1
