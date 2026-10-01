import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { listProbeProcesses, stopProbeProcesses, runProbeProcess } from './probe-process.mjs'
import { reapDetachedRuns } from './probe-owned-run.mjs'

const desktop=resolve(import.meta.dirname,'..'), repository=resolve(desktop,'../..')
const require=createRequire(import.meta.url), exec=promisify(execFile), {build}=await import('vite'), ts=require('typescript')
const privateRoot=await mkdtemp('/tmp/amx-identity-menu-')
const evidence=join(repository,'.tmp/agent-region-identity-menu',`attempt-${Date.now()}`), fixture=join(desktop,'scripts/fixtures/agent-region-identity-menu')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const visualOnly=process.argv.includes('--visual-only')
const progressLayoutOwning=process.argv.includes('--progress-layout-owning')
const terminalLoadingOwning=process.argv.includes('--terminal-loading-owning')
const mailboxHoverMutation=process.argv.includes('--mailbox-hover-mutation')
assert.ok(!mailboxHoverMutation||visualOnly,'Mailbox hover mutation stays in the private visual compilation')
assert.ok(!progressLayoutOwning||visualOnly,'Progress layout owning uses only the private visual fixture')
assert.ok(!terminalLoadingOwning||visualOnly,'Terminal loading owning uses only the private visual fixture')
assert.ok(!terminalLoadingOwning||!progressLayoutOwning,'The private owning modes have distinct scenes')
const result={schema:'agentmux.region-identity-menu-delivery.v1',passed:false,sourceBefore:{},sourceAfter:{},mutations:[],callers:[],cleanup:{},userRunTouched:false,
  ...(visualOnly?{captureOnly:true,aestheticReview:'not-performed'}:{})}
