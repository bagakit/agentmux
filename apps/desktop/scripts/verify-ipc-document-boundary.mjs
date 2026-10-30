import assert from 'node:assert/strict'
import {ipcCallerInventory} from './fixtures/ipc-document-boundary/caller-inventory.mjs'
import {domainTests} from './fixtures/ipc-document-boundary/consumers.mjs'
import {variants,transform} from './fixtures/ipc-document-boundary/variants.mjs'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url)), require = createRequire(join(root, 'apps/desktop/package.json'))
const ts = require('typescript'), { build } = createRequire(join(root, 'packages/core/package.json'))('esbuild')
const evidence = resolve(root, '.local/ipc-document-boundary'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(evidence, { recursive: true })
const ipcPath = 'apps/desktop/src/main/ipc.ts', trustPath = 'apps/desktop/src/main/ipc-sender-trust.ts'
const sourcesPath = 'apps/desktop/src/main/workbench-document-sources.ts'
const callers = await ipcCallerInventory(root)
const sources = [...new Set([...domainTests,'apps/desktop/test/capsule-client.test.ts','apps/desktop/scripts/fixtures/ipc-document-boundary/consumers.mjs',
  'apps/desktop/scripts/fixtures/ipc-document-boundary/variants.mjs', 'apps/desktop/test/ipc-document-boundary.config.mts',
  'apps/desktop/test/tsconfig.ipc-document-boundary.json', 'packages/capsule/src/types.ts', 'packages/capsule/src/parsers.ts',
  'apps/desktop/src/renderer/src/lib/workbench-windows.tsx', ipcPath, trustPath, sourcesPath, 'apps/desktop/src/main/index.ts', 'apps/desktop/src/main/capsule-document-ipc.ts',
  'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/preload/capsule.ts',
  'apps/desktop/test/ipc-document-boundary.test.ts', 'apps/desktop/test/helpers/first-execution-ipc-bridge.ts',
  'apps/desktop/scripts/fixtures/ipc-document-boundary/native.ts',
  'apps/desktop/test/helpers/app-document-fixture.ts', 'apps/desktop/scripts/fixtures/ipc-document-boundary/caller-inventory.mjs'])]
const verifierSha256 = hash(await readFile(fileURLToPath(import.meta.url)))
const interfaceInputs = Object.fromEntries(await Promise.all([...new Set(callers.map(row=>row.file))].map(async file=>[file,hash(await readFile(join(root,file)))])))
const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(join(root, file)))])))
async function source(file, variant) { return transform(await readFile(join(root, file), 'utf8'), file, variant) }
function declaration(text, name, initializer = true) {
  const file = ts.createSourceFile('original.ts', text, ts.ScriptTarget.Latest, true), found = []
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer)
      found.push(initializer ? node.initializer.getText(file) : node.parent.parent.getText(file))
    ts.forEachChild(node, visit)
  }
  visit(file); assert.equal(found.length, 1, 'One actual original declaration: ' + name)
  return ts.transpileModule(initializer ? '(' + found[0] + ')' : found[0], {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText.replace(/;\s*$/u, '')
}
function functionSource(text, name) {
  const file = ts.createSourceFile('original.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), found = []
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node.getText(file).replace(/^export\s+/u, ''))
    ts.forEachChild(node, visit)
  }
  visit(file); assert.equal(found.length, 1, 'Actual original function: ' + name); return found[0]
}
function callbackSource(text, channel) {
  const file = ts.createSourceFile('original.ts', text, ts.ScriptTarget.Latest, true), found = []
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'handleWithEvent' &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) found.push(node.arguments[1].getText(file))
    ts.forEachChild(node, visit)
  }
  visit(file); assert.equal(found.length, 1)
  return ts.transpileModule('(' + found[0] + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replace(/;\s*$/u, '')
}
async function run(command, args, options = {}) {
  let output = ''
  const child = spawn(command, args, { cwd: root, ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => { output += bytes; if (process.argv.includes('--native-only')) process.stdout.write(bytes) }); child.stderr.on('data', bytes => { output += bytes; if (process.argv.includes('--native-only')) process.stderr.write(bytes) })
  const timeout = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 90000)
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('close', yes) }); clearTimeout(timeout)
  return { code, output }
}
async function native(name, variant, scope='all') {
  const directory = await mkdtemp(join(tmpdir(), 'amx-ipc-native-')), out = join(directory, 'compiled'), report = join(evidence, name + '.json')
  const loaded = []
  try {
    await mkdir(join(out, 'main'), { recursive: true }); await mkdir(join(out, 'preload'), { recursive: true })
    await symlink(join(root, 'apps/desktop/node_modules'), join(out, 'node_modules'), 'dir')
    const ipc = await source(ipcPath, variant), index = await source('apps/desktop/src/main/index.ts', variant)
    const handlers = `return { handle: ${declaration(ipc, 'handle')}, handleWithEvent: ${declaration(ipc, 'handleWithEvent')} }`
    const plugin = { name: 'original-ipc-candidate', setup(api) {
      api.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
        const file = relative(root, args.path)
        if (!file.startsWith('apps/desktop/src/')) return
        const original = await readFile(args.path, 'utf8'), code = transform(original, file, variant)
        loaded.push({ file, original: hash(original), loaded: hash(code) })
        return { contents: code, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' }
      })
    } }
    await build({ entryPoints: [join(root, 'apps/desktop/scripts/fixtures/ipc-document-boundary/native.ts')],
      outfile: join(out, 'main/index.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external',
      plugins: [plugin], logLevel: 'silent', define: {
        __REGISTRARS__: JSON.stringify(handlers), __LOADER__: JSON.stringify(declaration(index, 'loadPackagedRenderer')),
        __WORKBENCH_CALL__: JSON.stringify(callbackSource(ipc, 'ui:workbenchWindowsCall')),
        __CAPSULE_REGISTRATION__: JSON.stringify(declaration(ipc, 'disposeCapsuleDocument', false))
      } })
    for (const entry of ['index', 'capsule']) await build({ entryPoints: [join(root, 'apps/desktop/src/preload/' + entry + '.ts')],
      outfile: join(out, 'preload/' + entry + '.cjs'), bundle: true, platform: 'browser', format: 'cjs', external: ['electron'],
      logLevel: 'silent' })
    const windows = await readFile(join(root, 'apps/desktop/src/renderer/src/lib/workbench-windows.tsx'), 'utf8')
    const shell = join(directory, 'workbench-window.html')
    await writeFile(shell, await readFile(join(root, 'apps/desktop/src/renderer/workbench-window.html')))
    await build({ stdin: { resolveDir: join(root, 'apps/desktop'), loader: 'tsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client'; import {createPortal,flushSync} from 'react-dom';
      import {mintObjectId} from ${JSON.stringify(join(root, 'packages/core/src/object-id.ts'))};
      const api=window.agentmux; let snapshot={}; const notify=()=>{};
      const publishIssue=error=>{window.portalIssue=String(error)}; const useNativeOverlayChrome=()=>null;
      ${functionSource(windows, 'returnWorkbenchWindow')}
      ${functionSource(windows, 'WorkbenchWindowToolbar')}
      window.installOriginalPortal=async()=>{const child=window.open(${JSON.stringify('file://' + shell)},'private-workbench');
        await new Promise(resolve=>child.addEventListener('load',resolve,{once:true}));
        if(typeof child.agentmux!=='undefined')throw Error('Child acquired an App bridge');
        const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
        const record={document:child.document,identity:{windowId:'private-workbench-window',documentGeneration:'original-child-document'}};
        flushSync(()=>root.render(createPortal(<WorkbenchWindowToolbar record={record}/>,child.document.body)));
        child.document.querySelector('button').click(); await new Promise(resolve=>setTimeout(resolve,20));
        root.unmount();child.close();return true;};` },
      outfile: join(out, 'renderer/portal.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent' })
    loaded.push({ file: 'apps/desktop/src/renderer/src/lib/workbench-windows.tsx', original: hash(windows), loaded: hash(windows) })
    loaded.push({ file: ipcPath, original: hash(await readFile(join(root, ipcPath))), loaded: hash(ipc) },
      { file: 'apps/desktop/src/main/index.ts', original: hash(await readFile(join(root, 'apps/desktop/src/main/index.ts'))), loaded: hash(index) })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|ELECTRON_RUN_AS_NODE$)/u.test(key)))
    Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })
    const result = await run(require('electron'), [join(out, 'main/index.mjs'), directory, report, scope], { env })
    await writeFile(join(evidence, name + '.log'), result.output)
    const observed = JSON.parse(await readFile(report, 'utf8'))
    assert.deepEqual(observed.cleanup, [], 'Every private Native resource cleaned')
    assert.equal(observed.userRuntimeOperations, 0)
    if (variant) {
      assert.equal(result.code, 1, 'Source mutant rejected')
      assert.equal(observed.error?.name, 'AssertionError', 'Business assertion, not Native setup/load failure')
      assert.ok(observed.error.message.startsWith(scope==='capsule' ? 'Accurate original Capsule SDK remains callable' : 'Readiness cannot revoke'), 'Exact protected Native business outcome')
      assert.ok(loaded.some(row => row.file === variant.file && row.original !== row.loaded), 'Actual original source variant compiled')
    } else { assert.equal(result.code, 0, result.output + JSON.stringify(observed)); assert.equal(observed.passed, true) }
    await writeFile(join(evidence, name + '-loaded.json'), JSON.stringify(loaded, null, 2))
    return { name, code: result.code, passed: observed.passed, assertion: observed.error?.message ?? null, cleanup: true }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

if (process.argv.includes('--native-only')) {
  console.log(JSON.stringify(await native('development-native', undefined))); process.exit(0)
}

async function unit(name, {variant,pattern,all=false,target}={}) {
  const directory=await mkdtemp(join(tmpdir(),'amx-ipc-unit-')), report=join(evidence,name+'.json'), loadedPath=join(evidence,name+'-loaded.jsonl')
  await writeFile(loadedPath,'')
  try {
    const result=await run(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config',
      'apps/desktop/test/ipc-document-boundary.config.mts','--reporter=json','--outputFile='+report],{env:{...process.env,
      IPC_DOCUMENT_MUTATION:variant ?? '',IPC_DOCUMENT_TARGET:target??(all?'all':'boundary'),IPC_DOCUMENT_PATTERN:pattern ?? '',
      IPC_DOCUMENT_CACHE:directory,IPC_DOCUMENT_LOADED:loadedPath},timeout:300000})
    await writeFile(join(evidence,name+'.log'),result.output)
    const observed=JSON.parse(await readFile(report,'utf8')), assertions=observed.testResults.flatMap(test=>test.assertionResults)
    const executed=assertions.filter(test=>test.status==='passed'||test.status==='failed')
    assert.ok(executed.length>0,'Actual product assertions executed')
    assert.equal(observed.numTotalTestSuites,observed.numPassedTestSuites+observed.numFailedTestSuites)
    const loaded=(await readFile(loadedPath,'utf8')).trim().split('\n').filter(Boolean).map(row=>JSON.parse(row))
    if(variant){
      assert.equal(result.code,1,'Source mutant rejected')
      assert.ok(executed.some(test=>test.status==='failed' && test.failureMessages.some(message=>message.includes('ipc-document-boundary.test.ts:') && (variant==='old-serving-document' ? message.includes('to not throw') : message.includes('instead of rejecting')))),
        'Product business assertion failed, rather than loading/setup')
      assert.ok(loaded.some(row=>row.file===variants[variant].file && row.original!==row.loaded),'Actual production source mutation loaded')
    }else{assert.equal(result.code,0,result.output);assert.equal(observed.success,true);assert.equal(observed.numFailedTests,0)}
    return {name,tests:executed.length,passed:observed.numPassedTests,failed:observed.numFailedTests,cleanup:true}
  }finally{await rm(directory,{recursive:true,force:true})}
}
// Main integration can reuse this exact candidate's completed evidence without repeating private runs.
try {
  const previous=JSON.parse(await readFile(join(evidence,'receipt.json'),'utf8'))
  if(previous.status==='passed' && Object.entries(inputs).every(([file,digest])=>previous.inputs[file]===digest)){
    assert.equal(previous.results.length,17,'Complete original case set')
    for(const row of previous.results)for(const [file,digest]of Object.entries(row.artifacts))
      assert.equal(hash(await readFile(join(evidence,file))),digest,'Unchanged proof artifact: '+file)
    for(const row of previous.results)for(const file of Object.keys(row.artifacts).filter(file=>file.endsWith('-loaded.json')||file.endsWith('-loaded.jsonl'))){
      const raw=await readFile(join(evidence,file),'utf8'), loaded=file.endsWith('.jsonl')?raw.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):JSON.parse(raw)
      for(const source of loaded)assert.equal(hash(await readFile(join(root,source.file))),source.original,'Unchanged loaded production source: '+source.file)
    }
    assert.equal(hash(await readFile(join(evidence,'types.log'))),previous.typecheck.sha256)
    const updated={...previous,inputs,interfaceInputs,callers,verifierSha256,producerVerifierSha256:previous.producerVerifierSha256??previous.inputs['apps/desktop/scripts/verify-ipc-document-boundary.mjs']??previous.verifierSha256}
    await writeFile(join(evidence,'receipt.json'),JSON.stringify(updated,null,2)+'\n')
    console.log(JSON.stringify({status:'passed',reused:true,evidence}));process.exit(0)
  }
}catch(error){if(error.code!=='ENOENT')throw error}
const receipt={schema:'agentmux.ipc-document-boundary.v1',status:'running',inputs,interfaceInputs,callers,verifierSha256,producerVerifierSha256:verifierSha256,results:[],limitations:[
  'Private original Native loader, App/Capsule preloads, BVM document owner and original Workbench toolbar portal; domain backends are private bounded ports.',
  'Private registered Main/preload reads, writes and event delegation are real; no user Runtime/Session operation or remote exploit claim.',
  'No packaging, full suite, user GUI or original historical acceptance is signed.' ]}
try{
  receipt.results.push(await unit('baseline-registered-and-domains',{all:true}))
  receipt.results.push(await unit('baseline-capsule-domain',{target:'capsule-client'}))
  receipt.results.push(await native('baseline-native'))
  for(const name of ['handle-admission','event-admission','root-frame','url-self-authorization','old-serving-document']){
    const pattern=name==='old-serving-document'?'the original loader keeps':'production preload and registered Main'
    receipt.results.push(await unit(name,{variant:name,pattern}))
    receipt.results.push(await unit('restore-'+name,{pattern}))
  }
  for(const name of ['capsule-app-gate','navigation-lifetime']){
    receipt.results.push(await native(name,variants[name],name==='capsule-app-gate'?'capsule':'loader'))
    receipt.results.push(await native('restore-'+name,undefined,name==='capsule-app-gate'?'capsule':'loader'))
  }
  const types=await run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p','apps/desktop/test/tsconfig.ipc-document-boundary.json','--noEmit'])
  await writeFile(join(evidence,'types.log'),types.output);assert.equal(types.code,0,types.output)
  receipt.typecheck={command:'tsc -p apps/desktop/test/tsconfig.ipc-document-boundary.json --noEmit',sha256:hash(types.output)}
  for(const [file,before] of Object.entries(inputs))assert.equal(hash(await readFile(join(root,file))),before,'Candidate unchanged: '+file)
  receipt.status='passed'
}finally{
  for(const row of receipt.results){const artifacts={};for(const suffix of ['.json','.log','-loaded.json','-loaded.jsonl']){
    try{artifacts[row.name+suffix]=hash(await readFile(join(evidence,row.name+suffix)))}catch(error){if(error.code!=='ENOENT')throw error}
  }row.artifacts=artifacts}
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
}
console.log(JSON.stringify({status:receipt.status,results:receipt.results.length,evidence}))
