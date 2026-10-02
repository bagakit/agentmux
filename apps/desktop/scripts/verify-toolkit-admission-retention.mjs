import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(resolve(root,'packages/core/package.json'))
const ts = require('typescript')
const mode = process.argv[2]
assert.ok(['--owning','--callers'].includes(mode), 'Choose --owning or --callers')
const base = resolve(root, ".bagakit/design/toolkit-disk-pressure-fixture/evidence")
await mkdir(base, { recursive: true })
const evidence = await mkdtemp(resolve(base, mode.slice(2) + '-'))
const sha = value => createHash('sha256').update(value).digest('hex')
const paths = ['apps/desktop/src/main/toolkit-owner.ts','apps/desktop/src/main/toolkit-receipt-store.ts',
  'apps/desktop/src/main/toolkit-custom-owner.ts','apps/desktop/src/main/toolkit-run-port.ts','apps/desktop/src/main/toolkit-asset.ts',
  'apps/desktop/src/main/ipc.ts','apps/desktop/src/main/toolkit-ipc.ts','apps/desktop/src/main/runtime-controller.ts','packages/core/src/client.ts',
  'packages/core/src/toolkit.ts','packages/core/src/durable-write.ts','apps/desktop/test/toolkit-owner.test.ts',
  'apps/desktop/test/toolkit-receipt-store.test.ts','apps/desktop/scripts/fixtures/toolkit-admission-retention/entry.ts',
  'apps/desktop/scripts/fixtures/toolkit-admission-retention/vitest.config.mts',
  'apps/desktop/scripts/fixtures/performance-toolkit/vitest.config.mts','vitest.setup.ts',
  'apps/desktop/scripts/verify-toolkit-admission-retention.mjs','apps/desktop/resources/toolkit/performance.mjs','tsconfig.base.json']
