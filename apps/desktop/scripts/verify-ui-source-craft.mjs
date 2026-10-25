import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { loadConfigFromFile } from 'vite'
import { radixOverlayAliases } from './radix-overlay-aliases.ts'
import { runProbeProcess } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), fixture = join(root, 'apps/desktop/scripts/fixtures/ui-source-craft')
const require = createRequire(import.meta.url), postcss = createRequire(require.resolve('vite'))('postcss'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = process.env.AGENTMUX_EVIDENCE_ROOT ?? join(root, '.tmp/ui-source-craft')
const owning = (await loadConfigFromFile({command:'build',mode:'production'},join(root,'apps/desktop/test/vitest.ui-controls-owning.config.mts'))).config
const temporary = await mkdtemp(join(tmpdir(), 'amux-source-craft-'))
const owned = ['apps/desktop/src/renderer/src/styles/agent.css', 'apps/desktop/src/renderer/src/styles/index.css', 'packages/client-ui/src/styles/conversation-protocol.css', 'packages/client-ui/src/styles/conversation-resource-file.css', 'apps/desktop/src/renderer/src/components/SessionPane.tsx', 'packages/client-ui/src/components/ConversationResourceFile.tsx', 'packages/client-ui/src/components/ConversationInputText.tsx']
const sources = async () => Object.fromEntries(await Promise.all(owned.map(async file => [file, hash(await readFile(join(root, file)))])))
const proofInputs = [new URL(import.meta.url).pathname, join(fixture,'entry.tsx'), join(fixture,'main.cjs'), join(fixture,'index.html')]
const proofInputHashes = async () => Object.fromEntries(await Promise.all(proofInputs.map(async file=>[file.slice(root.length+1),hash(await readFile(file))])))
const receipt = { schema: 'agentmux.ui-source-craft.v1', passed: false, userRunTouched: false, proofInputs: await proofInputHashes(), sourceBefore: await sources(), cases: [], excludedPaintLeaves: [], boundary: 'Isolated production Renderer and controlled API facts: original SessionPane layout and shared reading components; no real CLI or Runtime recovery claim.' }
const mutations = [
  { name: 'pending-wrapper', mode: 'pending', file: owned[0], before: '.agent-body > .agent-interaction-source {', after: '.agent-body > .agent-interaction {', expected: 'Actual request wrapper scrolls' },
  { name: 'missing-file-import', mode: 'sources', file: owned[1], before: "@import '@agentmux/client-ui/styles/conversation-resource-file.css';", after: '', expected: 'Desktop imports the real shared file stylesheet' },
  { name: 'undefined-radius', mode: 'sources', file: owned[2], before: 'border-radius: var(--radius-sm);\n  background:', after: 'border-radius: var(--radius-md);\n  background:', expected: 'Shared protocol consumes the existing small radius' }
]
async function compile(name) {
  const out=join(temporary,name),loaded={},changes=[]
  const {build:bundle}=createRequire(require.resolve('vite/package.json'))('esbuild')
  const aliases=[{find:'react-dom/server',replacement:require.resolve('react-dom/server.browser')},...Object.entries(radixOverlayAliases).map(([find,replacement])=>({find,replacement})),...owning.resolve.alias.filter(alias=>alias.find!=='react'&&alias.find!=='react-dom')]
  await mkdir(out,{recursive:true})
  const product={name:'actual-source-craft',setup(builder){
    builder.onResolve({filter:/monaco-editor.*\?worker$/},async args=>{const resolved=await builder.resolve(args.path.replace(/\?worker$/,''),{resolveDir:args.resolveDir,kind:args.kind});receipt.excludedPaintLeaves.push({file:resolved.path,reason:'Unopened editor worker; instance construction fails this scenario'});return{path:resolved.path,namespace:'unopened-editor-worker'}})
    builder.onLoad({filter:/.*/,namespace:'unopened-editor-worker'},()=>({contents:"export default class {constructor(){throw new Error('Uncovered editor worker invoked')}}",loader:'js'}))
    builder.onResolve({filter:/.*/},async args=>{
      if(args.pluginData?.originalAlias)return
      for(const alias of aliases){const match=typeof alias.find==='string'?(args.path===alias.find||args.path.startsWith(alias.find+'/')):alias.find.test(args.path)
        if(match){const path=typeof alias.find==='string'?alias.replacement+args.path.slice(alias.find.length):args.path.replace(alias.find,alias.replacement);return builder.resolve(path,{resolveDir:root,kind:args.kind,pluginData:{originalAlias:true}})}
      }
    })
    builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{
      if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return
      const source=await readFile(path,'utf8'),relative=path.slice(root.length+1),leaf=path.split('/').at(-1)
      if(owned.includes(relative))loaded[relative]=hash(source)
      if(['DiagramFilePreview.tsx','DotFilePreview.tsx','DrawioFilePreview.tsx','EditorPane.tsx','GitBranchDiffPane.tsx','FileSourceEditor.tsx','PdfContent.tsx','ExcalidrawFilePreview.tsx','GitDiffCanvas.tsx','ToolkitScriptEditor.tsx'].includes(leaf)){
        receipt.excludedPaintLeaves.push({file:relative,sourceSha256:hash(source),reason:'Unopened paint leaf outside this request/source scenario'});return{contents:`export function ${leaf.slice(0,-4)}(){throw new Error('Uncovered paint leaf invoked')}`,loader:'js'}
      }
      return{contents:source,loader:path.endsWith('tsx')?'tsx':path.endsWith('ts')?'ts':'js'}
    })
    builder.onLoad({filter:/\.css$/},async({path})=>{const source=await readFile(path,'utf8'),relative=path.slice(root.length+1);if(owned.includes(relative))loaded[relative]=hash(source);return{contents:source,loader:'css'}})
  }}
  await bundle({entryPoints:[join(fixture,'entry.tsx')],outfile:join(out,'app.js'),bundle:true,platform:'browser',conditions:['browser','production'],format:'esm',target:'es2022',jsx:'automatic',minify:true,plugins:[product],logLevel:'silent',define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.png':'file','.gif':'file','.jpg':'file','.jpeg':'file','.webp':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file'}})
  await writeFile(join(out,'index.html'),'<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><style>html,body,#root{width:100%;height:100%;margin:0}#root{display:flex}</style><div id="root"></div><script type="module" src="./app.js"></script></html>')
  for(const file of owned)assert.equal(loaded[file],receipt.sourceBefore[file],'Actual source compiled: '+file)
  await mkdir(join(evidence,name),{recursive:true});await writeFile(join(evidence,name,'compiled.json'),JSON.stringify({loaded,changes,renderer:hash(await readFile(join(out,'app.js'))),css:hash(await readFile(join(out,'app.css')))},null,2))
  return{out,loaded,changes}
}
// Reverse only the mapped CSS declaration in the real compiled artifact. Keep all JS byte-for-byte.
async function compiledMutation(mutation, original) {
  const out=join(temporary,mutation.name), changes=[]
  await cp(original.out,out,{recursive:true})
  const source=await readFile(join(root,mutation.file),'utf8');assert.equal(source.split(mutation.before).length-1,1)
  for(const path of await readdir(out,{recursive:true}))if(path.endsWith('.css')){
    const file=join(out,path),before=await readFile(file,'utf8'),css=postcss.parse(before)
    css.walkRules(rule=>{
      if(mutation.name==='pending-wrapper'&&rule.selector==='.agent-body>.agent-interaction-source'){changes.push({selector:rule.selector});rule.selector='.agent-body>.agent-interaction'}
      if(mutation.name==='missing-file-import'&&rule.selector.split(',').some(s=>s.trim().startsWith('.conversation-resource-file'))){changes.push({selector:rule.selector});rule.remove()}
      if(mutation.name==='undefined-radius'&&rule.selector==='.conversation-protocol')rule.walkDecls('border-radius',decl=>{changes.push({selector:rule.selector,before:decl.value});decl.value='var(--radius-md)'})
    })
    const after=css.toString();if(after!==before){await writeFile(file,after);changes.push({compiledFile:path,before:hash(before),after:hash(after)})}
  }
  assert.ok(changes.length>0,'Nonempty exact compiled CSS regression')
  await mkdir(join(evidence,mutation.name),{recursive:true});await writeFile(join(evidence,mutation.name,'compiled.json'),JSON.stringify({sourceFile:mutation.file,sourceSha256:hash(source),sourceBefore:mutation.before,sourceAfter:mutation.after,changes,unchangedJavaScript:true},null,2))
  return{out,loaded:original.loaded,changes}
}
async function run(label, candidate, mode) {
  const directory = join(evidence, label), processRoot = join(temporary, label + '-process'), lines = []
  await mkdir(directory, { recursive: true }); await mkdir(processRoot, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const processReceipt = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(candidate.out, 'index.html'), processRoot, directory, mode], { temporaryRoot: processRoot, cwd: root, env, timeoutMs: 90000, onLine: line => lines.push(line) })
  await writeFile(join(directory, 'process.log'), lines.join('\n'))
  return { label, mode, process: processReceipt, actual: JSON.parse(await readFile(join(directory, 'render.json'), 'utf8')), loaded: candidate.loaded, changes: candidate.changes }
}
try {
  await mkdir(evidence, { recursive: true }); const green = await compile('candidate')
  for (const mode of ['pending', 'sources']) { const value = await run('candidate-' + mode, green, mode); receipt.cases.push(value); assert.equal(value.process.exitCode, 0, JSON.stringify(value.actual.failure)); assert.equal(value.actual.passed, true) }
  if (!process.argv.includes('--candidate-only')) for (const mutation of mutations) {
    const red = await run(mutation.name + '-red', await compiledMutation(mutation, green), mutation.mode); receipt.cases.push(red)
    assert.equal(red.process.exitCode, 1); assert.equal(red.actual.failure?.name, 'AssertionError'); assert.ok(red.actual.failure.message.includes(mutation.expected), red.actual.failure.message)
    const restored = await run(mutation.name + '-restored', green, mutation.mode); receipt.cases.push(restored); assert.equal(restored.process.exitCode, 0, JSON.stringify(restored.actual.failure)); assert.equal(restored.actual.passed, true)
    console.log('PASS ' + mutation.name + ': actual Renderer AssertionRED -> restoreGREEN')
  }
  assert.deepEqual(await proofInputHashes(),receipt.proofInputs,'Verification inputs remain stable'); receipt.sourceAfter = await sources(); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore); receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally { await rm(temporary, { recursive: true, force: true }); receipt.temporaryRemoved = true; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json'), failure: receipt.failure })); if (!receipt.passed) process.exitCode = 1
