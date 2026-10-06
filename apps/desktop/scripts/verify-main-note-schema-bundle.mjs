import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
assert.ok(args.every(arg => arg === '--mutations'), 'Unsupported Main schema proof option')
const repository = process.cwd(), desktop = resolve('apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
const { resolveConfig } = await import(pathToFileURL(require.resolve('electron-vite')).href)
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const out = resolve('.local/browser-main-schema-bundle/proof')
await mkdir(out, { recursive: true }); await rm(join(out, 'receipt.json'), { force: true })
const configWork = await mkdtemp(join(out, 'config-'))
const isolated = await mkdtemp(join(tmpdir(), 'agentmux-main-schema-'))
const configPath = join(desktop, 'electron.vite.config.ts'), configSource = await readFile(configPath, 'utf8')
const roots = ['@tiptap/core', '@tiptap/extension-unique-id', '@tiptap/starter-kit']
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = [
  'apps/desktop/electron.vite.config.ts', 'apps/desktop/package.json',
  'apps/desktop/src/main/note-file-writer.ts', 'apps/desktop/src/shared/note-document.ts', 'apps/desktop/src/shared/note-content-schema.ts',
  'packages/client-ui/src/note/note-content-schema.ts', 'packages/client-ui/src/note/note-document.ts',
  'packages/client-ui/src/note/note-provenance.ts', 'packages/client-ui/src/note/note-format.ts',
  'apps/desktop/scripts/verify-main-note-schema-bundle.mjs'
]
const evidence = { sourceInputs: Object.fromEntries(await Promise.all(inputs.map(async path => [path, sha(await readFile(resolve(repository, path)))]))),
  boundary: 'Production electron-vite Main configuration and original NoteFileWriter/shared schema, isolated single-file Node load; no user Main, Renderer or Runtime started', cases: [], passed: false }
const entry = join(configWork, 'consumer.ts')
await writeFile(entry, `import assert from 'node:assert/strict';
import {newNoteDocument,readNoteDocument} from ${JSON.stringify(join(desktop, 'src/shared/note-document.ts'))};
import {NoteFileWriter} from ${JSON.stringify(join(desktop, 'src/main/note-file-writer.ts'))};
const note=newNoteDocument('Original schema content','original-note','original-block');
const raw=JSON.stringify(note);const valid=readNoteDocument(raw);assert.equal(valid.status,'valid');
assert.equal(valid.note.noteId,'original-note');assert.equal(valid.note.content.content[0].attrs.blockId,'original-block');
const unsupported=structuredClone(note);unsupported.content.content[0].type='unsupported-note-node';
const invalid=readNoteDocument(JSON.stringify(unsupported));assert.equal(invalid.status,'invalid');assert.match(invalid.message,/unsupported node/);
const duplicate=structuredClone(note);duplicate.content.content.push(structuredClone(duplicate.content.content[0]));
assert.equal(readNoteDocument(JSON.stringify(duplicate)).status,'invalid');
let saved;const writer=new NoteFileWriter({read(){throw Error('A create does not read another baseline')},async write(workspace,input){saved=input.content;return{status:'written',revision:'proof-revision',content:input.content}}});
const result=await writer.write({id:'original-workspace',hostId:'local',name:'Original',kind:'folder',path:process.cwd()},
{path:'original.note.json',content:raw,expectedRevision:null},{actor:{kind:'user',id:'original-person'}});
assert.equal(result.status,'written');assert.equal(result.noteAttribution.status,'recorded');
const consumed=readNoteDocument(saved);assert.equal(consumed.status,'valid');
assert.equal(consumed.note.content.content[0].attrs.provenance.lastEdited.actor.id,'original-person');
console.log(JSON.stringify({passed:true,cases:['original-valid-schema','unsupported-node-rejected','duplicate-block-rejected','actual-file-writer-normalization'],noteId:consumed.note.noteId}));
`)

function revokedConfig() {
  const anchor = /externalizeDepsPlugin\(\{ exclude: \[([\s\S]*?)\] \}\)/g
  const matches = [...configSource.matchAll(anchor)]
  assert.equal(matches.length, 1, 'The original Main dependency choice is unique and nonempty')
  let changed = matches[0][0]
  for (const name of roots) {
    const literal = `'${name}'`
    assert.equal(changed.split(literal).length - 1, 1, 'The actual schema dependency is excluded exactly once: ' + name)
    changed = changed.replace(', ' + literal, '')
  }
  assert.ok(roots.every(name => !changed.includes(`'${name}'`)), 'The mutation revokes exactly the three Main exclusions')
  return configSource.replace(matches[0][0], changed)
}
async function runNode(file, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_PATH' && key !== 'NODE_OPTIONS' && !/^(?:AGENTMUX_|CTXMUX_)/.test(key)))
  return await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `try{await import(${JSON.stringify(pathToFileURL(file).href)})}catch(error){console.error(JSON.stringify({code:error.code,message:error.message}));process.exitCode=1}`], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', expired = false, escalation
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1000) }, 10000)
    child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(escalation)
      expired ? reject(new Error('The exact isolated schema child timed out and exited')) : done({ code, signal, pid: child.pid, stdout, stderr })
    })
  })
}
async function run(label, revoked = false) {
  let file = configPath
  if (revoked) {
    // Preserve the real config's module-relative imports/aliases in a private copy.
    const source = revokedConfig().replace(/from (['"])(\.[^'"]+)\1/g, (_match, _quote, path) => 'from ' + JSON.stringify(resolve(desktop, path)))
      .replaceAll('import.meta.dirname', JSON.stringify(desktop))
    file = join(configWork, 'electron.revoked.config.ts'); await writeFile(file, source)
  }
  const loaded = await resolveConfig({ configFile: file, root: desktop, logLevel: 'silent' }, 'build', 'production')
  const main = loaded.config.main
  assert.ok(main.plugins.some(plugin => plugin?.name === 'vite:externalize-deps'), 'The actual production dependency plugin is consumed')
  const output = join(isolated, label)
  main.build = { ...main.build, outDir: output, emptyOutDir: true, sourcemap: false,
    rollupOptions: { ...main.build.rollupOptions, input: entry, output: { format: 'es', entryFileNames: 'schema.mjs', inlineDynamicImports: true } } }
  main.configFile = false; main.logLevel = 'silent'
  const bundle = await build(main)
  const chunks = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(value => value.output ?? [])
  const single = chunks.filter(chunk => chunk.type === 'chunk')
  assert.equal(single.length, 1, 'The real schema consumer is a single isolated Main bundle')
  assert.deepEqual(await readdir(output), ['schema.mjs'])
  for (let parent = output; ; parent = dirname(parent)) {
    assert.equal(await stat(join(parent, 'node_modules')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }), false, 'Isolated loader has no ancestor node_modules')
    if (parent === dirname(parent)) break
  }
  const code = await readFile(join(output, 'schema.mjs'), 'utf8'), processResult = await runNode(join(output, 'schema.mjs'), output)
  const row = { label, result: revoked ? 'RED' : 'GREEN', bundledModules: Object.keys(single[0].modules), externalImports: single[0].imports,
    bundleSha256: sha(code), bundleBytes: Buffer.byteLength(code), process: processResult }
  await writeFile(join(out, label + '.json'), JSON.stringify(row, null, 2))
  if (revoked) {
    assert.equal(processResult.code, 1, processResult.stderr)
    const failure = JSON.parse(processResult.stderr.trim())
    assert.equal(failure.code, 'ERR_MODULE_NOT_FOUND'); assert.match(failure.message, /@tiptap\/(core|extension-unique-id|starter-kit)/)
    assert.ok(single[0].imports.some(name => roots.includes(name)), 'The revoked Main choice leaves actual schema imports external')
  } else {
    assert.equal(processResult.code, 0, processResult.stderr)
    const result = JSON.parse(processResult.stdout.trim())
    assert.equal(result.passed, true); assert.deepEqual(result.cases, ['original-valid-schema', 'unsupported-node-rejected', 'duplicate-block-rejected', 'actual-file-writer-normalization'])
    assert.ok(single[0].imports.every(name => name.startsWith('node:')), 'The original schema dependency closure has no workspace package import')
    assert.ok(row.bundledModules.some(path => path.includes('@tiptap') && path.includes('pm')), 'The actual required peer closure is bundled')
  }
  evidence.cases.push({ label, result: row.result, receipt: label + '.json' }); console.log(label + ': ' + (revoked ? 'expected RED' : 'GREEN'))
}
try {
  process.chdir(desktop)
  await run('source')
  if (args.includes('--mutations')) { await run('schema-dependencies-external', true); await run('restored-source') }
  for (const [path, hash] of Object.entries(evidence.sourceInputs)) assert.equal(sha(await readFile(resolve(repository, path))), hash, 'Source changed during the bounded schema proof: ' + path)
  evidence.passed = true; await writeFile(join(out, 'receipt.json'), JSON.stringify(evidence, null, 2))
} finally { process.chdir(repository); await rm(configWork, { recursive: true, force: true }); await rm(isolated, { recursive: true, force: true }) }
