import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
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
const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amx-mailbox-reading-")), evidence = join(root, '.tmp/mailbox-reading-flow', mode.slice(2)+'-'+globalThis.crypto.randomUUID())
const result = { schema: 'agentmux.mailbox-reading-flow-proof.v1', mode, passed: false, userRunTouched: false, sharedSourceWritten: false,
  aestheticReview: 'not-performed', mutations: [], cleanup: {} }
const productPaths = ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'packages/client-ui/src/styles/composer.css', 'apps/desktop/src/renderer/src/components/ComposerOutbox.tsx', 'apps/desktop/src/renderer/src/components/MailboxReading.tsx',
  'packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/ConversationInputDetails.tsx',
  'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/SessionPane.tsx', 'packages/client-ui/src/styles/conversation-message.css', 'packages/client-ui/src/styles/markdown.css']
const originals = Object.fromEntries(await Promise.all(productPaths.map(async path => [path, await readFile(join(root,path),'utf8')])))
await mkdir(evidence,{recursive:true})
async function sourceTest(label, expectRed) {
  let code = 0, output = ''
  try { const value = await exec(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config','apps/desktop/scripts/fixtures/mailbox-reading-flow/vitest.config.mts','apps/desktop/test/session-mailbox.test.tsx','apps/desktop/test/session-mailbox-receipts.test.tsx','apps/desktop/test/session-mailbox-reading-flow.test.tsx','apps/desktop/test/conversation-message-actions.test.tsx','packages/client-ui/test/shared-conversation.test.tsx','--maxWorkers=1'],{cwd:privateRoot,timeout:60000,maxBuffer:4*1024*1024}); output=value.stdout+value.stderr }
  catch(error) { code=error.code; output=(error.stdout??'')+(error.stderr??'') }
  await writeFile(join(evidence,label+'.log'),output)
  if(expectRed){assert.equal(typeof code,'number');assert.notEqual(code,0);assert.match(output,/AssertionError:/,'Actual mounted assertion must fail, not import or timeout')}
  else assert.equal(code,0,label+': restored candidate must pass')
  return {code,assertionRed:expectRed,log:label+'.log'}
}
async function mutations() {
  for(const dir of ['apps/desktop/src','apps/desktop/test/helpers','apps/desktop/resources','packages/core/src','packages/demand/src','packages/layout/src','packages/client-ui/src']) await cp(join(root,dir),join(privateRoot,dir),{recursive:true,preserveTimestamps:true})
  for(const path of ['package.json','pnpm-workspace.yaml','tsconfig.base.json','vitest.setup.ts','apps/desktop/package.json','apps/desktop/tsconfig.json','packages/core/package.json','packages/client-ui/package.json','packages/client-ui/tsconfig.json','packages/client-ui/test/shared-conversation.test.tsx','apps/desktop/test/session-mailbox.test.tsx','apps/desktop/test/session-mailbox-receipts.test.tsx','apps/desktop/test/session-mailbox-reading-flow.test.tsx','apps/desktop/test/conversation-message-actions.test.tsx','apps/desktop/scripts/fixtures/mailbox-reading-flow/vitest.config.mts','apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts']) await cp(join(root,path),join(privateRoot,path),{preserveTimestamps:true})
  for(const path of ['node_modules','apps/desktop/node_modules','packages/core/node_modules','packages/demand/node_modules','packages/layout/node_modules','packages/client-ui/node_modules']) await symlink(join(root,path),join(privateRoot,path),'dir')
  result.baseline=await sourceTest('baseline',false)
  const messageStart = originals[productPaths[0]].indexOf('    <ConversationMessage')
  const messageEnd = originals[productPaths[0]].indexOf('</dl>} />', messageStart)
  assert.ok(messageStart >= 0 && messageEnd > messageStart, 'The actual selected shared message block is present and nonempty')
  const messageBlock = originals[productPaths[0]].slice(messageStart, messageEnd + '</dl>} />'.length)
  assert.match(messageBlock, /contentParts/)
  const cases=[
    {name:'selected-detail-no-shared-consumer',file:productPaths[0],from:messageBlock,to:'    <p>{selected.content}</p>'},
    {name:'native-parts-lost',file:productPaths[0],from:"content={isUserMessage(selected) && selected.contentParts.length > 0 ? selected.contentParts : selected.content ?? ''}",to:"content={selected.content ?? ''}"},
    {name:'unknown-record-shown-as-you',file:productPaths[4],from:'recordedIdentity ? recordedSpeaker : speakerForDisplay(recordedSpeaker)',to:'speakerForDisplay(recordedSpeaker)'},
    {name:'original-copy-truncated',file:productPaths[4],from:"const text = copyText ?? parts.map(partText).filter((t) => t.length > 0).join('\\n')",to:"const text = (copyText ?? parts.map(partText).filter((t) => t.length > 0).join('\\n')).slice(0,240)"},
    {name:'unaccepted-copy-called-success',file:productPaths[4],from:'if (accepted) {',to:'if (accepted || onCopy) {'},
    {name:'reading-context-lost',file:productPaths[0],from:'<ConversationMessage {...reading}',to:'<ConversationMessage'},
    {name:'wrong-selected-action-id',file:productPaths[2],from:'onSend(entry.id)',to:'onSend(queued[0]!.id)'},
    {name:'competing-send-enabled',file:productPaths[2],from:'const sending = queued.some(entry => entry.sending)',to:'const sending = false'},
    {name:'real-pending-risk-hidden',file:productPaths[2],from:'{working || needsAttention ? <p',to:'{false ? <p'},
    {name:'packet-summary-body-lost',file:productPaths[3],from:'const body = parseAgentMuxMessagePrefix(snippet)?.body',to:'const body = undefined'},
    {name:'history-oldest-first',file:productPaths[0],from:'return b - a',to:'return a - b'},
    {name:'hover-acknowledges-unread',file:productPaths[0],from:'if (!open || !viewed) return',to:'if (!open) return'}
  ]
  for(const item of cases){const original=originals[item.file];assert.equal(original.split(item.from).length,2);await writeFile(join(privateRoot,item.file),original.replace(item.from,item.to));const red=await sourceTest(item.name,true);await writeFile(join(privateRoot,item.file),original);const restored=await sourceTest(item.name+'-restored',false);result.mutations.push({...item,originalSha256:hash(original),red,restored,sharedSourceWritten:false})}
}
async function compiled(dir) {
  const files=await readdir(dir,{recursive:true,withFileTypes:true}),out={}
  for(const file of files) if(file.isFile()){const path=join(file.parentPath,file.name);out[path.slice(dir.length+1)]=hash(await readFile(path))}
  assert.ok(Object.keys(out).length>0);return out
}
async function native(label, mutation) {
  const {build}=await import('vite'),fixture=join(desktop,'scripts/fixtures/mailbox-reading-flow'),directory=join(evidence,label),processRoot=join(privateRoot,label),outDir=join(processRoot,'out')
  await mkdir(directory,{recursive:true});await mkdir(processRoot,{recursive:true})
  const wrapper=join(processRoot,'record-xterm.mjs'),main=join(processRoot,'probe-main.cjs'),mainBytes=await readFile(join(fixture,'main.cjs'))
  await writeFile(main,mainBytes)
  await writeFile(wrapper,`import xterm from ${JSON.stringify(require.resolve('@xterm/xterm'))};\nexport class Terminal extends xterm.Terminal{constructor(...args){super(...args);const entries=globalThis.resultReadyTerminals??=[];this.probeIdentity={id:entries.length,terminal:this,disposed:false};entries.push(this.probeIdentity)}dispose(){this.probeIdentity.disposed=true;return super.dispose()}}\n`)
  const loadedSourceInputs={},importedStyleInputs={},compiledCoreInputs={},mutationRecords=[]
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:[
    {find:/^@agentmux\/client-ui\/components\/(.+)$/,replacement:join(root,'packages/client-ui/src/components/$1.tsx')},
    {find:/^@agentmux\/client-ui\/styles\/(.+)$/,replacement:join(root,'packages/client-ui/src/styles/$1')},
    {find:/^@agentmux\/client-ui\/platform$/,replacement:join(root,'packages/client-ui/src/platform.tsx')},
    {find:/^@agentmux\/client-ui\/(.+)$/,replacement:join(root,'packages/client-ui/src/lib/$1.ts')},
    {find:/^@agentmux\/client-ui$/,replacement:join(root,'packages/client-ui/src/index.ts')},
    {find:/^@xterm\/xterm$/,replacement:wrapper},
    // This Main's control contract is newer than the shared compiled declaration. Preview only.
    {find:/^@agentmux\/core\/control$/,replacement:join(root,'packages/core/src/control.ts')},
    {find:/^@agentmux\/core\/terminal-continuation$/,replacement:join(root,'packages/core/src/terminal-continuation.ts')}
  ]},plugins:[{name:'mailbox-badge-private-production',enforce:'pre',async transform(source,id){
    if(id.includes('/packages/core/dist/')&&!id.includes('?'))compiledCoreInputs[id]=hash(source)
    if((id.startsWith(join(desktop,'src')+'/')||id.startsWith(join(desktop,'scripts/fixtures')+'/')||id.startsWith(join(root,'packages/core/src')+'/')||id.startsWith(join(root,'packages/client-ui/src')+'/'))&&!id.includes('?'))loadedSourceInputs[id.slice(root.length+1)]=hash(source)
  },async generateBundle(){for(const file of this.getWatchFiles())if((file.startsWith(join(desktop,'src')+'/')||file.startsWith(join(root,'packages/client-ui/src')+'/'))&&file.endsWith('.css'))importedStyleInputs[file.slice(root.length+1)]=hash(await readFile(file))}}],
  css:{postcss:{plugins:[{postcssPlugin:'mailbox-badge-actual-imported-css',async Once(sheet){
    if(!mutation)return
    if(mutation==='compact-direction'){
      const file=join(root,'packages/client-ui/src/styles/markdown.css'),rules=[],guard=".log-turn:not([data-compact='true']):is"
      sheet.walkRules(rule=>{if(rule.source?.input.file===file&&rule.selector.includes(guard))rules.push(rule)})
      if(!rules.length)return
      assert.equal(rules.length,3,'The actual imported ordinary direction blocks are nonempty and unique')
      const source=await readFile(file,'utf8'),selectors=rules.map(rule=>rule.selector)
      assert.equal(selectors.join('\n').split(guard).length-1,5)
      assert.equal(source.split(guard).length-1,5)
      const changed=source.replaceAll(guard,'.log-turn:is')
      for(const rule of rules)rule.selector=rule.selector.replaceAll(guard,'.log-turn:is')
      await writeFile(join(directory,'original.css'),source);await writeFile(join(directory,'mutated.css'),changed)
      mutationRecords.push({file:'packages/client-ui/src/styles/markdown.css',originalSha256:hash(source),mutatedSha256:hash(changed),astRules:{selectors,removedCompactExclusions:5},sharedSourceWritten:false})
      return
    }
    assert.equal(mutation,'body-scroll')
    const file=join(root,productPaths[1]),declarations=[]
    // CSS @imports are consumed by PostCSS rather than a separate Rollup transform.
    sheet.walkDecls('overflow-y',d=>{if(d.source?.input.file===file&&d.parent.selector==='.composer-mailbox__content')declarations.push(d)})
    if(!declarations.length)return
    assert.equal(declarations.length,1,'The actual imported body scrolling declaration is unique and nonempty')
    assert.equal(declarations[0].value,'auto')
    const source=await readFile(file,'utf8'),from='.composer-mailbox__content { min-height: 0; overflow-y: auto;',to='.composer-mailbox__content { min-height: 0; overflow-y: clip;'
    assert.equal(source.split(from).length,2);const changed=source.replace(from,to)
    declarations[0].value='clip'
    await writeFile(join(directory,'original.css'),source);await writeFile(join(directory,'mutated.css'),changed)
    mutationRecords.push({file:productPaths[1],originalSha256:hash(source),mutatedSha256:hash(changed),astDeclaration:{selector:'.composer-mailbox__content',originalProperty:'overflow-y',originalValue:'auto',mutatedValue:'clip'},sharedSourceWritten:false})
  }}]}},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},build:{outDir,emptyOutDir:true,commonjsOptions:{include:[/node_modules/,/xterm-locked-925/]}}})
  assert.equal(mutationRecords.length,mutation?1:0,'A requested production CSS mutation must be applied exactly once')
  for(const path of productPaths.filter(path=>path.endsWith('.tsx')))assert.ok(loadedSourceInputs[path],'Actual source consumed: '+path)
  for(const path of [...productPaths.filter(path=>path.endsWith('.css')),'apps/desktop/src/renderer/src/styles/agent-avatar.css'])assert.equal(importedStyleInputs[path],hash(await readFile(join(root,path))))
  assert.ok(Object.keys(compiledCoreInputs).length>0,'Existing compiled Core consumption is nonempty')
  const identity={loadedSourceInputs,importedStyleInputs,compiledCoreInputs,compiledFiles:await compiled(outDir),privateMainSha256:hash(mainBytes),terminalWrapperSha256:hash(await readFile(wrapper)),electronVersion:require('electron/package.json').version,existingCompiledCore:true,controlEntry:'packages/core/src/control.ts',controlScope:'Exact current public control and terminal-continuation sources; other Core entries use existing compiled package. Preview does not certify Runtime.',otherRuntimeEntries:'existing compiled package; private preview does not certify real Runtime',mutationRecords}
  await writeFile(join(directory,'compiled.json'),JSON.stringify(identity,null,2))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const lines=[],outcome=await runProbeProcess(require('electron'),[main,join(outDir,'index.html'),processRoot,directory],{temporaryRoot:processRoot,cwd:root,env,timeoutMs:90000,onLine:line=>lines.push(line)})
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
    const red=await native('geometry-red','body-scroll');assert.equal(red.outcome.exitCode,1);assert.equal(red.rendered.failure.name,'AssertionError');assert.match(red.rendered.failure.message,/native Wheel scrolls|last line is readable/)
    const directionRed=await native('compact-direction-red','compact-direction');assert.equal(directionRed.outcome.exitCode,1);assert.equal(directionRed.rendered.failure.name,'AssertionError');assert.match(directionRed.rendered.failure.message,/Compact .*avatar/)
    const restored=await native('geometry-restored');assert.equal(restored.outcome.exitCode,0,restored.rendered.failure?.message);assert.equal(restored.rendered.passed,true)
    result.mutations.push({name:'reading-body-cannot-scroll',red,restored,sharedSourceWritten:false})
    result.mutations.push({name:'compact-avatar-direction-lost',red:directionRed,restored,sharedSourceWritten:false})
  }
  for(const [path,bytes]of Object.entries(originals))assert.equal(hash(await readFile(join(root,path))),hash(bytes),'Owned source unchanged by private proof: '+path)
  result.passed=true
}catch(error){result.failure={name:error.name,message:error.message,stack:error.stack}}
finally {
  const before=await listProbeProcesses(-1,privateRoot);for(const pid of before)await signalOwnedProbeProcess(pid,privateRoot,'SIGKILL')
  result.cleanup={before,after:await listProbeProcesses(-1,privateRoot)};assert.equal(result.cleanup.after.length,0);await rm(privateRoot,{recursive:true,force:true});result.cleanup.temporaryRootRemoved=true
  result.privateRoot=privateRoot;await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2))
  if(mode==='--native')await writeFile(join(evidence,'review.md'),`# 信封内部阅读\n\n实际Workbench/Composer/Mailbox/Avatar/xterm与生产CSS，私有preview事实及输入回路。Core沿既有compiled resolution；不签真实CLI/Runtime或普通进程恢复。\n\n[身份、geometry RED/restored与cleanup](./receipt.json)。独立审美未执行。\n\n${(result.candidate?.rendered.frames??[]).map(f=>`- ${f.scene.width}px ${f.scene.appearance}/${f.scene.mode}: [${f.file}](./candidate/${f.file})`).join('\n')}\n`)
  console.log(JSON.stringify({passed:result.passed,evidence,receipt:join(evidence,'receipt.json'),failure:result.failure??null}));process.exitCode=result.passed?0:1
}
