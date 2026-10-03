import { builtinModules } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { aliases, desktopRequire, installedDependency, root } from './fixtures/settings-connections/environment.mjs'
const exec = promisify(execFile), { build } = await import(desktopRequire.resolve('vite'))
const fixture = resolve(root, 'apps/desktop/scripts/fixtures/remote-core-upgrade')
const evidence = resolve(root, process.argv[2] ?? ".local/state/remote-core-upgrade-fixture/visual")
await mkdir(evidence, { recursive: true })
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-remote-upgrade-visual-'))
const inputs = new Map()
try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'warn', define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
    resolve: { alias: [{ find: /^@agentmux\/client-ui\/note\/(.+)$/u, replacement: resolve(root, 'packages/client-ui/src/note') + '/$1.ts' }, ...aliases] }, plugins: [{ name: 'owned-dependencies', enforce: 'pre', resolveId(source, importer) {
      if (builtinModules.includes(source) || source.startsWith('node:')) return
      return installedDependency(source, importer)
    },
      transform(code, id) {
        if (id.startsWith(root + '/') && !id.includes('/node_modules/')) inputs.set(id, createHash('sha256').update(code).digest('hex'))
      } }], esbuild: { jsx: 'automatic' }, build: { outDir: join(privateRoot, 'dist'), emptyOutDir: true } })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  await exec(desktopRequire('electron'), [join(fixture, 'main.cjs'), join(privateRoot, 'dist/index.html'), privateRoot, evidence], { env, timeout: 60000, maxBuffer: 1024 * 1024 })
  const capture = JSON.parse(await readFile(join(evidence, 'capture.json'), 'utf8'))
  if (!capture.passed) throw new Error(capture.error)
  for (const image of capture.images) image.sha256 = createHash('sha256').update(await readFile(join(evidence, image.path))).digest('hex')
  capture.inputs = [...inputs].map(([path, sha256]) => ({ path, sha256 }))
  capture.captureOnly = true; capture.aestheticReview = 'not-performed'
  await writeFile(join(evidence, 'capture.json'), JSON.stringify(capture, null, 2) + '\n')
  console.log(JSON.stringify({ evidence, images: capture.images.length, boundary: capture.boundary }))
} finally { await rm(privateRoot, { recursive: true, force: true }) }
