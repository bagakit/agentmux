import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
assert.ok(args.every(arg => arg === '--mutations'), 'Unsupported connector package proof option')
const repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
const connectors = join(repository, 'packages/connectors'), core = join(repository, 'packages/core')
const require = createRequire(join(desktop, 'package.json'))
const { resolveConfig } = await import(pathToFileURL(require.resolve('electron-vite')).href)
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const ts = require('typescript')
const sdk = '@larksuiteoapi/node-sdk', sha = value => createHash('sha256').update(value).digest('hex')
const evidenceRoot = join(repository, '.local/connector-adapter-package')
await mkdir(evidenceRoot, { recursive: true }); await rm(join(evidenceRoot, 'receipt.json'), { force: true })
const configWork = await mkdtemp(join(evidenceRoot, 'config-'))
const isolated = await mkdtemp(join(tmpdir(), 'agentmux-connector-package-'))
const configPath = join(desktop, 'electron.vite.config.ts'), configSource = await readFile(configPath, 'utf8')
const packagePath = join(desktop, 'scripts/package-macos.mjs'), packageSource = await readFile(packagePath, 'utf8')
const source = ts.createSourceFile(packagePath, packageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const copier = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'copyRuntimeApplication')
assert.equal(copier.length, 1, 'Consume the one production App copying owner')
const sdkStatements = copier[0].body.statements.filter(statement => {
  const call = ts.isExpressionStatement(statement) && ts.isAwaitExpression(statement.expression) && statement.expression.expression
  return call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'materializeDependency' &&
    call.arguments[1] && ts.isStringLiteral(call.arguments[1]) && call.arguments[1].text === sdk
})
assert.equal(sdkStatements.length, 1, 'The production SDK copying call is unique and nonempty')
const functions = ['pathExists', 'materializeDependencies', 'materializeDependency', 'resolvePackageRoot'].map(name => {
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.equal(declarations.length, 1, 'Consume the actual packaging function ' + name)
  return declarations[0].getText(source)
})
function materializer(revoked) {
  return new Function('readFile', 'mkdir', 'cp', 'readdir', 'join', 'dirname', 'lstat', 'realpath', 'repositoryRoot', 'connectorsRoot',
    functions.join('\n') + '\nreturn {materializeDependencies, copySdk: async function(appResources) {\n' +
    (revoked ? '' : sdkStatements[0].getText(source)) + '\n}}')(
    readFile, mkdir, cp, readdir, join, dirname, lstat, realpath, repository, connectors)
}
const inputPaths = ['apps/desktop/electron.vite.config.ts', 'apps/desktop/scripts/package-macos.mjs',
  'apps/desktop/scripts/verify-connector-adapter-package.mjs', 'packages/connectors/package.json',
  'packages/connectors/src/platform-adapters.ts', 'packages/connectors/src/adapters/feishu/index.ts',
  'packages/connectors/src/adapters/feishu/enrollment.ts', 'packages/connectors/src/adapters/feishu/native-account.ts',
  'packages/core/package.json', 'packages/core/dist/index.js', 'pnpm-lock.yaml']
const evidence = { sourceInputs: Object.fromEntries(await Promise.all(inputPaths.map(async file => [file, sha(await readFile(join(repository, file)))]))),
  boundary: 'Production Main dependency configuration, original built-in adapter and original recursive SDK copying call; private compiled runtime, no App, Runtime or platform request started', cases: [], passed: false }
