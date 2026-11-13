// Capture the root READMEs in the real Workbench File Preview (dark, light, reading layout, narrow).
// Builds the fixture renderer from source with Vite, runs one private Electron process against a
// private copy of the README files and their assets, and writes frames plus a receipt for the
// independent image review. It never opens an installed App or a user Session/Run.
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, relative } from 'node:path'
import { fixturePath } from './lib/fixture-values.mjs'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const require = createRequire(import.meta.url), { build } = await import('vite')
const esbuild = createRequire(require.resolve('vite'))('esbuild')
const desktop = resolve(import.meta.dirname, '..'), root = resolve(desktop, '../..')
const fixture = join(desktop, 'scripts/fixtures/markdown-readme')
const evidence = join(root, '.tmp/markdown-readme-visual')
const temporary = await mkdtemp(fixturePath('tmp/amx-readme-')), workspace = join(temporary, 'workspace'), profile = join(temporary, 'profile'), outDir = join(temporary, 'out')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', boundary: 'Real compiled Workbench File Preview over private copies of the root READMEs and their assets, production preload and WorkspaceFiles. Remote README badges load over the network like the product renderer. No installed App or healthy Run.', sourceHashes: {}, frames: [] }
await rm(evidence, { recursive: true, force: true }); await mkdir(evidence, { recursive: true })
try {
  await mkdir(workspace, { recursive: true }); await mkdir(profile)
  for (const file of ['README.md', 'README.zh-CN.md']) await copyFile(join(root, file), join(workspace, file))
  // README constructs the root files do not use yet: other alert types, details, inline marks, a failing badge.
  await copyFile(join(fixture, 'elements.md'), join(workspace, 'elements.md'))
  await cp(join(root, 'docs/assets/readme'), join(workspace, 'docs/assets/readme'), { recursive: true })
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    plugins: [{ name: 'candidate-source-binding', enforce: 'pre', async generateBundle() {
      for (const file of this.getWatchFiles()) if (file.startsWith(root + '/') && !file.includes('/node_modules/') && /\.(?:tsx?|css|html)$/.test(file)) receipt.sourceHashes[relative(root, file)] = sha(await readFile(file))
    } }],
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, build: { outDir, emptyOutDir: true } })
  // WorkspaceFiles finds its directory helper at ../../resources/bin from its own module, as in the packaged App.
  await mkdir(join(temporary, 'main/native'), { recursive: true }); await mkdir(join(temporary, 'resources'))
  await symlink(join(desktop, 'resources/bin'), join(temporary, 'resources/bin'), 'dir')
  const nativeModule = join(temporary, 'main/native/workspace-files.mjs')
  // Bundled CommonJS code (yaml) and Core's native lock helper call require; resolve them from Core like its own dist does.
  await esbuild.build({ entryPoints: [join(fixture, 'native-file-owner.ts')], outfile: nativeModule, bundle: true, platform: 'node', format: 'esm', external: ['@agentmux/core/spatial-state', 'fs-native-extensions'],
    banner: { js: `import { createRequire as __fixtureRequire } from 'node:module'; const require = __fixtureRequire(${JSON.stringify(join(root, 'packages/core/package.json'))});` }, logLevel: 'error' })
  // The native bundle sits in the temporary root: give it the Desktop dependencies plus Core's native lock helper.
  await mkdir(join(temporary, 'node_modules'))
  for (const entry of await readdir(join(desktop, 'node_modules'))) await symlink(join(desktop, 'node_modules', entry), join(temporary, 'node_modules', entry))
  await symlink(join(root, 'packages/core/node_modules/fs-native-extensions'), join(temporary, 'node_modules/fs-native-extensions'), 'dir')
  // A sandboxed preload can only require electron. Rollup tree-shakes unused dependency code (CommonJS yaml
  // would require Node builtins) while every product preload module keeps its side effects.
  await build({ configFile: false, root: desktop, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: join(temporary, 'preload-out'), emptyOutDir: true, ssr: join(fixture, 'preload.ts'), target: 'node22', minify: false,
      rollupOptions: { external: ['electron', /^node:/], output: { format: 'cjs', entryFileNames: 'preload.cjs' }, treeshake: { moduleSideEffects: id => !id.includes('/node_modules/') } } },
    ssr: { noExternal: true, target: 'node' } })
  await copyFile(join(temporary, 'preload-out/preload.cjs'), join(temporary, 'preload.cjs'))
  await copyFile(join(fixture, 'main.cjs'), join(temporary, 'main.cjs'))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const lines = [], outcome = await runProbeProcess(require('electron'), [join(temporary, 'main.cjs'), join(outDir, 'index.html'), profile, evidence, nativeModule, workspace],
    { temporaryRoot: temporary, cwd: root, env, timeoutMs: 240000, onLine: line => lines.push(line) })
  await writeFile(join(evidence, 'process.log'), lines.join('\n'))
  const render = JSON.parse(await readFile(join(evidence, 'render.json'), 'utf8'))
  receipt.render = { facts: render.facts, failure: render.failure ?? null, exitCode: outcome.exitCode }
  for (const frame of render.frames) receipt.frames.push({ ...frame, sha256: sha(await readFile(join(evidence, frame.file))) })
  if (outcome.exitCode !== 0 || !render.passed) throw new Error(render.failure?.message ?? `Capture process exited ${outcome.exitCode}`)
  const review = ['# README File Preview capture', '', 'Capture only; aesthetic review not performed. Open every full frame:', '',
    ...receipt.frames.map(frame => `- ${frame.name}: ${frame.file}`), ''].join('\n')
  await writeFile(join(evidence, 'review.md'), review)
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
  for (const pid of await listProbeProcesses(-1, temporary)) await signalOwnedProbeProcess(pid, temporary, 'SIGKILL')
  await rm(temporary, { recursive: true, force: true })
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(root, evidence), frames: receipt.frames.length, failure: receipt.failure?.message ?? null }))
  process.exitCode = receipt.passed ? 0 : 1
}
