import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { build } from 'vite'
import { runProbeProcess } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const require = createRequire(import.meta.url), fixture = join(desktop, 'scripts/fixtures/terminal-file-context')
const evidence = join(repository, '.local/terminal-file-context/native')
const hash = data => createHash('sha256').update(data).digest('hex')
const owners = ['components/TerminalView.tsx', 'components/TerminalContextMenu.tsx', 'components/TerminalMenuTools.tsx',
  'components/RegionContextMenu.tsx', 'lib/terminal-context-path.ts', 'lib/terminal-link-range.ts', 'lib/terminal-file-action.ts']
  .map(file => 'apps/desktop/src/renderer/src/' + file)
if (!process.argv.includes('--capture')) {
  const receipt = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'))
  assert.equal(receipt.passed, true, 'Capture the native production menu first with --capture')
  const compiled = JSON.parse(await readFile(join(evidence, 'fixed/compiled.json'), 'utf8'))
  for (const owner of owners) assert.equal(compiled.loaded[owner], hash(await readFile(join(repository, owner))), 'Native candidate changed: ' + owner)
  for (const name of ['entry.tsx', 'main.cjs']) assert.equal(compiled.harness[name], hash(await readFile(join(fixture, name))))
  const review = JSON.parse(await readFile(join(evidence, 'visual-review.json'), 'utf8'))
  assert.equal(review.verdict, 'deliverable'); assert.equal(review.frames.length, 2)
  for (const frame of review.frames) assert.equal(hash(await readFile(join(evidence, 'fixed', frame.file))), frame.sha256)
  console.log(JSON.stringify({ passed: true, reusedNativeReceipt: join(evidence, 'receipt.json'), independentReview: join(evidence, 'visual-review.json') }))
  process.exit(0)
}
const temporary = await mkdtemp('/tmp/amx-file-context-')
const result = { passed: false, userRunTouched: false, captureOnly: true, aestheticReview: 'not-performed', variants: [], cleanup: {} }
async function variant(label, mutation = false) {
  const directory = join(evidence, label), outDir = join(temporary, label)
  await mkdir(directory, { recursive: true })
  const wrapper = join(temporary, 'xterm.cjs')
  await writeFile(wrapper, `const xterm=require(${JSON.stringify(require.resolve('@xterm/xterm'))});exports.Terminal=class extends xterm.Terminal{constructor(...args){super(...args);const records=globalThis.identityTerminals??=[];this.probeIdentity={id:records.length,terminal:this,disposed:false};records.push(this.probeIdentity)}dispose(){this.probeIdentity.disposed=true;return super.dispose()}}`)
  const loaded = {}, mutations = []
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: wrapper }] },
    plugins: [{ name: 'file-context-loaded-inputs', enforce: 'pre', transform(source, id) {
      if (id.startsWith(join(desktop, 'src')+'/') || id.startsWith(fixture+'/')) loaded[id.slice(repository.length+1)] = hash(source)
      if (mutation && id === join(desktop, 'src/renderer/src/lib/terminal-context-path.ts')) {
        const anchor='return classifyMarkdownLinkHref(href, workspaceRoot)'
        assert.equal(source.split(anchor).length, 2)
        mutations.push({ source: hash(source), anchor, change: 'drop-declared-target', productionWritten: false })
        return source.replace(anchor,'return null')
      }
    } }], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir, emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm\.cjs/] } } })
  const owner='apps/desktop/src/renderer/src/lib/terminal-context-path.ts'
  assert.equal(loaded[owner], hash(await readFile(join(repository, owner))))
  assert.equal(mutations.length, mutation ? 1 : 0)
  const compiled={}
  for(const file of await readdir(join(outDir,'assets'))) compiled[file]=hash(await readFile(join(outDir,'assets',file)))
  assert.ok(Object.keys(compiled).length)
  const harness = {}
  for (const name of ['entry.tsx', 'main.cjs']) harness[name] = hash(await readFile(join(fixture, name)))
  await writeFile(join(directory,'compiled.json'),JSON.stringify({loaded,compiled,mutations,harness},null,2))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const log=[]
  const outcome=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),join(outDir,'index.html'),join(temporary,label+'-state'),directory],{
    cwd:repository,env,timeoutMs:60000,onLine:line=>log.push(line)
  })
  await writeFile(join(directory,'process.log'),log.join('\n'))
  const rendered=JSON.parse(await readFile(join(directory,'render.json'),'utf8'))
  return {label,outcome,rendered,directory}
}
try {
  await mkdir(evidence,{recursive:true})
  const fixed=await variant('fixed');result.variants.push(fixed)
  assert.equal(fixed.outcome.exitCode,0,JSON.stringify(fixed.rendered.failure));assert.equal(fixed.rendered.passed,true)
  const red=await variant('drop-declared-target',true);result.variants.push(red)
  assert.equal(red.outcome.exitCode,1);assert.equal(red.rendered.failure?.name,'AssertionError')
  assert.match(red.rendered.failure.message,/Original context menu reveals declared file target/)
  result.passed=true
}catch(error){result.failure={name:error.name,message:error.message,stack:error.stack}}
finally{
  await rm(temporary,{recursive:true,force:true});result.cleanup.privateRootRemoved=true
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2))
}
console.log(JSON.stringify({passed:result.passed,receipt:join(evidence,'receipt.json'),frames:result.variants[0]?.rendered.frames,failure:result.failure}))
if(!result.passed)process.exitCode=1
