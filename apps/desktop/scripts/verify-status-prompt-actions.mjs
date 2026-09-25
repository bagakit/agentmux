import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const require = createRequire(import.meta.url), exec = promisify(execFile), { build } = await import('vite'), ts = require('typescript')
const fixture = join(desktop, 'scripts/fixtures/status-prompt-actions'), sourceRoot = join(desktop, 'src/renderer/src')
const privateRoot = await mkdtemp('/tmp/amx-status-prompts-')
const evidence = join(repository, '.tmp/status-prompt-actions', `chromium-${Date.now()}`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = ['components/AgentStatusPromptActions.tsx','components/AgentSessionComposer.tsx','components/AgentComposer.tsx',
  'components/settings/ShortcutSettingsPane.tsx','components/TerminalView.tsx','styles/status-prompts.css']
const result = { schema: 'agentmux.status-prompt-native-delivery.v1', passed: false, userRunTouched: false,
  aestheticReview: 'not-performed', callers: [], mutations: [], cleanup: {} }
async function sources() { return Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(sourceRoot,file)))]))) }
async function compiled(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }), outputs = {}
  for (const entry of entries) if (entry.isFile()) { const path = join(entry.parentPath,entry.name); outputs[path.slice(directory.length+1)] = hash(await readFile(path)) }
  assert.ok(Object.keys(outputs).length>0, 'Actual private renderer outputs are nonempty'); return outputs
}
// The sparse worktree reuses exactly the already installed Electron version; it has its own userData.
const common = (await exec('git',['rev-parse','--git-common-dir'],{cwd:repository})).stdout.trim()
const installedRepository = dirname(resolve(repository,common))
const installedRequire = createRequire(join(installedRepository,'apps/desktop/package.json'))
assert.equal(installedRequire('electron/package.json').version, require('electron/package.json').version)
const electron = installedRequire('electron')
async function renderer(label, mutateRail = false) {
  const directory = join(evidence,label), processRoot = join(privateRoot,label), outDir = join(processRoot,'out')
  await mkdir(directory,{recursive:true}); await mkdir(processRoot,{recursive:true})
  const wrapper = join(processRoot,'record-xterm.mjs'), main = join(processRoot,'probe-main.cjs'), mainBytes = await readFile(join(fixture,'main.cjs'))
  await writeFile(main,mainBytes)
  await writeFile(wrapper,`import xterm from ${JSON.stringify(require.resolve('@xterm/xterm'))};
export class Terminal extends xterm.Terminal { constructor(...args) { super(...args); const entries = globalThis.resultReadyTerminals ??= [];
this.probeIdentity = { id: entries.length, terminal: this, disposed: false }; entries.push(this.probeIdentity) }
dispose() { this.probeIdentity.disposed = true; return super.dispose() } }
`)
  const loadedSourceInputs = {}, importedStyleInputs = {}, mutationRecords = []
  const railMutation = { postcssPlugin:'status-prompts-private-rail-mutation', async Once(css) {
    if (css.source.input.file !== join(sourceRoot,'styles/index.css')) return
    let found=0
    css.walkRules('.agent-status-prompts',rule=>{
      assert.equal(rule.source.input.file,join(sourceRoot,'styles/status-prompts.css'),'The mutated rule comes from the actual imported production stylesheet')
      found++
      for (const [prop,value] of [['height','auto'],['min-height','0']]) rule.walkDecls(prop,decl=>{
        assert.equal(decl.value,'var(--sp-7)'); decl.value=value
      })
      rule.append({prop:'flex-wrap',value:'wrap'})
    })
    assert.equal(found,1,'Exactly one actual production rail rule is mutated')
    const source=await readFile(join(sourceRoot,'styles/status-prompts.css'),'utf8'),anchor='height: var(--sp-7); min-height: var(--sp-7); padding-inline:'
    assert.equal(source.split(anchor).length,2,'The original fixed rail source block exists exactly once')
    const changed=source.replace(anchor,'height: auto; min-height: 0; flex-wrap: wrap; padding-inline:')
    mutationRecords.push({file:'apps/desktop/src/renderer/src/styles/status-prompts.css',originalSha256:hash(source),mutatedSha256:hash(changed),productionWritten:false})
    await writeFile(join(directory,'original-source.txt'),source); await writeFile(join(directory,'mutated-source.txt'),changed)
  } }
  await build({ configFile:false,root:fixture,base:'./',logLevel:'error',
    css:{postcss:{plugins:mutateRail?[railMutation]:[]}},
    resolve:{alias:[{find:/^@xterm\/xterm$/,replacement:wrapper}]},
    plugins:[{name:'status-prompts-private-compile',enforce:'pre',
      async transform(source,id) {
        if ((id.startsWith(join(desktop,'src')+'/') || id.startsWith(join(desktop,'scripts/fixtures')+'/')) && !id.includes('?')) loadedSourceInputs[id.slice(repository.length+1)] = hash(source)
      }, async generateBundle() {
        for (const file of this.getWatchFiles()) if (file.startsWith(join(desktop,'src')+'/') && file.endsWith('.css')) importedStyleInputs[file.slice(repository.length+1)]=hash(await readFile(file))
      }}],define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},
    build:{outDir,emptyOutDir:true,commonjsOptions:{include:[/node_modules/,/xterm-locked-925/]}} })
  assert.ok(Object.keys(loadedSourceInputs).length>0)
  for (const file of files.filter(file=>file.endsWith('.tsx'))) assert.ok(loadedSourceInputs['apps/desktop/src/renderer/src/'+file],'The actual consumer is compiled: '+file)
  for (const file of ['styles/status-prompts.css','styles/composer.css','styles/terminal.css','styles/surfaces.css']) assert.equal(importedStyleInputs['apps/desktop/src/renderer/src/'+file],hash(await readFile(join(sourceRoot,file))),'Actual product CSS is imported: '+file)
  assert.equal(mutationRecords.length,mutateRail?1:0)
  const identity={loadedSourceInputs,importedStyleInputs,compiledFiles:await compiled(outDir),terminalWrapperSha256:hash(await readFile(wrapper)),
    privateMainSha256:hash(mainBytes),electronVersion:require('electron/package.json').version,mutationRecords}
  await writeFile(join(directory,'compiled.json'),JSON.stringify(identity,null,2))
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE
  const lines=[],outcome=await runProbeProcess(electron,[main,join(outDir,'index.html'),processRoot,directory],{
    temporaryRoot:processRoot,cwd:repository,env,timeoutMs:90_000,onLine:line=>lines.push(line)})
  await writeFile(join(directory,'process.log'),lines.join('\n'))
  const rendered=JSON.parse(await readFile(join(directory,'render.json'),'utf8'))
  assert.equal(outcome.timedOut,false); assert.equal(outcome.interruption,null)
  return {directory,outcome,rendered,identity}
}
async function callers() {
  for (const [symbol,file,attribute] of [['AgentStatusPromptActions','components/AgentSessionComposer.tsx',null],['AgentComposer','components/AgentSessionComposer.tsx','statusPrompts']]) {
    const path=join(sourceRoot,file),bytes=await readFile(path,'utf8'),source=ts.createSourceFile(path,bytes,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),hits=[]
    function visit(node) {
      if ((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(source)===symbol&&
        (!attribute||node.attributes.properties.some(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(source)===attribute))) hits.push(node.getText(source))
      ts.forEachChild(node,visit)
    }
    visit(source); assert.ok(hits.length>0,'Actual non-definition product caller: '+symbol); result.callers.push({symbol,file,attribute,hits,sha256:hash(bytes)})
  }
}
try {
  await mkdir(evidence,{recursive:true}); result.sourceBefore=await sources(); await callers()
  result.sourceCommit=(await exec('git',['rev-parse','HEAD'],{cwd:repository})).stdout.trim()
  result.candidate=await renderer('candidate'); assert.equal(result.candidate.outcome.exitCode,0,result.candidate.rendered.failure?.message); assert.equal(result.candidate.rendered.passed,true)
  const red=await renderer('fixed-rail-red',true)
  assert.equal(red.outcome.exitCode,1,'A broken rail changes the native scene to RED'); assert.equal(red.rendered.failure.name,'AssertionError')
  assert.match(red.rendered.failure.message,/State changes preserve the fixed Prompt rail and Terminal geometry/)
  result.sourceAfter=await sources(); assert.deepEqual(result.sourceAfter,result.sourceBefore,'Private mutation never writes product sources')
  const restored=await renderer('fixed-rail-restored'); assert.equal(restored.outcome.exitCode,0,restored.rendered.failure?.message); assert.equal(restored.rendered.passed,true)
  result.mutations.push({label:'fixed-rail',red,restored,productionWritten:false}); result.sourceAfter=await sources(); assert.deepEqual(result.sourceAfter,result.sourceBefore); result.passed=true
} catch (error) { result.failure={name:error.name,message:error.message,stack:error.stack} }
finally {
  const before=await listProbeProcesses(-1,privateRoot)
  for (const pid of before) await signalOwnedProbeProcess(pid,privateRoot,'SIGKILL')
  result.cleanup={before,after:await listProbeProcesses(-1,privateRoot)}; assert.equal(result.cleanup.after.length,0)
  result.privateRoot=privateRoot
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2))
  await writeFile(join(evidence,'review.md'),`# 状态 Prompt 原生验证\n\n实际生产 SettingsPanel / WorkspaceWorkbench / AgentSessionComposer / TerminalView / xterm / CSS，Session、display observations、typed-submit 与 ordered output 是私有 preview 事实；不触碰用户 Run。物理 durable ConfigOwner 另由 mounted Settings 测试证明。显示状态变化不冒签真实 CLI 退出或成功。\n\n身份、行为、块变异与清理：[receipt.json](./receipt.json)。本命令没有进行独立审美评审。\n\n${(result.candidate?.rendered.frames??[]).map(frame=>`- ${frame.width}px ${frame.name}: [完整截图](./candidate/${frame.file})`).join('\n')}\n`)
  console.log(JSON.stringify({passed:result.passed,evidence,receipt:join(evidence,'receipt.json'),failure:result.failure??null})); process.exitCode=result.passed?0:1
}
