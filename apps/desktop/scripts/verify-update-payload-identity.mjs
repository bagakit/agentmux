import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { prepareCandidate } from './fixtures/update-payload-identity/candidate.mjs'
import { copyDirectoryContents, inspectRuntimeApplicationPayload, copyRuntimeFiles } from './runtime-application-payload.mjs'
import { hashElectronArtifact, inspectElectronApplication } from './electron-application.mjs'
import { updateRoute } from '../src/shared/update-policy.ts'

const repository = resolve(import.meta.dirname, '../../..'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(join(repository, '.tmp'), { recursive: true })
const evidence = await mkdtemp(join(repository, '.tmp/update-payload-identity-'))
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-update-payload-'))), candidate = join(temporary, 'candidate')
const snapshots = join(temporary, 'snapshots'), application = join(temporary, 'AgentMux.app'), appResources = join(application, 'Contents/Resources/app')
const sourcePaths = ['apps/desktop/package.json', 'apps/desktop/electron.vite.config.ts', 'apps/host/src/index.ts',
  'packages/git/src/project-identity.ts', 'packages/git/tsconfig.build.json', 'packages/git/tsconfig.json', 'tsconfig.base.json',
  'apps/desktop/scripts/update-local.mjs', 'apps/desktop/scripts/update-renderer.mjs', 'apps/desktop/src/shared/update-policy.ts',
  'apps/desktop/test/package-staging-copy.test.ts', 'apps/desktop/test/browser-package-declarations.test.ts',
  'apps/desktop/test/git-package-runtime.test.ts', 'apps/desktop/test/package-smoke-diagnostics.test.ts',
  'apps/desktop/test/runtime-artifact-identity.test.ts', 'apps/desktop/test/package-main-hashing-runtime.test.ts',
  'apps/host/test/portable-host-materializer.test.mjs', 'apps/desktop/scripts/package-smoke-context.mjs',
  'scripts/package-dependencies.mjs', ...['runtime-application-payload', 'update-identity', 'build-desktop', 'build-renderer-release',
    'copy-mobile', 'embedded-core-cli', 'electron-application', 'macos-application-brand', 'package-macos', 'package-identity',
    'static-avatar-runtime', 'prepare-browser-extension-identity', 'verify-update-payload-identity'].map(name => `apps/desktop/scripts/${name}.mjs`),
  'apps/desktop/scripts/fixtures/update-payload-identity/candidate.mjs']
const binding = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(join(repository, path)))])))
const receipt = { schema: 'agentmux.update-payload-identity-proof.v1', passed: false, sources: await binding(), stages: [], cases: [], mutants: [], cleanup: [] }
let sequence = 0
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTMUX_|CTXMUX_)/.test(key) && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)))
async function command(label, executable, args, cwd = candidate, options = {}) {
  const started = performance.now(), file = `${String(++sequence).padStart(2, '0')}-${label}.log`
  try {
    const result = await promisify(execFile)(executable, args, { cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: 120000, ...options })
    await writeFile(join(evidence, file), result.stdout + result.stderr)
    receipt.stages.push({ label, executable, args, cwd, log: file, exitCode: 0, elapsedMs: performance.now() - started })
    return result
  } catch (error) {
    await writeFile(join(evidence, file), (error.stdout ?? '') + (error.stderr ?? '') + '\n' + String(error))
    receipt.stages.push({ label, executable, args, cwd, log: file, exitCode: error.code, signal: error.signal, elapsedMs: performance.now() - started })
    throw error
  }
}
async function node(label, code, cwd = candidate) { return command(label, process.execPath, ['--input-type=module', '--eval', code], cwd) }
async function put(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes) }
async function hashes(root, paths) {
  const files = {}
  async function visit(path) {
    const info = await lstat(join(root, path))
    if (info.isDirectory()) for (const name of (await readdir(join(root, path))).sort()) await visit(join(path, name))
    else files[path] = sha(await readFile(join(root, path)))
  }
  for (const path of paths) await visit(path)
  return files
}
async function restore(directory, saved) { await rm(directory, { recursive: true, force: true }); await copyDirectoryContents(saved, directory) }
const mainOutput = join(candidate, 'apps/desktop/out/main'), gitOutput = join(candidate, 'packages/git/dist')
async function release(label) {
  await node(label, "const {writeRendererRelease}=await import('./apps/desktop/scripts/build-renderer-release.mjs');await writeRendererRelease(process.cwd())")
  return JSON.parse(await readFile(join(candidate, 'apps/desktop/out/renderer/release.json'), 'utf8'))
}
async function route(before, after, expected, label) {
  assert.equal(updateRoute(before.identity, after.identity), expected, `${label}: actual payload must choose ${expected}`)
  const homeDirectory = join(temporary, 'route-home')
  await put(join(homeDirectory, 'Applications/AgentMux.app/Contents/Resources/app/out/renderer/release.json'), JSON.stringify(before))
  // Actual updater, stopped at its exact subprocess boundary before any copy/install/user process action.
  const result = await node(label + '-public-route', `import assert from 'node:assert/strict';import os from 'node:os';import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';
os.homedir=()=>${JSON.stringify(homeDirectory)};let selected;cp.spawnSync=(command,args)=>{selected={command,args};throw Error('PRIVATE_ROUTE_BOUNDARY')};syncBuiltinESMExports();
let error;try{await import('./apps/desktop/scripts/update-local.mjs')}catch(value){error=value}
const expected=${JSON.stringify(expected)};if(expected==='runtime-review'){assert.match(error.message,/ctxmux changed/);assert.equal(selected,undefined)}else{assert.equal(error.message,'PRIVATE_ROUTE_BOUNDARY');assert.ok(selected.args[0].endsWith(expected==='renderer'?'/update-renderer.mjs':'/package-macos.mjs'))}console.log(JSON.stringify({expected,selected: selected??null}));`)
  const renderer = await node(label + '-renderer-route', `import assert from 'node:assert/strict';import os from 'node:os';import cp from 'node:child_process';import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';import{promisify}from'node:util';
os.homedir=()=>${JSON.stringify(homeDirectory)};let copies=0;cp.execFile=Object.assign(()=>{throw Error('Unexpected direct execFile')},{[promisify.custom]:async(command,args)=>{assert.equal(command,'/usr/libexec/PlistBuddy');return{stdout:'dev.agentmux.private-proof\\n',stderr:''}}});fs.cp=async()=>{copies++;throw Error('PRIVATE_RENDERER_COPY_BOUNDARY')};syncBuiltinESMExports();
let error;try{await import('./apps/desktop/scripts/update-renderer.mjs')}catch(value){error=value}const expected=${JSON.stringify(expected)};if(expected==='renderer'){assert.equal(copies,1);assert.equal(error.message,'PRIVATE_RENDERER_COPY_BOUNDARY')}else{assert.equal(copies,0);assert.match(error.message,/Host or runtime changed/)}console.log(JSON.stringify({expected,copies}));`)
  return { expected, before: before.identity, after: after.identity, updater: result.stdout.trim(), renderer: renderer.stdout.trim() }
}
async function unchangedOutputs() {
  await restore(mainOutput, join(snapshots, 'main-original'))
  await restore(gitOutput, join(snapshots, 'git-original'))
}
async function scenario(kind) {
  await unchangedOutputs()
  const before = await release(kind + '-before')
  let cleanup = async () => {}, expected = 'application'
  if (kind === 'host') await restore(mainOutput, join(snapshots, 'main-changed'))
  else if (kind === 'git') await restore(gitOutput, join(snapshots, 'git-changed'))
  else if (kind === 'renderer') {
    const path = join(candidate, 'apps/desktop/out/renderer/private-payload-probe.txt')
    await writeFile(path, 'explicit renderer change'); cleanup = () => rm(path); expected = 'renderer'
  } else if (kind === 'foreign' || kind === 'current') {
    const root = join(candidate, 'packages/core/vendor/ctxmux'), selected = `${process.platform}-${process.arch}`
    const other = kind === 'current' ? selected : (await readdir(root)).find(name => name !== selected && /^(?:darwin|linux|win32)-/.test(name))
    assert.ok(other, 'A real foreign artifact is required')
    const path = join(root, other, 'manifest.json'), original = await readFile(path)
    await writeFile(path, Buffer.concat([original, Buffer.from('\n')])); cleanup = () => writeFile(path, original); expected = kind === 'current' ? 'runtime-review' : 'renderer'
  } else throw Error('Unknown exact proof case')
  try { return await route(before, await release(kind + '-after'), expected, kind) }
  finally { await cleanup() }
}
try {
  receipt.borrowed = await prepareCandidate(repository, candidate)
  await mkdir(snapshots)
  const coreInputPaths = ['packages/core/src', 'packages/core/guides', 'packages/core/native', 'packages/core/package.json',
    'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json', 'tsconfig.base.json',
    ...['build', 'clean-build', 'generate-guides', 'check-guides'].map(name => 'packages/core/scripts/' + name + '.mjs')]
  const coreInputs = await hashes(candidate, coreInputPaths)
  assert.deepEqual(coreInputs, await hashes(repository, coreInputPaths), 'The private Core recipe receives exact current sources')
  const coreRequire = createRequire(join(repository, 'packages/core/package.json'))
  const tools = { tsc: coreRequire.resolve('typescript/bin/tsc'), esbuild: coreRequire.resolve('esbuild/bin/esbuild') }
  const toolRoot = join(candidate, '.tools'); await mkdir(toolRoot)
  await writeFile(join(toolRoot, 'pnpm'), '#!/usr/bin/env node\nconst{execFileSync}=require("node:child_process"),tools=' + JSON.stringify(tools) + ';const[a,b,...rest]=process.argv.slice(2);if(a!=="exec"||!Object.hasOwn(tools,b))throw Error("Unexpected private Core build command");execFileSync(b==="tsc"?process.execPath:tools[b],b==="tsc"?[tools[b],...rest]:rest,{stdio:"inherit"});\n', { mode: 0o700 })
  await command('original-core-target-build', process.execPath, ['packages/core/scripts/build.mjs'], candidate,
    { timeout: 0, env: { ...env, PATH: toolRoot + ':' + env.PATH } })
  const coreOutputs = await hashes(candidate, ['packages/core/dist'])
  assert.ok(Object.keys(coreOutputs).length > 100 && coreOutputs['packages/core/dist/mote-dialogue.js'], 'Complete original Core output includes the actually consumed public entry')
  assert.deepEqual(await hashes(repository, coreInputPaths), coreInputs, 'Private build must not write back to original Core sources')
  receipt.coreBuild = { inputs: coreInputs, generated: await hashes(candidate, ['packages/core/src/generated']), outputs: coreOutputs,
    tools: Object.fromEntries(await Promise.all(Object.entries(tools).map(async ([name, path]) => [name, { path, sha256: sha(await readFile(path)) }]))) }
  const desktop = join(candidate, 'apps/desktop'), host = join(candidate, 'apps/host/src/index.ts'), git = join(candidate, 'packages/git/src/project-identity.ts')
  const hostOriginal = await readFile(host, 'utf8'), gitOriginal = await readFile(git, 'utf8')
  const electronVite = join(repository, 'apps/desktop/node_modules/electron-vite/bin/electron-vite.js')
  const require = createRequire(join(repository, 'packages/git/package.json')), tsc = require.resolve('typescript/bin/tsc')
  async function buildMain(label) {
    await command(label, process.execPath, [electronVite, 'build', '--config', 'payload-proof.config.mjs'], desktop)
    const observed = JSON.parse(await readFile(join(candidate, 'main-build-observation.json'), 'utf8'))
    assert.equal(Object.keys(observed).length, 1, 'Actual original Host entry must be consumed once')
    assert.ok(Object.keys(observed)[0].endsWith('/apps/host/src/index.ts'))
    return { entry: sha(await readFile(host)), transformed: observed, compiled: sha(await readFile(join(mainOutput, 'agentmux-host.js'))) }
  }
  receipt.mainOriginal = await buildMain('main-original')
  await copyDirectoryContents(mainOutput, join(snapshots, 'main-original'))
  const hostNeedle = 'The Host requires the original absolute Agent Session Store path.'
  assert.equal(hostOriginal.split(hostNeedle).length, 2)
  await writeFile(host, hostOriginal.replace(hostNeedle, hostNeedle + ' Private compiled payload probe.'))
  receipt.mainChanged = await buildMain('main-changed')
  assert.notEqual(receipt.mainOriginal.compiled, receipt.mainChanged.compiled)
  await copyDirectoryContents(mainOutput, join(snapshots, 'main-changed')); await writeFile(host, hostOriginal)
  async function buildGit(label) {
    await command(label, process.execPath, [tsc, '-b', 'tsconfig.build.json', '--force'], join(candidate, 'packages/git'))
    return { entry: sha(await readFile(git)), compiled: sha(await readFile(join(gitOutput, 'project-identity.js'))) }
  }
  receipt.gitOriginal = await buildGit('git-original'); await copyDirectoryContents(gitOutput, join(snapshots, 'git-original'))
  const gitNeedle = 'return `${url.hostname.toLowerCase()}${port}/${path}`'
  assert.equal(gitOriginal.split(gitNeedle).length, 2)
  await writeFile(git, gitOriginal.replace(gitNeedle, 'return `${url.hostname.toLowerCase()}${port}/${path}-payload-probe`'))
  receipt.gitChanged = await buildGit('git-changed'); assert.notEqual(receipt.gitOriginal.compiled, receipt.gitChanged.compiled)
  await copyDirectoryContents(gitOutput, join(snapshots, 'git-changed')); await writeFile(git, gitOriginal)
  await unchangedOutputs()
  // Actual package copier, without Electron frameworks, branding, signing, installation or Runtime startup.
  await node('actual-runtime-copy', `const{copyRuntimeApplication}=await import('./apps/desktop/scripts/package-macos.mjs');await copyRuntimeApplication(${JSON.stringify(application)},{commit:'private-original',tree:'private-original'})`)
  const payload = await inspectRuntimeApplicationPayload(candidate)
  assert.ok(payload.copies.length > 100 && payload.generated.length > 0 && payload.avatar.publication.packages.length > 0)
  receipt.copy = { copies: payload.copies.length, generated: payload.generated.length, publications: payload.avatar.publication.report,
    wrapper: sha(await readFile(join(appResources, 'out/bin/amux'))), identity: JSON.parse(await readFile(join(appResources, 'package-identity.json'), 'utf8')) }
  for (const item of payload.generated) assert.equal(await readFile(join(appResources, item.target), 'utf8'), item.contents)
  async function consumeHost(label, message) {
    let result
    try { await command(label, process.execPath, [join(appResources, 'out/main/agentmux-host.js')], temporary, { env: { PATH: process.env.PATH, NODE_PATH: '' } }) }
    catch (error) { result = error }
    assert.equal(result?.code, 1); assert.ok(result.stderr.includes(message)); assert.ok(!result.stderr.includes('ERR_MODULE_NOT_FOUND'))
  }
  await consumeHost('copied-original-host', hostNeedle)
  await restore(mainOutput, join(snapshots, 'main-changed'))
  await copyRuntimeFiles(payload.copies.filter(item => item.target === 'out'), appResources)
  await consumeHost('copied-changed-host', hostNeedle + ' Private compiled payload probe.')
  async function consumeGit(label, expected) {
    const result = await node(label, `import assert from 'node:assert/strict';const m=await import('@agentmux/git');const value=m.normalizeGitProjectRemote('https://GitHub.com/example/repo.git');assert.equal(value,${JSON.stringify(expected)});console.log(JSON.stringify({value,resolution:import.meta.resolve('@agentmux/git')}))`, appResources)
    const row = JSON.parse(result.stdout); assert.ok(row.resolution.startsWith(pathToFileURL(appResources + '/').href)); return row
  }
  receipt.gitCopiedOriginal = await consumeGit('copied-original-git', 'github.com/example/repo')
  await restore(gitOutput, join(snapshots, 'git-changed'))
  await copyRuntimeFiles(payload.copies.filter(item => item.target.startsWith('node_modules/@agentmux/git/')), appResources)
  receipt.gitCopiedChanged = await consumeGit('copied-changed-git', 'github.com/example/repo-payload-probe')
  for (const kind of ['host', 'git', 'renderer', 'foreign', 'current']) receipt.cases.push({ kind, result: await scenario(kind) })
  const mutants = [
    { name: 'omit-main-host', file: 'runtime-application-payload.mjs', from: "clone(join(desktop, 'out'), 'out');", to: '', kind: 'host' },
    { name: 'omit-workspace', file: 'runtime-application-payload.mjs', from: "['@agentmux/git', '@agentmux/capsule'", to: "['@agentmux/capsule'", kind: 'git' },
    { name: 'include-renderer', file: 'runtime-application-payload.mjs', from: "path === 'out/renderer' || path.startsWith('out/renderer/') ||", to: '', kind: 'renderer' },
    { name: 'include-foreign-native', file: 'update-identity.mjs', from: "[join(runtimeRelative, `${process.platform}-${process.arch}`)]", to: '[runtimeRelative]', kind: 'foreign' }
  ]
  for (const mutation of mutants) {
    const file = join(candidate, 'apps/desktop/scripts', mutation.file), original = await readFile(file, 'utf8')
    assert.equal(original.split(mutation.from).length, 2, 'Unique actual production mutation anchor')
    const changed = original.replace(mutation.from, mutation.to); await writeFile(file, changed)
    let failure
    try { await scenario(mutation.kind) } catch (error) { failure = error }
    finally { await writeFile(file, original) }
    assert.equal(failure?.name, 'AssertionError', 'Only the actual route assertion counts as mutation RED')
    assert.ok(failure.message.includes('actual payload must choose'), 'Preparation/build failures do not count as RED')
    receipt.mutants.push({ name: mutation.name, source: relative(candidate, file), original: sha(original), changed: sha(changed),
      red: failure.message, restored: await scenario(mutation.kind) })
  }
  receipt.electron = await inspectElectronApplication(candidate)
  const desktopManifestPath = join(candidate, 'apps/desktop/package.json'), desktopBytes = await readFile(desktopManifestPath), desktopManifest = JSON.parse(desktopBytes)
  desktopManifest.devDependencies.electron = '0.0.0'
  await writeFile(desktopManifestPath, JSON.stringify(desktopManifest))
  try { await assert.rejects(inspectElectronApplication(candidate), /exact declaration/) }
  finally { await writeFile(desktopManifestPath, desktopBytes) }
  const electronFixture = join(temporary, 'electron-negative'), electronPackage = join(electronFixture, 'apps/desktop/node_modules/electron')
  await put(join(electronFixture, 'apps/desktop/package.json'), JSON.stringify({ devDependencies: { electron: '1.0.0' } }))
  await put(join(electronPackage, 'package.json'), JSON.stringify({ name: 'electron', version: '1.0.0' }))
  await put(join(electronPackage, 'dist/version'), '0.9.0')
  await assert.rejects(inspectElectronApplication(electronFixture), /artifact does not match/)
  await put(join(electronPackage, 'dist/version'), '1.0.0'); await put(join(electronPackage, 'path.txt'), 'missing-entry')
  await assert.rejects(inspectElectronApplication(electronFixture), { code: 'ENOENT' })
  receipt.electronNegative = { declarationMismatch: true, artifactMismatch: true, missingOriginalEntry: true }
  const regularArtifact = join(temporary, 'electron-regular'), linkedArtifact = join(temporary, 'electron-linked')
  await put(join(regularArtifact, 'entry'), 'missing-target'); await mkdir(linkedArtifact)
  await symlink('missing-target', join(linkedArtifact, 'entry'))
  await chmod(join(regularArtifact, 'entry'), (await lstat(join(linkedArtifact, 'entry'))).mode & 0o777)
  const regularHash = await hashElectronArtifact(regularArtifact), linkedHash = await hashElectronArtifact(linkedArtifact)
  assert.notEqual(regularHash, linkedHash, 'Actual Electron file/link kind cannot collide when bytes and mode are equal')
  receipt.electronEntryKinds = { regularHash, linkedHash }
  const brandPath = join(candidate, 'apps/desktop/scripts/macos-application-brand.mjs'), brandBytes = await readFile(brandPath, 'utf8')
  const beforeBrand = await release('brand-before'), brandNeedle = 'AgentMux captures the screen area you select to attach it to your message.'
  assert.equal(brandBytes.split(brandNeedle).length, 2)
  await writeFile(brandPath, brandBytes.replace(brandNeedle, brandNeedle + ' Exact changed brand fact.'))
  try { receipt.brand = await route(beforeBrand, await release('brand-after'), 'application', 'brand') }
  finally { await writeFile(brandPath, brandBytes) }
  await node('build-owner-order-and-failure', `import assert from 'node:assert/strict';import cp from 'node:child_process';import fs from 'node:fs/promises';import{EventEmitter}from'node:events';import{syncBuiltinESMExports}from'node:module';import{join}from'node:path';import{promisify}from'node:util';
const original={execFile:cp.execFile,spawn:cp.spawn,copy:fs.cp,write:fs.writeFile},root=process.cwd(),releasePath=join(root,'apps/desktop/out/renderer/release.json'),mobile=join(root,'apps/mobile/dist');let phase,events=[];
cp.execFile=function(command,args,options,callback){if(command===process.execPath&&args[0].endsWith('/electron/install.js')){events.push('electron');queueMicrotask(()=>callback(phase==='electron'?Error('PRIVATE_BUILD_FAILURE'):null,'',''));return}return original.execFile.apply(this,arguments)};
cp.execFile[promisify.custom]=async(command,args,options)=>{if(command===process.execPath&&args[0].endsWith('/electron/install.js')){events.push('electron');if(phase==='electron')throw Error('PRIVATE_BUILD_FAILURE');return{stdout:'',stderr:''}}return await promisify(original.execFile)(command,args,options)};
cp.spawn=(command,args)=>{const child=new EventEmitter(),step=command==='pnpm'?'mobile':'main';assert.deepEqual([command,args],step==='mobile'?['pnpm',['--filter','@agentmux/mobile','build']]:['electron-vite',['build']]);events.push(step);queueMicrotask(async()=>{try{if(step==='mobile'&&phase!=='missing-mobile'){await fs.mkdir(mobile,{recursive:true});await original.write(join(mobile,'index.html'),'actual mobile copy marker')}child.emit('exit',phase===step?19:0,null)}catch(error){child.emit('error',error)}});return child};
fs.cp=async(...args)=>{if(args[1]===join(root,'apps/desktop/out/mobile'))events.push('copy-mobile');return original.copy(...args)};
fs.writeFile=async(...args)=>{if(args[0]===releasePath)events.push('release');return original.write(...args)};syncBuiltinESMExports();
try{const{buildDesktop}=await import('./apps/desktop/scripts/build-desktop.mjs');const results=[];for(phase of ['electron','mobile','main','missing-mobile','success']){events=[];await fs.rm(mobile,{recursive:true,force:true});const before=await fs.readFile(releasePath);let failure;try{await buildDesktop(root)}catch(error){failure=error}if(phase==='success'){assert.equal(failure,undefined);assert.deepEqual(events,['electron','mobile','main','copy-mobile','release']);assert.equal(await fs.readFile(join(root,'apps/desktop/out/mobile/index.html'),'utf8'),'actual mobile copy marker')}else{assert.ok(failure);assert.deepEqual(await fs.readFile(releasePath),before);assert.ok(!events.includes('release'));if(phase==='missing-mobile')assert.equal(failure.code,'ENOENT')}results.push({phase,events:[...events],error:failure?.message??null})}console.log(JSON.stringify(results))}finally{cp.execFile=original.execFile;cp.spawn=original.spawn;fs.cp=original.copy;fs.writeFile=original.write;syncBuiltinESMExports()}`)
  const beforeMobile = await release('mobile-before')
  await put(join(candidate, 'apps/mobile/dist/index.html'), 'changed actual mobile output')
  await node('actual-copy-mobile', "const{copyMobile}=await import('./apps/desktop/scripts/copy-mobile.mjs');await copyMobile(process.cwd())")
  receipt.mobile = await route(beforeMobile, await release('mobile-after'), 'application', 'mobile')
  const beforeMissing = await readFile(join(candidate, 'apps/desktop/out/renderer/release.json'))
  const missingSource = join(candidate, 'packages/core/dist'), retainedSource = join(temporary, 'retained-core-dist')
  await rename(missingSource, retainedSource)
  try {
    let failure; try { await release('missing-required-dist') } catch (error) { failure = error }
    assert.ok(failure?.stderr.includes('ENOENT')); assert.deepEqual(await readFile(join(candidate, 'apps/desktop/out/renderer/release.json')), beforeMissing)
  } finally { await rename(retainedSource, missingSource) }
  const provenanceBefore = await release('provenance-before')
  const provenance = await node('actual-copied-provenance-and-launcher-cwd', `import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{join}from'node:path';import{inspectRuntimeApplicationPayload,hashRuntimePayload,writeRuntimeProvenance}from'./apps/desktop/scripts/runtime-application-payload.mjs';
const root=process.cwd(),app=${JSON.stringify(appResources)},payload=await inspectRuntimeApplicationPayload(root);const rows=[];for(const cwd of ['/', '/tmp', root]){process.chdir(cwd);const current=await inspectRuntimeApplicationPayload(root);rows.push(current.generated.filter(row=>row.target.endsWith('/amux')))}assert.deepEqual(rows[0],rows[1]);assert.deepEqual(rows[1],rows[2]);
const copied={...payload,copies:[{source:app,target:'',clone:true}]};const paths=[payload.packageIdentity.target,payload.coreRelease];const before=await Promise.all(paths.map(path=>readFile(join(app,path),'utf8'))),beforeHash=await hashRuntimePayload(copied);await writeRuntimeProvenance(payload,app,{commit:'private-second-commit',tree:'private-second-tree'});const after=await Promise.all(paths.map(path=>readFile(join(app,path),'utf8')));for(let i=0;i<paths.length;i++){assert.notEqual(before[i],after[i]);const value=JSON.parse(after[i]);assert.equal(value.sourceCommit,'private-second-commit');assert.equal(value.sourceTree,'private-second-tree')}const afterHash=await hashRuntimePayload(copied);assert.equal(beforeHash,afterHash,'Actual copied report changes do not change effective payload compatibility');console.log(JSON.stringify({cwdIndependent:true,before,after,beforeHash,afterHash}));`)
  receipt.provenance = { actual: JSON.parse(provenance.stdout), route: await route(provenanceBefore, await release('provenance-after'), 'renderer', 'provenance') }

  // Remaining bounded owner/ordering and platform checks are real existing consumers.
  const smokeFiles = ['apps/desktop/test/package-staging-copy.test.ts','apps/desktop/test/browser-package-declarations.test.ts',
    'apps/desktop/test/git-package-runtime.test.ts','apps/desktop/test/package-smoke-diagnostics.test.ts',
    'apps/desktop/test/runtime-artifact-identity.test.ts','apps/desktop/test/package-main-hashing-runtime.test.ts']
  const smokeConfig = `export default {test:{environment:'node',include:${JSON.stringify(smokeFiles.map(file => join(repository, file)))},maxWorkers:1,testTimeout:90000}}`
  await put(join(candidate, 'proof.config.mjs'), smokeConfig)
  const smokeReport = join(evidence, 'affected-consumers.json'), hashingEvidence = join(evidence, 'actual-main-hashing-consumer.json')
  await command('affected-consumer-smoke', process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(candidate, 'proof.config.mjs'), '--reporter=json', '--outputFile=' + smokeReport], repository,
    { env: { ...env, AGENTMUX_PACKAGE_HASHING_EVIDENCE: hashingEvidence, AGENTMUX_PACKAGE_HASHING_SOURCE: join(candidate, 'apps/desktop/scripts/runtime-application-payload.mjs') } })
  const smoke = JSON.parse(await readFile(smokeReport, 'utf8')), assertions = smoke.testResults.flatMap(suite => suite.assertionResults)
  assert.equal(smoke.numTotalTests, 18); assert.equal(assertions.length, 18); assert.equal(smoke.numFailedTests, 0)
  assert.equal(smoke.numPendingTests, 0); assert.equal(smoke.numTodoTests, 0)
  for (const file of smokeFiles) assert.equal(smoke.testResults.filter(suite => suite.name === join(repository, file)).length, 1, 'Every directly affected consumer loaded')
  assert.ok(assertions.every(value => value.status === 'passed'))
  const mainConsumer = JSON.parse(await readFile(hashingEvidence, 'utf8')); assert.equal(mainConsumer.passed, true); assert.equal(mainConsumer.cleanup.removed, true)
  receipt.smoke = { files: smokeFiles, tests: assertions.length, config: smokeConfig, configSha256: sha(smokeConfig), reportSha256: sha(await readFile(smokeReport)), mainConsumerSha256: sha(await readFile(hashingEvidence)) }
  const publication = await command('publication-target-boundary', process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=publication materialization', 'apps/host/test/portable-host-materializer.test.mjs'], repository)
  assert.match(publication.stdout, /^# tests 1$/m); assert.match(publication.stdout, /^# pass 1$/m); assert.match(publication.stdout, /^# skipped 0$/m)
  receipt.publicationBoundary = { tests: 1, passed: 1 }
  assert.deepEqual(await binding(), receipt.sources, 'Current owning source remains exact')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  for (const path of [temporary]) {
    try { await rm(path, { recursive: true, force: true }); receipt.cleanup.push({ path, removed: !(await lstat(path).catch(() => null)) }) }
    catch (error) { receipt.cleanup.push({ path, removed: false, error: String(error) }); receipt.passed = false; process.exitCode = 1 }
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(repository, join(evidence, 'receipt.json')) }))
}
