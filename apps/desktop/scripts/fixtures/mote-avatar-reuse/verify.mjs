import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const directory = dirname(fileURLToPath(import.meta.url)), root = resolve(directory, '../../../../..')
const owner = createRequire(resolve(root, 'apps/desktop/package.json')), { build } = createRequire(owner.resolve('vite'))('esbuild')
const engine = owner('electron'), source = resolve(root, 'apps/desktop/src/main/mote-avatar-raster.ts'), original = await readFile(source, 'utf8')
const evidence = resolve(root, '.local/connector-onboarding/avatar-reuse/native-export-probe/leaf-consumer-serial')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const front = () => process.platform === 'darwin' ? execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim() : null
await mkdir(evidence, { recursive: true })
const variants = [['source', original, true]]
if (process.argv.includes('--mutations')) variants.push(
  ['missing-draw', original.replace('context.drawImage(image, 0, 0, canvas.width, canvas.height);', '/* exact pixel-producing draw removed */'), false],
  ['missing-close', original.replace('if (!contents.isDestroyed()) {', 'if (false && !contents.isDestroyed()) {'), false]
)
if (process.argv.includes('--serialization-mutation')) variants.push(['missing-serialization', original.replace('tail.then(() => rasterize(svg))', 'rasterize(svg)'), false])
if (variants.length > 1) variants.push(['restored', original, true])
const results = []
for (const [name, contents, expected] of variants) {
  if (!expected) assert.notEqual(contents, original, 'The precise mutant must change its original owner.')
  const output = resolve(evidence, name), compiled = resolve(output, 'mote-avatar-raster.cjs'), vector = resolve(output, 'mote-avatar-svg.cjs')
  await mkdir(output, { recursive: true })
  const bundle = await build({ entryPoints: [source], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], metafile: true, jsx: 'automatic',
    plugins: [{ name: 'exact-avatar-raster-input', setup(builder) { builder.onLoad({ filter: /mote-avatar-raster\.ts$/ }, args => args.path === source ? { contents, loader: 'ts', resolveDir: dirname(source) } : undefined) } }] })
  const vectorBundle = await build({ entryPoints: [resolve(root, 'packages/client-ui/src/lib/mote-avatar-svg.ts')], outfile: vector, bundle: true, platform: 'node', format: 'cjs', target: 'node24', jsx: 'automatic', metafile: true })
  const before = front(), env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (key.startsWith('AGENTMUX_')) delete env[key]
  const child = spawn(engine, [resolve(directory, 'main.cjs'), compiled, output, vector], { env, stdio: ['ignore', 'pipe', 'pipe'] }), stdout = [], stderr = []
  child.stdout.on('data', value => stdout.push(value)); child.stderr.on('data', value => stderr.push(value))
  const stop = setTimeout(() => child.kill('SIGTERM'), 20_000)
  const exited = await new Promise(done => child.once('exit', (code, signal) => done({ code, signal })))
  clearTimeout(stop)
  const after = front()
  await writeFile(resolve(output, 'stdout.log'), Buffer.concat(stdout)); await writeFile(resolve(output, 'stderr.log'), Buffer.concat(stderr))
  const result = JSON.parse(await readFile(resolve(output, 'result.json'), 'utf8'))
  const receipt = { name, expected, actual: result.passed, pid: child.pid, exit: exited, foreground: { before, after, unchanged: before === after }, sourceSha256: sha(contents), compiledSha256: sha(await readFile(compiled)), actualInputs: Object.keys(bundle.metafile.inputs), vectorInputs: Object.fromEntries(await Promise.all(Object.keys(vectorBundle.metafile.inputs).map(async path => [path, sha(await readFile(resolve(root, path)))]))), vectorCompiledSha256: sha(await readFile(vector)), result }
  await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  results.push(receipt)
  assert.deepEqual(exited, { code: 0, signal: null })
  assert.equal(result.passed, expected, name + ': ' + result.error?.message)
  if (!expected) assert.equal(result.error?.name, 'AssertionError', 'A loaded mutant must fail a business assertion.')
  console.log(JSON.stringify({ name, passed: result.passed, cases: result.cases, failure: result.error?.message, foregroundUnchanged: before === after }))
}
const proof = { source: relative(root, source), sourceSha256: sha(original), consumerSha256: sha(await readFile(resolve(directory, 'main.cjs'))), engine: { version: owner('electron/package.json').version, executableSha256: sha(await readFile(engine)) }, results }
await writeFile(resolve(evidence, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
assert.equal(await readFile(source, 'utf8'), original, 'The real source must remain unchanged by mutation tests.')
