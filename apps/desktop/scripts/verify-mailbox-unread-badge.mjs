import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const mode = process.argv[2], exec = promisify(execFile), require = createRequire(import.meta.url)
assert.ok(mode === '--mutations' || mode === '--native', 'Choose the approved Mailbox proof')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const privateRoot = await mkdtemp('/tmp/amx-mailbox-badge-'), evidence = join(root, '.tmp/mailbox-unread-badge', mode.slice(2)+'-'+Date.now())
const result = { schema: 'agentmux.mailbox-unread-badge-proof.v1', mode, passed: false, userRunTouched: false, sharedSourceWritten: false,
  aestheticReview: 'not-performed', mutations: [], cleanup: {} }
const productPaths = ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'apps/desktop/src/renderer/src/styles/composer.css']
const originals = Object.fromEntries(await Promise.all(productPaths.map(async path => [path, await readFile(join(root,path),'utf8')])))
await mkdir(evidence,{recursive:true})
async function sourceTest(label, expectRed) {
  let code = 0, output = ''
  try { const value = await exec(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config','apps/desktop/scripts/fixtures/mailbox-badge/vitest.config.mts','apps/desktop/test/session-mailbox.test.tsx','apps/desktop/test/session-mailbox-receipts.test.tsx','--maxWorkers=1'],{cwd:privateRoot,timeout:60000,maxBuffer:4*1024*1024}); output=value.stdout+value.stderr }
  catch(error) { code=error.code; output=(error.stdout??'')+(error.stderr??'') }
  await writeFile(join(evidence,label+'.log'),output)
  if(expectRed){assert.equal(typeof code,'number');assert.notEqual(code,0);assert.match(output,/AssertionError:/,'Actual mounted assertion must fail, not import or timeout')}
  else assert.equal(code,0,label+': restored candidate must pass')
  return {code,assertionRed:expectRed,log:label+'.log'}
}
async function mutations() {
  for(const dir of ['apps/desktop/src','apps/desktop/test','apps/desktop/resources','packages/core/src','packages/demand/src','packages/layout/src']) await cp(join(root,dir),join(privateRoot,dir),{recursive:true,preserveTimestamps:true})
  for(const path of ['package.json','pnpm-workspace.yaml','tsconfig.base.json','vitest.setup.ts','apps/desktop/package.json','apps/desktop/tsconfig.json','packages/core/package.json','apps/desktop/scripts/fixtures/mailbox-badge/vitest.config.mts','apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts']) await cp(join(root,path),join(privateRoot,path),{preserveTimestamps:true})
  for(const path of ['node_modules','apps/desktop/node_modules','packages/core/node_modules','packages/demand/node_modules','packages/layout/node_modules']) await symlink(join(root,path),join(privateRoot,path),'dir')
  result.baseline=await sourceTest('baseline',false)
  const file=productPaths[0],original=originals[file]
  const cases=[
    {name:'positive-unread-hidden',from:'{unread ? <span className="composer-mailbox__unread"',to:'{false ? <span className="composer-mailbox__unread"'},
    {name:'pending-added-to-unread',from:'const unread = receipts.unread.length + system.unread.length',to:'const unread = receipts.unread.length + system.unread.length + queued.length'},
    {name:'cap-loses-exact-count-and-a11y',from:'const unread = receipts.unread.length + system.unread.length',to:'const unread = Math.min(99, receipts.unread.length + system.unread.length)'}
  ]
  for(const item of cases){assert.equal(original.split(item.from).length,2);await writeFile(join(privateRoot,file),original.replace(item.from,item.to));const red=await sourceTest(item.name,true);await writeFile(join(privateRoot,file),original);const restored=await sourceTest(item.name+'-restored',false);result.mutations.push({...item,file,originalSha256:hash(original),red,restored,sharedSourceWritten:false})}
}
async function compiled(dir) {
  const files=await readdir(dir,{recursive:true,withFileTypes:true}),out={}
  for(const file of files) if(file.isFile()){const path=join(file.parentPath,file.name);out[path.slice(dir.length+1)]=hash(await readFile(path))}
  assert.ok(Object.keys(out).length>0);return out
}
async function native(label, oldSize=false) {
  const {build}=await import('vite'),fixture=join(desktop,'scripts/fixtures/mailbox-badge'),directory=join(evidence,label),processRoot=join(privateRoot,label),outDir=join(processRoot,'out')
  await mkdir(directory,{recursive:true});await mkdir(processRoot,{recursive:true})
  const wrapper=join(processRoot,'record-xterm.mjs'),main=join(processRoot,'probe-main.cjs'),mainBytes=await readFile(join(fixture,'main.cjs'))
  await writeFile(main,mainBytes)
  await writeFile(wrapper,`import xterm from ${JSON.stringify(require.resolve('@xterm/xterm'))};\nexport class Terminal extends xterm.Terminal{constructor(...args){super(...args);const entries=globalThis.resultReadyTerminals??=[];this.probeIdentity={id:entries.length,terminal:this,disposed:false};entries.push(this.probeIdentity)}dispose(){this.probeIdentity.disposed=true;return super.dispose()}}\n`)
  const loadedSourceInputs={},importedStyleInputs={},mutationRecords=[]
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:[
    {find:/^@xterm\/xterm$/,replacement:wrapper},
    // Current control has a new errors import absent from shared dist. Only this exact public entry
    // uses its actual source; other Runtime entries keep the existing compiled package resolution.
    {find:/^@agentmux\/core\/control$/,replacement:join(root,'packages/core/src/control.ts')}
  ]},plugins:[{name:'mailbox-badge-private-production',enforce:'pre',async transform(source,id){
    if((id.startsWith(join(desktop,'src')+'/')||id.startsWith(join(desktop,'scripts/fixtures')+'/')||id.startsWith(join(root,'packages/core/src')+'/'))&&!id.includes('?'))loadedSourceInputs[id.slice(root.length+1)]=hash(source)
  },async generateBundle(){for(const file of this.getWatchFiles())if(file.startsWith(join(desktop,'src')+'/')&&file.endsWith('.css'))importedStyleInputs[file.slice(root.length+1)]=hash(await readFile(file))}}],
  css:{postcss:{plugins:[{postcssPlugin:'mailbox-badge-actual-imported-css',async Once(sheet){
    if(!oldSize)return
    const file=join(root,productPaths[1]),declarations=[]
    // CSS @imports are consumed by PostCSS rather than a separate Rollup transform.
    sheet.walkDecls('height',d=>{if(d.source?.input.file===file&&d.parent.selector==='.composer-mailbox__unread')declarations.push(d)})
    if(!declarations.length)return
    assert.equal(declarations.length,1,'The actual imported badge height declaration is unique and nonempty')
    const originalValue=declarations[0].value;assert.match(originalValue,/^var\(--fs-(micro|meta)\)$/)
    const source=await readFile(file,'utf8'),blocks=source.match(/\.composer-mailbox__unread\s*\{[^}]*\}/g)
    assert.ok(blocks?.length);assert.equal(blocks.length,1)
    const from=`height: ${originalValue};`,to='height: 12px;';assert.equal(blocks[0].split(from).length,2)
    const changed=source.replace(blocks[0],blocks[0].replace(from,to));declarations[0].value='12px'
    await writeFile(join(directory,'original.css'),source);await writeFile(join(directory,'mutated.css'),changed)
    mutationRecords.push({file:productPaths[1],originalSha256:hash(source),mutatedSha256:hash(changed),astDeclaration:{selector:'.composer-mailbox__unread',property:'height',originalValue,mutatedValue:'12px'},sharedSourceWritten:false})
  }}]}},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},build:{outDir,emptyOutDir:true,commonjsOptions:{include:[/node_modules/,/xterm-locked-925/]}}})
  assert.equal(mutationRecords.length,oldSize?1:0,'A requested production CSS mutation must be applied exactly once')
  for(const path of ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx','apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx','apps/desktop/src/renderer/src/components/AgentAvatar.tsx','packages/core/src/control.ts','packages/core/src/errors.ts'])assert.ok(loadedSourceInputs[path],'Actual source consumed: '+path)
  for(const path of ['apps/desktop/src/renderer/src/styles/composer.css','apps/desktop/src/renderer/src/styles/agent-avatar.css'])assert.equal(importedStyleInputs[path],hash(await readFile(join(root,path))))
  const identity={loadedSourceInputs,importedStyleInputs,compiledFiles:await compiled(outDir),privateMainSha256:hash(mainBytes),terminalWrapperSha256:hash(await readFile(wrapper)),electronVersion:require('electron/package.json').version,exactCoreControlSourceAlias:true,otherRuntimeEntries:'existing compiled package; private preview does not certify real Runtime',mutationRecords}
  await writeFile(join(directory,'compiled.json'),JSON.stringify(identity,null,2))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const lines=[],outcome=await runProbeProcess(require('electron'),[main,join(outDir,'index.html'),processRoot,directory],{temporaryRoot:processRoot,cwd:root,env,timeoutMs:60000,onLine:line=>lines.push(line)})
  await writeFile(join(directory,'process.log'),lines.join('\n'))
  const rendered=JSON.parse(await readFile(join(directory,'render.json'),'utf8'))
  assert.equal(outcome.timedOut,false);assert.equal(outcome.interruption,null)
  return {directory,outcome,rendered,identity}
}
try {
  result.sourceCommit=(await exec('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim()
  result.productSources=Object.fromEntries(Object.entries(originals).map(([path,value])=>[path,hash(value)]))
  if(mode==='--mutations')await mutations()
  else {
    result.candidate=await native('candidate');assert.equal(result.candidate.outcome.exitCode,0,result.candidate.rendered.failure?.message);assert.equal(result.candidate.rendered.passed,true)
    const red=await native('geometry-red',true);assert.equal(red.outcome.exitCode,1);assert.equal(red.rendered.failure.name,'AssertionError');assert.match(red.rendered.failure.message,/Unread badge.*(compact|area)/)
    const restored=await native('geometry-restored');assert.equal(restored.outcome.exitCode,0,restored.rendered.failure?.message);assert.equal(restored.rendered.passed,true)
    result.mutations.push({name:'badge-restores-old-12px-height',red,restored,sharedSourceWritten:false})
  }
  for(const [path,bytes]of Object.entries(originals))assert.equal(hash(await readFile(join(root,path))),hash(bytes),'Owned source unchanged by private proof: '+path)
  result.passed=true
}catch(error){result.failure={name:error.name,message:error.message,stack:error.stack}}
finally {
  const before=await listProbeProcesses(-1,privateRoot);for(const pid of before)await signalOwnedProbeProcess(pid,privateRoot,'SIGKILL')
  result.cleanup={before,after:await listProbeProcesses(-1,privateRoot)};assert.equal(result.cleanup.after.length,0);await rm(privateRoot,{recursive:true,force:true});result.cleanup.temporaryRootRemoved=true
  result.privateRoot=privateRoot;await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2))
  if(mode==='--native')await writeFile(join(evidence,'review.md'),`# 邮箱数字角标\n\n实际Workbench/Composer/Mailbox/Avatar/xterm与生产CSS，私有preview事实及输入回路。只对exactCoreControl使用实际control/errors source，其余Core沿既有compiled resolution；不签真实CLI/Runtime或T002恢复。\n\n[身份、geometry RED/restored与cleanup](./receipt.json)。独立审美未执行。\n\n${(result.candidate?.rendered.frames??[]).map(f=>`- ${f.scene.width}px ${f.scene.appearance}/${f.scene.mode}: [${f.file}](./candidate/${f.file})`).join('\n')}\n`)
  console.log(JSON.stringify({passed:result.passed,evidence,receipt:join(evidence,'receipt.json'),failure:result.failure??null}));process.exitCode=result.passed?0:1
}
