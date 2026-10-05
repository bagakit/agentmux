import { fixturePath as _reshape_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
const mutation = process.argv[process.argv.indexOf('--mutation') + 1] ?? null
const mutationNames = ['source-owner-disconnected','host-forward-disconnected','result-decoder-disconnected','exact-source-ignored']
const selectedMutation = process.argv.includes('--mutation') ? mutation : null
if (selectedMutation && !mutationNames.includes(selectedMutation)) throw new Error('Unknown source mutation')
const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const workspaceModules = { name:'original-workspace-exports', setup(plugin) {
  plugin.onResolve({filter:/^@agentmux\//}, args => {
    const parts=args.path.split('/'), name=parts[1], subpath=parts.length>2?'./'+parts.slice(2).join('/') : '.'
    const folder=name==='core' ? coreRoot : path.join(root,'packages',name), manifest=require(path.join(folder,'package.json'))
    const target=manifest.exports[subpath]
    if (!target?.import) throw new Error('Missing original import export: '+args.path)
    return {path:path.join(folder,target.import),external:true}
  })
} }
const directory = path.join(root, '.local/state/mote-avatar-series', randomUUID()), compiled = path.join(directory, 'compiled')
const runtimeRoot = _reshape_fixturePath("private/tmp/amx-avatar-") + randomUUID().slice(0, 8)
await fs.mkdir(compiled, { recursive: true }); await fs.mkdir(runtimeRoot)
const receipt = { passed: false, boundary: 'Actual original Main image/model source and port, isolated Electron nativeImage server, production Node Host forwarding and actual compiled amux CLI. No installed App or live user Session claim.', source: {}, calls: [], processes: [] }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const children = [], logs = []
let stage = 'setup'
let coreRoot = path.join(root,'packages/core')
const sourceMutation = { name:'bounded-source-mutation', setup(plugin) {
  plugin.onLoad({filter:/\.ts$/}, async args => {
    const targets = {
      'source-owner-disconnected': ['apps/desktop/src/main/mote-avatar-control.ts', 'constructor(private readonly sources: MoteAvatarSeriesOwner, private readonly writer?: MoteAvatarWriter)', 'constructor(_sources: MoteAvatarSeriesOwner, private readonly writer?: MoteAvatarWriter)'],
      'host-forward-disconnected': ['apps/host/src/host.ts', 'forwardControl: async', 'detachedAvatarProbeForwardControl: async'],
      'exact-source-ignored': ['apps/desktop/src/main/mote-avatar-series.ts', 'read.series.entries.find(entry => entry.entryId === locator.entryId)', 'read.series.entries[0]']
    }
    const target = targets[selectedMutation]
    if (!target || args.path !== path.join(root,target[0])) return
    const original = await fs.readFile(args.path,'utf8'); assert.equal(original.split(target[1]).length,2)
    const changed = original.replace(target[1],target[2]); receipt.mutation = {name:selectedMutation,file:target[0],originalSha:sha(original),changedSha:sha(changed)}
    return {contents:changed,loader:'ts'}
  })
} }
const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtimeRoot, AGENTMUX_STATE_DIRECTORY: path.join(directory, 'state'), AGENTMUX_SPATIAL_STATE_STORE: path.join(directory, 'spatial.json'), AGENTMUX_AGENT_SESSION_STORE: path.join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: path.join(directory, 'messages.ndjson') }
for (const name of ['ELECTRON_RUN_AS_NODE','AGENTMUX_RPC_ENDPOINT','AGENTMUX_AGENT_SESSION_ID','AGENTMUX_AGENT_CAPABILITY']) delete env[name]
const run = (file, args, extra = {}) => {
  const child = spawn(file, args, { cwd: root, env, stdio: ['ignore','pipe','pipe'], ...extra }); children.push(child)
  const result = { file, args, pid: child.pid, stdout: '', stderr: '', exitCode: null }; logs.push(result)
  child.stdout.on('data', bytes => { result.stdout += bytes }); child.stderr.on('data', bytes => { result.stderr += bytes })
  const ended = new Promise(resolve => child.once('exit', (code, signal) => { result.exitCode = code; result.signal = signal; resolve(result) }))
  child.once('error', error => { result.error = String(error) }); return { child, ended, result }
}
const waitFile = async (file, child) => {
  for (let index = 0; index < 400; index++) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (child.exitCode !== null) throw new Error('Original process exited before ready: ' + file)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Original process did not announce readiness: ' + file)
}
const cli = async (args, expectError = false) => {
  const execution = run(process.execPath, [path.join(coreRoot, 'bin/amux'), ...args])
  const result = await execution.ended
  receipt.calls.push({ args, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })
  if (expectError) { assert.notEqual(result.exitCode, 0); return result }
  if (result.exitCode !== 0) { const failure = JSON.parse(result.stderr.trim()); const error = new Error(failure.error?.message ?? 'Actual CLI failed'); error.code = failure.error?.code; throw error } const wire = JSON.parse(result.stdout); assert.equal(wire.ok, true); assert.ok(wire.result && typeof wire.result === 'object'); return wire.result
}
try {
  if (selectedMutation === 'result-decoder-disconnected') {
    coreRoot = path.join(compiled,'core'); await fs.mkdir(path.join(coreRoot,'bin'),{recursive:true})
    for (const file of ['package.json','bin/amux']) await fs.copyFile(path.join(root,'packages/core',file),path.join(coreRoot,file))
    await fs.cp(path.join(root,'packages/core/dist'),path.join(coreRoot,'dist'),{recursive:true})
    for (const name of ['node_modules','vendor']) await fs.symlink(path.join(root,'packages/core',name),path.join(coreRoot,name),'dir')
    const file=path.join(coreRoot,'dist/rpc-native-codec.js'), original=await fs.readFile(file,'utf8'), needle='if (isMoteAvatarSeriesMethod(method))'
    assert.equal(original.split(needle).length,2); const changed=original.replace(needle,'if (false && isMoteAvatarSeriesMethod(method))')
    await fs.writeFile(file,changed); receipt.mutation={name:selectedMutation,file:'packages/core/src/rpc-native-codec.ts',originalDistSha:sha(original),changedDistSha:sha(changed)}
  }
  const user = path.join(directory, 'avatars'), photos = path.join(user, 'personal'), mixed = path.join(user, 'mixed')
  await fs.mkdir(photos, { recursive: true }); await fs.mkdir(mixed)
  await fs.copyFile(path.join(root, 'apps/desktop/resources/avatar-series/lowpoly/lowpoly-owl.png'), path.join(photos, 'owl.png'))
  await fs.writeFile(path.join(mixed, 'series.json'), JSON.stringify({ schema: 'agentmux.avatar-series.v1', title: 'Personal mixed', entries: [
    { id: 'face', title: 'Original face', definition: { kind: 'face2d', face: { kind: 'face', shape: 'soft', palette: 'mint', eyes: 'round', brows: 'soft', mouth: 'smile', accessory: 'tuft' } } },
    { id: 'textured', title: 'Actual embedded image', definition: {kind:'glb',file:'textured.glb'} },
    { id: 'oversized', title: 'Oversized embedded image', definition: {kind:'glb',file:'oversized.glb'} },
    { id: 'bad', title: 'Broken source', definition: { kind: 'script', file: 'code.js' } }
  ] }))
  await fs.copyFile(path.join(photos, 'owl.png'), path.join(mixed, 'regular.png'))
  const amplified = path.join(user, 'amplified')
  await fs.mkdir(amplified)
  const retainedFace = { id:'retained',title:'Retained original face',definition:{kind:'face2d',face:{kind:'face',shape:'soft',palette:'mint',eyes:'round',brows:'soft',mouth:'smile',accessory:'tuft'}} }
  await fs.writeFile(path.join(amplified,'series.json'),JSON.stringify({schema:'agentmux.avatar-series.v1',entries:[...Array(200000).fill(null),retainedFace]}))
  const imageBytes = await fs.readFile(path.join(root,'apps/desktop/src/renderer/src/assets/pmo-teams-topic-avatar.png'))
  function texturedGlb(png) {
    const position = Buffer.from(new Float32Array([-1,-1,0,1,-1,0,0,1,0]).buffer)
    const binary=Buffer.concat([position,png,Buffer.alloc((4-png.length%4)%4)])
    const json={asset:{version:'2.0'},buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:png.length}],
      accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-1,-1,0],max:[1,1,0]}],images:[{bufferView:1,mimeType:'image/png'}],textures:[{source:0}],
      materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}],meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0}
    const body=Buffer.from(JSON.stringify(json)), padded=Buffer.concat([body,Buffer.alloc((4-body.length%4)%4,32)])
    const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+padded.length+binary.length,8);header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16)
    const chunk=Buffer.alloc(8);chunk.writeUInt32LE(binary.length,0);chunk.writeUInt32LE(0x004e4942,4)
    return Buffer.concat([header,padded,chunk,binary])
  }
  await fs.writeFile(path.join(mixed,'textured.glb'),texturedGlb(imageBytes))
  const badPng=Buffer.from(imageBytes);badPng.writeUInt32BE(4097,16)
  await fs.writeFile(path.join(mixed,'oversized.glb'),texturedGlb(badPng))
  for (const [entry, platform, format] of [['source-entry.ts','node','cjs'],['host-entry.ts','node','esm']]) {
    const output = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, entry)], outfile: path.join(compiled, entry.replace('.ts', format === 'cjs' ? '.cjs' : '.mjs')), platform, format, bundle: true, target: 'node24', packages: 'external', plugins:[sourceMutation,workspaceModules], metafile: true, logLevel: 'error' })
    for (const input of Object.keys(output.metafile.inputs)) receipt.source[input] = sha(await fs.readFile(path.resolve(root, input)))
  }
  const native = run(require('electron'), [path.join(fixture, 'source-main.cjs'), compiled, directory, path.join(root, 'apps/desktop/resources/avatar-series'), runtimeRoot])
  receipt.processes.push(await waitFile(path.join(directory, 'source-ready.json'), native.child))
  const host = run(process.execPath, [path.join(compiled, 'host-entry.mjs'), directory])
  receipt.processes.push(await waitFile(path.join(directory, 'host-ready.json'), host.child))
  stage='consumer'
  const catalog = await cli(['space','mote','avatar','list'])
  assert.ok(catalog.series.some(series => series.origin === 'user' && series.seriesId === 'personal' && series.entries.some(entry => entry.entryId === 'owl.png')))
  assert.ok(catalog.series.some(series => series.seriesId === 'mixed' && series.entries.some(entry => entry.definition.kind === 'face2d') && series.entries.some(entry => entry.definition.kind === 'image')))
  assert.ok(catalog.issues.length > 0, 'Malformed one entry must be an explicit local issue')
  const amplifiedSeries = catalog.series.find(series => series.origin==='user' && series.seriesId==='amplified')
  assert.ok(amplifiedSeries); assert.deepEqual(amplifiedSeries.entries.map(entry=>entry.entryId),['retained'])
  const summary = catalog.issues.find(issue=>issue.count===200000)
  assert.ok(summary && !summary.source, 'Actual public codec must retain an accurate declaration summary without an invented source')
  const amplifiedInput=path.join(directory,'amplified.json')
  await fs.writeFile(amplifiedInput,JSON.stringify({source:{origin:'user',seriesId:'amplified',entryId:'retained'}}))
  const amplifiedPreview=await cli(['space','mote','avatar','preview','--input',amplifiedInput])
  assert.deepEqual(amplifiedPreview.definition,retainedFace.definition)
  assert.equal(amplifiedPreview.issues.length,1); assert.equal(amplifiedPreview.issues[0].count,200000)
  receipt.amplification={malformedEntries:200000,retainedEntries:amplifiedSeries.entries.length,publicIssueCount:amplifiedPreview.issues.length,summaryCount:amplifiedPreview.issues[0].count}
  for (const source of [{ origin:'user',seriesId:'personal',entryId:'owl.png' }, { origin:'user',seriesId:'mixed',entryId:'face' }, { origin:'builtin',seriesId:'geometry',entryId:'expressive' }, { origin:'builtin',seriesId:'lowpoly',entryId:'owl' }, { origin:'user',seriesId:'mixed',entryId:'textured' }]) {
    const file = path.join(directory, 'preview.json'); await fs.writeFile(file, JSON.stringify({ source }))
    const prepared = await cli(['space','mote','avatar','preview','--input',file])
    assert.deepEqual({ origin:prepared.source.origin,seriesId:prepared.source.seriesId,entryId:prepared.source.entryId }, source)
    assert.match(prepared.source.revision, /^sha256:[a-f0-9]{64}$/)
    const expectedEntry = catalog.series.find(item => item.origin===source.origin && item.seriesId===source.seriesId)?.entries.find(item => item.entryId===source.entryId)
    assert.ok(expectedEntry); assert.deepEqual(prepared.definition,expectedEntry.definition)
    assert.equal(prepared.payload.kind, prepared.definition.kind)
    if (prepared.payload.kind === 'image') { assert.ok(prepared.payload.image.width > 0); assert.ok(prepared.payload.image.dataUrl.startsWith('data:image/png;base64,')) }
    if (prepared.payload.kind === 'glb') { const expectedBytes=await fs.readFile(source.origin==='builtin' ? path.join(root,'apps/desktop/resources/avatar-series/geometry/RobotExpressive.glb') : path.join(mixed,'textured.glb')); assert.equal(sha(Buffer.from(prepared.payload.dataBase64,'base64')),sha(expectedBytes)) }
    await fs.writeFile(file, JSON.stringify({ source, expectedRevision: 'sha256:' + '0'.repeat(64) }))
    await cli(['space','mote','avatar','preview','--input',file], true)
  }
  const embedded = path.join(directory,'embedded.json')
  await fs.writeFile(embedded,JSON.stringify({source:{origin:'user',seriesId:'mixed',entryId:'oversized'}}))
  await cli(['space','mote','avatar','preview','--input',embedded],true)
  await fs.writeFile(embedded,JSON.stringify({source:{origin:'user',seriesId:'mixed',entryId:'regular.png'}}))
  const retained = await cli(['space','mote','avatar','preview','--input',embedded]);assert.equal(retained.payload.kind,'image');assert.equal(retained.source.entryId,'regular.png')
  const invalid = path.join(directory, 'invalid.json'); await fs.writeFile(invalid, JSON.stringify({ source:{origin:'user',seriesId:'../escape',entryId:'owl.png'} }))
  await cli(['space','mote','avatar','preview','--input',invalid], true)
  const help = run(process.execPath, [path.join(coreRoot,'bin/amux'),'space','mote','avatar','preview','--help'])
  const helpResult = await help.ended; assert.equal(helpResult.exitCode, 0); assert.match(helpResult.stdout, /expectedRevision/)
  const sessions = await cli(['agent','ls']); assert.ok(Array.isArray(sessions.sessions)); assert.equal(sessions.sessions.length, 0)
  for (const file of ['packages/core/src/mote-avatar-series.ts','packages/core/src/mote-face.ts','packages/core/src/public-rpc.ts','packages/core/src/public-rpc-service.ts','packages/core/src/public-rpc-client.ts','packages/core/src/rpc-native-codec.ts','packages/core/src/agentmux-cli-commands.ts','packages/core/src/agentmux-cli-help.ts','packages/core/src/agentmux.ts','packages/core/dist/mote-avatar-series.js','packages/core/dist/rpc-native-codec.js','apps/desktop/src/main/ipc.ts','apps/desktop/src/main/ipc-sender-trust.ts','apps/desktop/src/preload/index.ts','apps/desktop/src/shared/contracts.ts','apps/desktop/src/renderer/src/lib/api.ts']) receipt.source[file] = sha(await fs.readFile(path.join(root,file)))
  receipt.passed = !selectedMutation
  if (selectedMutation) throw Object.assign(new Error('Semantic mutation escaped the normal product consumer'),{code:'MUTATION_ESCAPED'})
} catch (error) {
  receipt.error = { code:error.code,message:error.message,stack:error.stack }
  const expectedCodes={'source-owner-disconnected':'CONTROL_FAILED','host-forward-disconnected':'CONTROL_UNAVAILABLE','result-decoder-disconnected':'CONTROL_PROTOCOL_ERROR','exact-source-ignored':'ERR_ASSERTION'}
  if (selectedMutation && stage==='consumer' && receipt.mutation && error.code===expectedCodes[selectedMutation]) { receipt.passed=true; receipt.mutationDetected=true }
}
finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  await Promise.all(children.filter(child => child.exitCode === null).map(child => new Promise(resolve => child.once('exit', resolve))))
  await fs.rm(runtimeRoot, { recursive:true,force:true })
}
receipt.logs = logs
await fs.writeFile(path.join(directory,'receipt.json'), JSON.stringify(receipt,null,2)+'\n')
console.log(path.join(directory,'receipt.json'))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