const entry = join(configWork, 'consumer.ts')
await writeFile(entry, `export {createBuiltinConnectionAdapters} from ${JSON.stringify(join(connectors, 'src/platform-adapters.ts'))};\n`)
const runner = join(configWork, 'runner.mjs')
await writeFile(runner, `import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {realpath} from 'node:fs/promises';
import {join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import http from 'node:http';import https from 'node:https';import net from 'node:net';import tls from 'node:tls';
let networkCalls=0;const denied=()=>{networkCalls++;throw Error('Network is forbidden in the package loader proof')};
globalThis.fetch=denied;http.request=http.get=https.request=https.get=net.connect=net.createConnection=tls.connect=denied;syncBuiltinESMExports();
const [consumer,lazy,appResources]=process.argv.slice(2),require=createRequire(pathToFileURL(consumer));
try {
  const {createBuiltinConnectionAdapters}=await import(pathToFileURL(consumer));
  const adapter=createBuiltinConnectionAdapters().find(value=>value.adapterId==='feishu');assert.ok(adapter?.enrollment);
  assert.equal(Object.keys(require.cache).some(file=>file.includes('@larksuiteoapi')),false,'Generic discovery must keep the SDK unloaded');
  const signal=AbortSignal.abort();let authorityCalls=0;
  const result=await adapter.enrollment.begin({operationId:'package-original-enrollment',connectionId:'package-original-connection',domain:'open.feishu.cn',label:'Package proof',attemptId:'package-original-attempt',assertCurrent(){authorityCalls++}},signal);
  assert.deepEqual(result,{kind:'unknown',diagnostic:{stage:'request',code:'cancelled'}});assert.equal(authorityCalls,0);assert.equal(networkCalls,0);
  const resolved=require.resolve(${JSON.stringify(sdk)}),sdkRequire=createRequire(resolved),protobuf=sdkRequire.resolve('protobufjs/minimal');
  const root=await realpath(appResources);for(const file of [resolved,protobuf])assert.ok((await realpath(file)).startsWith(root+sep),'Runtime dependencies must resolve inside the copied application');
  console.log(JSON.stringify({passed:true,result,networkCalls,authorityCalls,sdk:resolved,protobuf}));
} catch(error) {
  let cause;try{await import(pathToFileURL(lazy))}catch(original){cause={code:original.code,message:original.message}}
  console.log(JSON.stringify({passed:false,error:{code:error.code,message:error.message},cause,networkCalls}));process.exitCode=1;
}
`)
async function child(file, lazy, appResources) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_PATH', 'NODE_OPTIONS'].includes(key) && !/^(?:AGENTMUX_|CTXMUX_)/.test(key)))
  return await new Promise((done, reject) => {
    const processChild = spawn(process.execPath, [runner, file, lazy, appResources], { cwd: appResources, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', expired = false, escalation
    processChild.stdout.on('data', value => { stdout += value }); processChild.stderr.on('data', value => { stderr += value })
    const timer = setTimeout(() => { expired = true; processChild.kill('SIGTERM'); escalation = setTimeout(() => processChild.kill('SIGKILL'), 1000) }, 10000)
    processChild.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
    processChild.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(escalation)
      expired ? reject(new Error('The exact isolated adapter child timed out and exited')) : done({ code, signal, pid: processChild.pid, stdout, stderr })
    })
  })
}
async function run(label, mutation) {
  let configFile = configPath
  if (mutation === 'external') {
    const anchor = ", include: ['@larksuiteoapi/node-sdk']"
    assert.equal(configSource.split(anchor).length - 1, 1, 'Revoke the exact production SDK external choice')
    const modified = configSource.replace(anchor, '').replace(/from (['"])(\.[^'"]+)\1/g, (_match, _quote, path) => 'from ' + JSON.stringify(resolve(desktop, path)))
      .replaceAll('import.meta.dirname', JSON.stringify(desktop))
    configFile = join(configWork, 'electron.revoked.config.ts'); await writeFile(configFile, modified)
  }
  const { config } = await resolveConfig({ configFile, root: desktop, logLevel: 'silent' }, 'build', 'production')
  const main = config.main
  assert.ok(main.plugins.some(plugin => plugin?.name === 'vite:externalize-deps'), 'Consume the original Main dependency plugin')
  const appResources = join(isolated, label), output = join(appResources, 'out/main')
  main.build = { ...main.build, outDir: output, emptyOutDir: true, sourcemap: false,
    rollupOptions: { ...main.build.rollupOptions, input: entry, output: { format: 'es', entryFileNames: 'consumer.mjs' } } }
  main.configFile = false; main.logLevel = 'silent'
  const built = await build(main), chunks = (Array.isArray(built) ? built : [built]).flatMap(value => value.output ?? []).filter(value => value.type === 'chunk')
  const lazy = chunks.filter(chunk => Object.keys(chunk.modules).some(file => file === join(connectors, 'src/adapters/feishu/index.ts')))
  assert.equal(lazy.length, 1, 'Load the actual built-in adapter dynamic chunk')
  assert.ok(chunks.some(chunk => chunk.dynamicImports.includes(lazy[0].fileName)), 'The default adapter retains its original lazy load')
  const sdkExternal = chunks.some(chunk => chunk.imports.includes(sdk))
  assert.equal(sdkExternal, mutation !== 'external', 'The actual compiled SDK import follows the production dependency choice')
  await writeFile(join(appResources, 'package.json'), JSON.stringify({ type: 'module' }))
  const copy = materializer(mutation === 'materialization'), coreRuntime = join(appResources, 'node_modules/@agentmux/core')
  await mkdir(coreRuntime, { recursive: true }); await cp(join(core, 'dist'), join(coreRuntime, 'dist'), { recursive: true })
  const coreManifest = JSON.parse(await readFile(join(core, 'package.json'), 'utf8'))
  await writeFile(join(coreRuntime, 'package.json'), JSON.stringify(coreManifest))
  await copy.materializeDependencies(core, coreManifest.dependencies, join(coreRuntime, 'node_modules'))
  await copy.copySdk(appResources)
  // Other Main externals are unchanged test setup, resolved by the same production materializer.
  await copy.materializeDependencies(desktop, { tldts: '', ws: '' }, join(appResources, 'node_modules'))
  for (let parent = dirname(appResources); ; parent = dirname(parent)) {
    assert.equal(await stat(join(parent, 'node_modules')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }), false, 'The isolated application has no ancestor node_modules')
    if (parent === dirname(parent)) break
  }
  const processResult = await child(join(output, 'consumer.mjs'), join(output, lazy[0].fileName), appResources)
  const row = { label, mutation: mutation ?? null, result: mutation ? 'RED' : 'GREEN', sdkExternal,
    chunks: chunks.map(chunk => ({ file: chunk.fileName, sha256: sha(chunk.code), modules: Object.keys(chunk.modules), imports: chunk.imports })), process: processResult }
  await writeFile(join(evidenceRoot, label + '.json'), JSON.stringify(row, null, 2))
  const result = JSON.parse(processResult.stdout.trim())
  assert.equal(result.networkCalls, 0, 'Neither the source nor its mutations may contact a platform')
  if (mutation) {
    assert.equal(processResult.code, 1, processResult.stderr); assert.equal(result.passed, false)
    assert.equal(result.error.code, 'CONNECTION_ADAPTER_UNAVAILABLE')
    assert.equal(result.cause.code, mutation === 'external' ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND')
    assert.match(result.cause.message, mutation === 'external' ? /protobufjs\/minimal/ : /@larksuiteoapi\/node-sdk/)
  } else { assert.equal(processResult.code, 0, processResult.stderr); assert.equal(result.passed, true) }
  evidence.cases.push({ label, result: row.result, receipt: label + '.json' }); console.log(label + ': ' + (mutation ? 'expected RED' : 'GREEN'))
}
try {
  process.chdir(desktop)
  await run('source')
  if (args.includes('--mutations')) {
    await run('sdk-external-revoked', 'external')
    await run('sdk-copy-revoked', 'materialization')
    await run('restored-source')
  }
  for (const [file, hash] of Object.entries(evidence.sourceInputs)) assert.equal(sha(await readFile(join(repository, file))), hash, 'Source changed during the bounded package proof: ' + file)
  evidence.passed = true; await writeFile(join(evidenceRoot, 'receipt.json'), JSON.stringify(evidence, null, 2))
} finally { process.chdir(repository); await rm(configWork, { recursive: true, force: true }); await rm(isolated, { recursive: true, force: true }) }
