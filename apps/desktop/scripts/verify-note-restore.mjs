import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--survey-collection', 'Select the original Note restore or --survey-collection')
const collection = args.length === 1
const fixture = join(root, `apps/desktop/scripts/fixtures/${collection ? 'survey-collection' : 'note-restore'}`)
const evidence = join(root, `.tmp/${collection ? 'survey-collection' : 'note'}-restore-${Date.now()}`), compiled = join(evidence, 'compiled')
const privateResources = await mkdtemp(join(tmpdir(), 'agentmux-note-restore-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: collection ? 'agentmux.survey-collection-restore.v1' : 'agentmux.note-restore.v1', passed: false, boundary: collection ? 'Two distinct private Node processes consume current compiled Store, original Survey/UI metadata, exact layout/selection and Document/Launcher drafts. Automatic Browser membership is derived from the restored catalog; no Native, DOM caret, Session or Run claim.' : 'Two distinct private Node processes consume current compiled Files/Store, original Document/Launcher/UI metadata and derived knowledge. No rich DOM caret, Native, Session or Run claim.' }
await mkdir(compiled, { recursive: true })
async function run(phase) {
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(fixture, 'compiled-consumer.mjs'), root, compiled, evidence, phase], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', code => yes({ code, output }))
  })
  await writeFile(join(evidence, `${phase}.log`), result.output)
  assert.equal(result.code, 0, result.output)
  const phaseReceipt = JSON.parse(await readFile(join(evidence, `${phase}.json`), 'utf8'))
  assert.equal(phaseReceipt.passed, true); return phaseReceipt
}
try {
  const workspaces = [{ id: 'resource', name: 'Resource', hostId: 'local', path: join(privateResources, 'resource'), kind: 'folder' }, { id: 'display', name: 'Display', hostId: 'local', path: join(privateResources, 'display'), kind: 'folder' }]
  for (const workspace of workspaces) await mkdir(workspace.path)
  await writeFile(join(evidence, 'private-resources.json'), JSON.stringify({ workspaces }))
  const desktopRequire = createRequire(join(root, 'apps/desktop/package.json')), require = createRequire(desktopRequire.resolve('vite/package.json'))
  const { build } = await import(pathToFileURL(require.resolve('esbuild')).href)
  const aliases = {}
  for (const pkg of ['core', 'demand']) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', pkg, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports)) aliases[key === '.' ? `@agentmux/${pkg}` : `@agentmux/${pkg}/${key.slice(2)}`] = join(root, 'packages', pkg, value.import.replace('./dist/', pkg === 'core' ? './src/' : './').replace(/\.js$/, '.ts'))
  }
  aliases['@agentmux/layout'] = join(root, 'packages/layout/src/index.ts')
  const plugin = { name: 'original-source-with-owned-dependencies', setup(builder) {
    builder.onResolve({ filter: /^@agentmux\/(core|demand|layout)(\/|$)/ }, args => aliases[args.path] ? { path: aliases[args.path] } : undefined)
    builder.onResolve({ filter: /^[^./]/ }, async args => {
      if (args.pluginData?.ownedExternal) return
      if (args.path.startsWith('node:')) return { path: args.path, external: true }
      const dependency = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { ownedExternal: true } })
      return dependency.errors.length ? { errors: dependency.errors } : { path: dependency.path, external: true }
    })
  } }
  const outfile = join(compiled, 'consumer.mjs')
  const result = await build({ absWorkingDir: root, entryPoints: [join(fixture, 'consumer.ts')], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile, metafile: true,
    plugins: [plugin], define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, logLevel: 'error' })
  const sources = Object.keys(result.metafile.inputs).filter(path => !path.startsWith('node_modules/'))
  const requiredSources = collection ? ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/launcher-state.ts', 'apps/desktop/src/renderer/src/lib/survey-workface.ts', 'apps/desktop/src/renderer/src/lib/space-agent-control.ts', 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts'] : ['apps/desktop/src/main/workspace-files.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/launcher-state.ts', 'apps/desktop/src/shared/note-document.ts', 'apps/desktop/src/renderer/src/lib/note-knowledge.ts', 'apps/desktop/src/renderer/src/lib/note-block-selection.ts']
  for (const required of requiredSources) assert.ok(sources.includes(required), `${required} must actually be compiled`)
  assert.ok(sources.length > 0)
  receipt.sourceBefore = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(resolve(root, path)))])))
  receipt.compiledSha256 = hash(await readFile(outfile)); await writeFile(join(evidence, 'metafile.json'), JSON.stringify(result.metafile))
  const seed = await run('seed'), restored = await run('restore'); assert.notEqual(seed.pid, restored.pid)
  receipt.phases = [seed, restored]; receipt.sourceAfter = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(resolve(root, path)))])))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore); receipt.passed = true
} catch (error) { receipt.error = String(error); throw error }
finally {
  await rm(compiled, { recursive: true, force: true }); await rm(privateResources, { recursive: true, force: true })
  receipt.cleanup = { compiledRemoved: true, privateResourcesRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: true, receipt: join(evidence, 'receipt.json') }))
