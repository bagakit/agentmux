import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'vite'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const require = createRequire(join(desktop, 'package.json'))
assert.equal(process.argv.length, 2, 'Use node apps/desktop/scripts/verify-mote-render-cost.mjs')
const fixture = join(desktop, 'scripts/fixtures/mote-render-cost')
const evidence = process.env.AGENTMUX_MOTE_COST_EVIDENCE ?? join(repository, '.local/state/mote-render-cost', globalThis.crypto.randomUUID())
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-mote-cost-'))
await mkdir(evidence, { recursive: true })
const inputs = new Map(), styles = new Map(), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const aliases = []
for (const name of ['core', 'demand', 'layout', 'identity']) {
  const manifest = JSON.parse(await readFile(join(repository, 'packages', name, 'package.json')))
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const specifier = '@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))
    aliases.push({ find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: join(repository, 'packages', name, target.import.replace('./dist/', ['core', 'identity'].includes(name) ? './src/' : './').replace(/\.js$/, '.ts')) })
  }
}
const renderer = join(evidence, 'renderer')
await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: aliases },
  worker: { format: 'es' },
  css: { postcss: { plugins: [{ postcssPlugin: 'bind-mote-render-styles', async Once(root) {
    const consumed = new Map()
    const remember = node => { const input = node.source?.input; if (input?.file?.startsWith(repository + '/') && !input.file.includes('/node_modules/')) consumed.set(input.file, input.css) }
    remember(root); root.walk(remember)
    for (const [file, css] of consumed) { assert.equal(hash(await readFile(file)), hash(css), 'Consumed original CSS agrees with source'); styles.set(relative(repository, file), hash(css)); inputs.set(relative(repository, file), hash(css)) }
  } }] } },
  esbuild: { jsx: 'automatic' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'bind-native-mote-cost-inputs', async load(id) {
    const file = id.split('?')[0]
    if (file.startsWith(repository + '/') && !file.includes('/node_modules/') && !id.includes('?')) inputs.set(relative(repository, file), hash(await readFile(file)))
    return null
  } }], build: { target: 'esnext', outDir: renderer, emptyOutDir: true, minify: false } })
for (const file of ['apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx', 'apps/desktop/src/renderer/src/components/MoteIdentityMotion.tsx', 'packages/client-ui/src/components/MoteFace.tsx', 'packages/client-ui/src/lib/mote-face-motion.ts', 'packages/client-ui/src/styles/mote-identity.css']) {
  assert.ok(inputs.has(file), 'Production consumer is present: ' + file)
}
assert.ok(styles.has('packages/client-ui/src/styles/mote-identity.css'), 'Actual CSS graph consumes the boundary owner')
assert.ok([...inputs.keys()].some(file => file.includes('mote-render-cost/entry.tsx')))
for (const file of ['apps/desktop/scripts/verify-mote-render-cost.mjs', 'apps/desktop/scripts/fixtures/mote-render-cost/main.cjs']) inputs.set(file, hash(await readFile(join(repository, file))))
await writeFile(join(evidence, 'inputs.json'), JSON.stringify({ inputs: Object.fromEntries(inputs), styles: Object.fromEntries(styles), electron: require('electron/package.json').version }, null, 2))
const binary = process.env.AGENTMUX_ELECTRON_BINARY ?? require('electron')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(binary, [join(fixture, 'main.cjs'), join(renderer, 'index.html'), privateRoot, evidence], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] })
const timeout = setTimeout(() => child.kill('SIGTERM'), 90000)
let output = ''
child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
clearTimeout(timeout)
await writeFile(join(evidence, 'native.log'), output)
const receipt = JSON.parse(await readFile(join(evidence, 'receipt.json')))
assert.equal(receipt.versions.electron, require('electron/package.json').version, 'Actual Native binary matches the declared Electron version')
for (const [file, digest] of inputs) assert.equal(hash(await readFile(join(repository, file))), digest, 'Candidate inputs remain unchanged throughout proof')
await rm(privateRoot, { recursive: true, force: true })
console.log(JSON.stringify({ passed: exit === 0, evidence, exit, output: output.slice(-1800) }))
if (exit !== 0) process.exitCode = 1