const sourceFiles=visualOnly?[]:(await exec('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:repository,maxBuffer:32*1024*1024})).stdout.split('\0').filter(Boolean)
if(!visualOnly)assert.ok(sourceFiles.length>0)
async function sources(){return Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,hash(await readFile(join(repository,name)))])))}
async function compiled(directory){
  const entries=await readdir(directory,{recursive:true,withFileTypes:true}),files={}
  for(const entry of entries){if(!entry.isFile())continue;const path=join(entry.parentPath,entry.name);files[path.slice(directory.length+1)]=hash(await readFile(path))}
  assert.ok(Object.keys(files).length>0,'The actual private renderer outputs are nonempty');return files
}
async function renderer(label,probe='complete',unreadableProgressActions=false){
  const directory=join(evidence,label), outDir=join(privateRoot,label);await mkdir(directory,{recursive:true})
  const xtermFile=require.resolve('@xterm/xterm'), wrapper=join(privateRoot,'record-xterm.mjs')
  await writeFile(wrapper,`import xterm from ${JSON.stringify(xtermFile)};
    export class Terminal extends xterm.Terminal { constructor(...args){super(...args);const entries=globalThis.identityTerminals??=[];this.probeIdentity={id:entries.length,terminal:this,disposed:false};entries.push(this.probeIdentity)}
      dispose(){this.probeIdentity.disposed=true;return super.dispose()} }
  `)
  const cssPath=join(desktop,'src/renderer/src/styles',terminalLoadingOwning?'terminal.css':'agent.css'),cssBefore=await readFile(cssPath)
  const loadedSourceInputs={},importedStyleInputs={},progressCssMutations=[]
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:[{find:/^@xterm\/xterm$/,replacement:wrapper}]},
    plugins:[{name:'record-private-renderer-inputs',enforce:'pre',async transform(source,id){
      if((id.startsWith(join(desktop,'src')+'/')||id.startsWith(fixture+'/'))&&!id.includes('?'))loadedSourceInputs[id.slice(repository.length+1)]=hash(source)
      if(mailboxHoverMutation&&id===join(desktop,'src/renderer/src/components/SessionMailbox.tsx')){
        const anchor=';(popover.current!.showPopover as (options: { source: HTMLButtonElement }) => void)\n      .call(popover.current, { source: trigger.current! })'
        assert.equal(source.split(anchor).length,2,'The private mutation cuts exactly the actual hover-open call')
        const altered=source.replace(anchor,'void 0 // private mutation: cut actual hover open')
        await writeFile(join(directory,'mailbox-original.tsx'),source);await writeFile(join(directory,'mailbox-mutated.tsx'),altered)
        result.mutations.push({kind:'private-renderer-transform',file:id.slice(repository.length+1),original:hash(source),mutated:hash(altered),productionWritten:false})
        return altered
      }
    },async generateBundle(){
      for(const file of this.getWatchFiles())if(file.startsWith(join(desktop,'src')+'/')&&file.endsWith('.css'))importedStyleInputs[file.slice(repository.length+1)]=hash(await readFile(file))
    }}],
    css:{postcss:{plugins:[{postcssPlugin:'private-progress-controls',async Once(sheet){
      if(!unreadableProgressActions)return
      const declarations=[]
      sheet.walkDecls('font',declaration=>{if(declaration.source?.input.file===cssPath&&declaration.parent.selector==='.continuous-progress-panel__actions button')declarations.push(declaration)})
      if(!declarations.length)return
      assert.equal(declarations.length,1,'Actual imported Progress control font is unique and nonempty')
      assert.equal(declarations[0].value,'inherit')
      declarations[0].value='0px sans-serif'
      progressCssMutations.push({path:cssPath.slice(repository.length+1),selector:'.continuous-progress-panel__actions button',property:'font',from:'inherit',to:'0px sans-serif',productionWritten:false})
    }}]}},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},
    build:{outDir,emptyOutDir:true,commonjsOptions:{include:[/node_modules/,/xterm-locked-925/]}}})
  const compiledFiles=await compiled(outDir),terminalWrapperSha256=hash(await readFile(wrapper))
  assert.ok(Object.keys(loadedSourceInputs).length>0,'Actual renderer input collection is nonempty')
  assert.ok(cssBefore.length>0,'The actual owner stylesheet is nonempty')
  const cssKey=cssPath.slice(repository.length+1),cssAfter=await readFile(cssPath)
  assert.equal(importedStyleInputs[cssKey],hash(cssBefore),'The compiled renderer watches the exact owner CSS')
  assert.equal(hash(cssAfter),hash(cssBefore),'The owner CSS stays unchanged through compilation')
  assert.equal(progressCssMutations.length,unreadableProgressActions?1:0,'Requested actual Progress CSS mutation is applied exactly once')
  await writeFile(join(directory,'compiled.json'),JSON.stringify({compiledFiles,terminalWrapperSha256,loadedSourceInputs,importedStyleInputs,progressCssMutations,ownerCss:{path:cssKey,before:hash(cssBefore),after:hash(cssAfter)}},null,2))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const log=[]
  const outcome=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),join(outDir,'index.html'),privateRoot,directory,probe],{
    temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:90000,onLine:line=>log.push(line)})
  await writeFile(join(directory,'process.log'),log.join('\n'))
  const rendered=JSON.parse(await readFile(join(directory,'render.json'),'utf8'))
  assert.equal(outcome.timedOut,false);assert.equal(outcome.interruption,null)
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
    {symbol:'RegionMenuEntryView',definition:'components/RegionContextMenu.tsx',caller:'components/AgentRegionHeader.tsx',kind:'jsx'},
    {symbol:'agentDisplayName',definition:'lib/workbench-tabs.ts',caller:'components/SessionPane.tsx',kind:'call'},
    {symbol:'closeRegion',definition:'store.ts',caller:'components/WorkspaceWorkbench.tsx',kind:'call'},
    {symbol:'agentDisplayName',definition:'lib/workbench-tabs.ts',caller:'components/WorkspaceWorkbench.tsx',kind:'call'},
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
  result.render=await renderer('fixed',visualOnly?(terminalLoadingOwning?'terminal-loading-owning':progressLayoutOwning?'composer-layout-owning':'composer-visual'):swapOnly?'swap-full':'complete');assert.equal(result.render.outcome.exitCode,0,JSON.stringify(result.render.rendered.failure));assert.equal(result.render.rendered.passed,true)
  if(visualOnly){
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
      ...result.render.rendered.frames.map(frame=>`- ${frame.width}px Region / ${frame.state}：[截图](fixed/${frame.file}) · SHA-256 \`${frame.png}\``),
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
  result.passed=true
}catch(error){result.failure={name:error.name,message:error.message}}
finally{
  await stopProbeProcesses(process.pid+1000000000,privateRoot);result.cleanup.remaining=await listProbeProcesses(process.pid+1000000000,privateRoot);assert.deepEqual(result.cleanup.remaining,[])
  await rm(privateRoot,{recursive:true});result.cleanup.rootRemoved=true
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2))
}
console.log(JSON.stringify({passed:result.passed,captureOnly:result.captureOnly,aestheticReview:result.aestheticReview,diagnosticOnly:result.diagnosticOnly,frames:result.render?.rendered.frames.length,receipt:join(evidence,'receipt.json'),...(visualOnly?{review:join(evidence,'review.md')}:{}) ,failure:result.failure}))
if(!result.passed)process.exitCode=1