if (mode === '--callers') for (const path of execFileSync('rg',['--files','apps/desktop/src/main'],{cwd:root,encoding:'utf8'}).trim().split('\n')) {
  if (path.endsWith('.ts') && !paths.includes(path)) paths.push(path)
}
const inputs = {}, sources = {}
for (const path of paths) {
  const bytes = await readFile(resolve(root,path)); assert.ok(bytes.length > 0, 'Input must be nonempty: ' + path)
  inputs[path] = sha(bytes); sources[path] = bytes.toString()
  const copy = resolve(evidence,'inputs',path); await mkdir(dirname(copy),{recursive:true}); await writeFile(copy,bytes)
}
const results = []
if (mode === '--callers') {
  const program = ts.createProgram({rootNames:paths.filter(path => path.endsWith('.ts')).map(path => resolve(root,path)),
    options:{noEmit:true,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,skipLibCheck:true}})
  const checker = program.getTypeChecker()
  const symbol = node => { const value = checker.getSymbolAtLocation(node); return value?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(value) : value }
  const nodes = (parent,predicate) => { const found=[]; const visit=node => { if (predicate(node)) found.push(node); ts.forEachChild(node,visit) }; visit(parent); return found }
  const definition = (path,name) => {
    const file=program.getSourceFile(resolve(root,path)); assert.ok(file,'Owning definition must load: '+path)
    const found=file.statements.filter(node => (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.text === name)
    assert.equal(found.length,1,'Owning definition must be unique: '+name); return found[0]
  }
  const owner=definition('apps/desktop/src/main/toolkit-owner.ts','ToolkitOwner')
  const performance=definition('apps/desktop/src/main/toolkit-owner.ts','PerformanceToolkitOwner')
  const receipt=definition('apps/desktop/src/main/toolkit-receipt-store.ts','ToolkitReceiptStore')
  const ipc=definition('apps/desktop/src/main/toolkit-ipc.ts','registerToolkitIpc')
  const production=program.getSourceFiles().filter(file => relative(root,file.fileName).startsWith('apps/desktop/src/main/'))
  assert.ok(production.length > 0,'Production scan must be nonempty')
  const constructs=production.flatMap(file => nodes(file,node => ts.isNewExpression(node) && symbol(node.expression) === symbol(owner.name)))
  assert.ok(constructs.length > 0,'Actual owning definition must have a production consumer outside its definition file')
  const edges=[], record=(node,target) => {
    const caller=relative(root,node.getSourceFile().fileName), source=relative(root,target.getSourceFile().fileName)
    assert.ok(!/test|fixture|dist/u.test(caller)); const location=node.getSourceFile().getLineAndCharacterOfPosition(node.getStart())
    edges.push({caller,definition:source,line:location.line+1,call:node.getText()})
  }
  const construction=constructs.find(node => relative(root,node.getSourceFile().fileName) === 'apps/desktop/src/main/ipc.ts')
  assert.ok(construction && construction.getSourceFile() !== owner.getSourceFile()); record(construction,owner)
  assert.ok(ts.isBinaryExpression(construction.parent),'Toolkit instance must be assigned to the IPC variable')
  const instance=symbol(construction.parent.left)
  const registrations=nodes(construction.getSourceFile(),node => ts.isCallExpression(node) && symbol(node.expression) === symbol(ipc.name) && symbol(node.arguments[0]) === instance)
  assert.equal(registrations.length,1,'IPC must consume the constructed owner, not an unrelated Toolkit port'); record(registrations[0],ipc)
  for (const method of ['execute','subscribe']) {
    const port=symbol(ipc.parameters[0].name)
    const dispatch=nodes(ipc,node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === method && symbol(node.expression.expression) === port)
    assert.equal(dispatch.length,1,'Registered Toolkit IPC must dispatch the actual '+method+' port'); record(dispatch[0],owner)
    const body=owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText() === method)
    assert.ok(body?.body,'Owning route must have an implementation')
    const route=nodes(body,node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === method && node.expression.expression.getText() === 'this.performance')
    assert.equal(route.length,1,'Actual aggregate owner must route '+method+' to Performance'); record(route[0],performance)
  }
  const constructor=owner.members.find(ts.isConstructorDeclaration); assert.ok(constructor?.body)
  const stores=nodes(constructor,node => ts.isNewExpression(node) && symbol(node.expression) === symbol(receipt.name))
  assert.equal(stores.length,1,'Both tool owners must share one actual store construction'); record(stores[0],receipt)
  assert.ok(ts.isVariableDeclaration(stores[0].parent))
  const shared=symbol(stores[0].parent.name)
  for (const target of [performance,definition('apps/desktop/src/main/toolkit-custom-owner.ts','CustomToolkitOwner')]) {
    const created=nodes(constructor,node => ts.isNewExpression(node) && symbol(node.expression) === symbol(target.name))
    assert.equal(created.length,1)
    const injected=nodes(created[0],node => ts.isShorthandPropertyAssignment(node) &&
      checker.getShorthandAssignmentValueSymbol(node) === shared)
    assert.equal(injected.length,1,'Actual Performance and Custom constructors must consume the same receipts variable'); record(created[0],target)
  }
  const runtime=program.getSourceFile(resolve(root,'apps/desktop/src/main/runtime-controller.ts'))
  const port=nodes(runtime,node => ts.isMethodDeclaration(node) && node.name.getText() === 'toolkitRunPort')
  assert.equal(port.length,1)
  const create=nodes(port[0],node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createTerminal')
  assert.equal(create.length,1); record(create[0],definition('packages/core/src/client.ts','AgentMuxClient'))
  const writes=nodes(receipt,node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'durableWriteFile')
  assert.equal(writes.length,1); record(writes[0],definition('packages/core/src/durable-write.ts','durableWriteFile'))
  assert.ok(edges.length > 0); results.push({edges,definitionDerived:true,astCalls:true,sharedConstructor:true})
} else {
  const { build } = require('esbuild')
  const aliases = new Map()
  for (const name of ['core','demand','layout','client-ui']) {
    const directory = resolve(root,'packages',name), pkg = JSON.parse(await readFile(resolve(directory,'package.json'),'utf8'))
    for (const [key,value] of Object.entries(pkg.exports)) {
      const target = typeof value === 'string' ? value : value.import
      aliases.set(`@agentmux/${name}${key === '.' ? '' : key.slice(1)}`,resolve(directory,
        target.replace('./dist/src/','./src/').replace('./dist/','./src/').replace(/\.js$/u,'.ts')))
    }
  }
  const converted=ts.convertCompilerOptionsFromJson(JSON.parse(sources['tsconfig.base.json']).compilerOptions,root)
  assert.equal(converted.errors.length,0)
  for (const flag of ['strict','noUncheckedIndexedAccess','exactOptionalPropertyTypes']) assert.equal(converted.options[flag],true)
  const typed=ts.createProgram({rootNames:['apps/desktop/src/main/toolkit-owner.ts','apps/desktop/src/main/toolkit-receipt-store.ts',
    'apps/desktop/test/toolkit-owner.test.ts','apps/desktop/test/toolkit-receipt-store.test.ts',
    'apps/desktop/scripts/fixtures/toolkit-admission-retention/entry.ts'].map(path => resolve(root,path)),
    options:{...converted.options,noEmit:true,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
      types:['node'],baseUrl:root,paths:Object.fromEntries([...aliases].map(([key,path]) => [key,[path]]))}})
  const diagnostics=ts.getPreEmitDiagnostics(typed)
  await writeFile(resolve(evidence,'strict-types.log'),ts.formatDiagnosticsWithColorAndContext(diagnostics,{
    getCanonicalFileName:path=>path,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}))
  assert.equal(diagnostics.length,0,'Changed owning Source and fixture must pass actual strict TypeScript checking')
  results.push({mode:'strict-owning-types',strict:true,noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,diagnostics:0})
  const mutations = {
    'before-create': ['apps/desktop/src/main/toolkit-owner.ts',
      '// Admit durably before acquiring or dispatching the native creation port.\n      await this.save(execution)',
      '// Admit durably before acquiring or dispatching the native creation port.\n      void execution'],
    restore: ['apps/desktop/src/main/toolkit-owner.ts', 'if (receipt.admission === null) return', 'if (true) return'],
    'builtin-retention': ['apps/desktop/src/main/toolkit-owner.ts',
      "() => ['performance', ...toolkitTools(args.config.current).map(tool => tool.id)]",
      '() => toolkitTools(args.config.current).map(tool => tool.id)'],
    'directory-sync': ['apps/desktop/src/main/toolkit-receipt-store.ts','{ requireDirectorySync: true }','{ requireDirectorySync: false }'],
    'write-readback': ['apps/desktop/src/main/toolkit-receipt-store.ts','this.loaded = null\n        throw error','void this.loaded\n        throw error'],
    'undispatched-clear': ['apps/desktop/src/main/toolkit-owner.ts','(!execution.ref && execution.creationPending)',
      '(!execution.ref && (execution.creationPending || execution.receiptUnconfirmed))']
  }
  async function compile(name) {
    const directory = resolve(evidence,name); await mkdir(directory,{recursive:true})
    await symlink(resolve(root,'packages/core/node_modules'),resolve(directory,'node_modules'),'dir')
    const loaded = []
    const output = resolve(directory,'entry.mjs')
    await build({ entryPoints:[resolve(root,'apps/desktop/scripts/fixtures/toolkit-admission-retention/entry.ts')],
      outfile:output,bundle:true,platform:'node',format:'esm',target:'node24',sourcemap:false,
      banner:{js:'import { createRequire as __amxPrivateRequire } from "node:module"; const require=__amxPrivateRequire(import.meta.url)'},
      plugins:[{name:'actual-toolkit-admission-source',setup(builder) {
        builder.onResolve({filter:/^@agentmux\//},args => aliases.has(args.path) ? {path:aliases.get(args.path)} : undefined)
        builder.onResolve({filter:/^electron$/},() => ({path:'electron',namespace:'private-host'}))
        builder.onLoad({filter:/.*/,namespace:'private-host'},() => ({contents:'export const app={getPath:()=>"private-unused",getAppPath:()=>process.cwd()}',loader:'js'}))
        builder.onLoad({filter:/\.(ts|json)$/},async args => {
          const path = relative(root,args.path)
          if (!path.startsWith('packages/') && !path.startsWith('apps/desktop/')) return
          const original = await readFile(args.path,'utf8'); let consumed = original
          const mutation = mutations[name]
          if (mutation?.[0] === path) {
            assert.equal(original.split(mutation[1]).length - 1, 1, 'Actual mutation anchor must exist exactly once: ' + path)
            consumed = original.replace(mutation[1],mutation[2])
          }
          loaded.push({path,originalSHA256:sha(original),consumedSHA256:sha(consumed),bytes:Buffer.byteLength(consumed),mutant:name})
          return {contents:consumed,loader:args.path.endsWith('.json') ? 'json' : 'ts'}
        })
      }}] })
    assert.ok(loaded.length > 0)
    for (const path of ['apps/desktop/src/main/toolkit-owner.ts','apps/desktop/src/main/toolkit-receipt-store.ts','packages/core/src/durable-write.ts']) {
      const actual = loaded.find(row => row.path === path); assert.ok(actual, 'Actual source must be consumed: ' + path)
      assert.equal(actual.originalSHA256,inputs[path], 'Candidate source must stay fixed')
    }
    if (name in mutations) assert.ok(loaded.some(row => row.originalSHA256 !== row.consumedSHA256), 'Mutated implementation must be loaded')
    await writeFile(resolve(directory,'loaded-source.jsonl'),loaded.map(row => JSON.stringify(row)+'\n').join(''))
    return { output, directory, loaded }
  }
  async function execute(compiled, stages, expected) {
    const directory = await mkdtemp(resolve(compiled.directory,'case-'))
    let failure = null; const receipts = []
    for (const stage of stages) {
      try {
        const output = execFileSync(process.execPath,[compiled.output,stage,directory,resolve(root,'apps/desktop/resources/toolkit/performance.mjs')],
          {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:1024*1024})
        await writeFile(resolve(directory,stage+'.log'),output)
        const receipt = JSON.parse(output.trim()); assert.equal(receipt.completed,true); assert.equal(receipt.mode,stage)
        receipts.push(receipt)
      } catch (error) {
        const text = String(error.stderr ?? error.stack ?? error)
        await writeFile(resolve(directory,stage+'.failed.log'),text)
        failure = text; break
      }
    }
    if (expected) {
      assert.ok(failure?.includes('AssertionError'), 'Source mutation must cause behavior AssertionRED rather than setup failure')
      assert.match(failure,expected,'The specific owning behavior must fail')
    } else assert.equal(failure,null,'Baseline behavior must pass; inspect retained case log')
    results.push({mutant:compiled.loaded[0]?.mutant,stages,result:expected?'SpecificAssertionRED':'GREEN',directory,receipts})
  }
  const suites = [['unknown-first','unknown-restore'],['binding-first','binding-restore'],['cleanup-first','cleanup-restore'],
    ['directory-shared','directory-shared-restore'],['directory-explicit-clear','directory-cleared-restore'],
    ['directory-sync','directory-restore'],['load-failure'],['undispatched-clear'],['clear-failure'],['cancel-save'],['dispose-save'],
    ['cancel-create'],['dispose-create'],['shared'],['budget'],['corrupt']]
  const baseline = await compile('baseline')
  for (const suite of suites) await execute(baseline,suite)
  for (const [name,stages,oracle] of [
    ['before-create',['directory-sync'],/Native port must not be acquired before a complete admission ACK/u],
    ['restore',['unknown-first','unknown-restore'],/Restored admission must never become an empty idle owner/u],
    ['builtin-retention',['budget'],/Custom writes must retain the pending built-in Performance admission/u],
    ['directory-sync',['directory-sync'],/Directory fsync failure must reject the durable admission/u],
    ['write-readback',['directory-shared'],/Subsequent Custom writes must retain the renamed unconfirmed admission/u],
    ['undispatched-clear',['directory-explicit-clear'],/Explicit stop may clear only a proven undispatched admission after a durable ACK/u]
  ]) await execute(await compile(name),stages,oracle)
  const restored = await compile('restored')
  for (const suite of suites) await execute(restored,suite)
  const units = resolve(evidence,'existing-units'); await mkdir(units,{recursive:true})
  const output = execFileSync(process.execPath,[resolve(root,'node_modules/vitest/vitest.mjs'),'run','--config',
    'apps/desktop/scripts/fixtures/toolkit-admission-retention/vitest.config.mts','--reporter=json','--outputFile',resolve(units,'report.json')],
    {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:1024*1024,
      env:{...process.env,AGENTMUX_TOOLKIT_MUTANT:'baseline',AGENTMUX_TOOLKIT_EVIDENCE:units}})
  await writeFile(resolve(units,'run.log'),output)
  const report = JSON.parse(await readFile(resolve(units,'report.json'),'utf8'))
  assert.ok(report.numTotalTests > 0 && report.testResults.length === 2, 'Both existing owning test files must collect nonempty assertions')
  for (const path of ['apps/desktop/test/toolkit-owner.test.ts','apps/desktop/test/toolkit-receipt-store.test.ts']) {
    const file = report.testResults.find(value => value.name === resolve(root,path))
    assert.ok(file && file.assertionResults.length > 0, 'Existing owning assertions must be nonempty: ' + path)
  }
  assert.equal(report.numFailedTests,0)
  results.push({mode:'existing-owning-tests',collected:report.numTotalTests,passed:true})
}
for (const [path,digest] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root,path))),digest,'Exact candidate/source restore: '+path)
const receipt = {schema:'agentmux.toolkit.admission-retention-proof.v1',completed:true,mode,
  candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceIdentity:sha(JSON.stringify(inputs)),inputs,
  privateNodeProcesses:true,userAppOrRuntimeActions:false,sourceWriterUsed:false,results,evidenceDirectory:evidence}
await writeFile(resolve(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
await writeFile(resolve(base,mode.slice(2)+'-receipt.json'),JSON.stringify(receipt,null,2)+'\n')
console.log(`${mode}: complete; ${results.length} bounded results; receipt ${resolve(evidence,'receipt.json')}`)
