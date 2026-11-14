import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const require = createRequire(resolve('apps/desktop/package.json')), { build } = createRequire(require.resolve('vite'))('esbuild')
const mode = process.argv.includes('--modes') ? 'modes' : process.argv.includes('--text') ? 'text' : process.argv.includes('--availability') ? 'availability' : null
assert.ok(mode, 'Choose --modes, --text or --availability')
await mkdir('.local/capture-tools-proof', { recursive: true }); const out = await mkdtemp(resolve('.local/capture-tools-proof/run-')), work = await mkdtemp(join(tmpdir(), 'capture-tools-'))
const receipt = { passed: false, mode, variants: [], inputs: {}, cleanup: false }; const inputs = new Map(), hash = bytes => createHash('sha256').update(bytes).digest('hex')
try {
 const app = join(work, 'app'), main = join(app, 'out/main'), preload = join(app, 'out/preload'), renderer = join(app, 'out/renderer/screenshot-editor')
 for (const p of [main, preload, renderer, join(app, 'node_modules/@agentmux')]) await mkdir(p, { recursive: true })
 for (const name of ['core', 'native-desktop']) await symlink(resolve('packages', name), join(app, 'node_modules/@agentmux', name))
 await writeFile(join(app, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
 const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@agentmux/client-ui/theme': resolve('packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': resolve('packages/native-desktop/src/image.ts') }
 async function bundle(options) { const r = await build({ bundle: true, logLevel: 'silent', metafile: true, alias, ...options }); for (const input of Object.keys(r.metafile.inputs)) if (!input.startsWith('<')) { const digest = hash(await readFile(input)); if (inputs.has(input)) assert.equal(inputs.get(input), digest, 'source changed during build'); else inputs.set(input, digest) } }
 for (const name of ['capture-surface', 'screenshot-editor']) await bundle({ entryPoints: [`apps/desktop/src/preload/${name}.ts`], outfile: join(preload, name + '.cjs'), platform: 'node', format: 'cjs', external: ['electron'] })
 const evidenceInputs = ['apps/desktop/scripts/verify-capture-tools.mjs', 'packages/core/src/public-rpc-native-desktop.ts', 'packages/core/src/native-desktop-cli.ts', 'packages/core/src/image-text.ts', 'packages/core/dist/image-text.js', 'packages/core/dist/public-rpc-native-desktop.js', 'packages/core/dist/native-desktop-cli.js', 'packages/native-desktop/src/client.ts', 'packages/native-desktop/dist/client.js', 'packages/native-desktop/macos/Sources/AgentMuxNativeMacOS/TextRecognition.swift', 'packages/native-desktop/macos/Sources/AgentMuxNativeMacOS/NativeDesktopOperations.swift', 'packages/native-desktop/macos/Sources/AgentMuxNativeMacOS/main.swift', '.local/state/capture-tools/native/agentmux-native-macos', 'apps/desktop/src/renderer/screenshot-editor/index.html']
 for (const file of evidenceInputs) inputs.set(file, hash(await readFile(file)))
 const html = await readFile('apps/desktop/src/renderer/screenshot-editor/index.html', 'utf8'); await writeFile(join(renderer, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="entry.css" /></head>'))
 for (const mutant of [false, true]) {
  const scene = join(out, mutant ? 'mutant' : 'baseline'); await mkdir(scene); let mutated = false
  const plugin = { name: 'actual-production-mutation', setup(builder) { builder.onLoad({ filter: /(?:capture-surface\.ts|ImageAnnotationEditor\.tsx|ImageTextTools\.tsx)$/ }, async args => {
   const source = await readFile(args.path, 'utf8'); let contents = source
   if (mutant && mode === 'modes' && args.path.endsWith('/main/capture-surface.ts')) contents = source.replace("mode: params.mode as 'scroll' | 'gif'", "mode: 'scroll'")
   if (mutant && mode === 'text' && args.path.endsWith('ImageAnnotationEditor.tsx')) contents = source.replace("kind: 'cover' as const, color: '#000000'", "kind: 'rect' as const, width: 1, color: '#000000'")
   if (mutant && mode === 'availability' && args.path.endsWith('ImageTextTools.tsx')) contents = source.replace('disabled={!!reason}', 'disabled={false}')
   if (source !== contents) mutated = true
   return { contents, loader: args.path.endsWith('tsx') ? 'tsx' : 'ts', resolveDir: dirname(args.path) }
  }) } }
  await bundle({ entryPoints: ['apps/desktop/scripts/fixtures/capture-tools/main.ts'], outfile: join(main, 'main.js'), platform: 'node', format: 'esm', external: ['electron', '@agentmux/core', '@agentmux/core/*', '@agentmux/native-desktop'], plugins: [plugin], banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" } })
  await bundle({ entryPoints: ['apps/desktop/scripts/fixtures/capture-tools/entry.tsx'], outfile: join(renderer, 'entry.js'), platform: 'browser', format: 'esm', jsx: 'automatic', conditions: ['browser'], plugins: [plugin, { name: 'isolated-core', setup(builder) { const exports = JSON.parse(require('node:fs').readFileSync('packages/core/package.json')).exports; builder.onResolve({ filter: /^@agentmux\/core(?:\/|$)/ }, args => { const key = args.path === '@agentmux/core' ? '.' : '.' + args.path.slice('@agentmux/core'.length); const spec = exports[key]; if (!spec?.import) throw Error('Missing real Core export: ' + key); return { path: resolve('packages/core', spec.import) } }) } }] })
  assert.ok(!mutant || mutated, 'actual production mutation must be consumed')
  const env = { ...process.env, CAPTURE_TOOLS_MODE: mode, CAPTURE_TOOLS_OUT: scene, CAPTURE_CORE_DIST: resolve('packages/core/dist'), CAPTURE_TOOLS_HELPER: resolve('.local/state/capture-tools/native/agentmux-native-macos'), ELECTRON_RENDERER_URL: '' }; delete env.ELECTRON_RUN_AS_NODE
  const execution = await new Promise((resolve, reject) => { const child = spawn(require('electron'), [app], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '', timedOut = false; child.stdout.on('data', b => { log += b }); child.stderr.on('data', b => { log += b }); const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 45000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve({ code, timedOut, log }) }) })
  await writeFile(join(scene, 'electron.log'), execution.log); assert.equal(execution.timedOut, false, 'timeout is not a mutation proof')
  const result = JSON.parse(await readFile(join(scene, 'result.json'), 'utf8')); receipt.variants.push({ mutant, code: execution.code, result })
  if (!mutant) { assert.equal(execution.code, 0, JSON.stringify(result.failure)); assert.equal(result.passed, true) } else { assert.notEqual(execution.code, 0); assert.equal(result.failure.name, 'AssertionError') }
  console.log(mode, mutant ? 'AssertionRED' : 'GREEN')
 }
 for (const [path, digest] of inputs) assert.equal(hash(await readFile(path)), digest, 'source changed during verification')
 receipt.inputs = Object.fromEntries(inputs); receipt.passed = true
} finally { await rm(work, { recursive: true, force: true }); receipt.cleanup = true; await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }))
