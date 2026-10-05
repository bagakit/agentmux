import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
const require = createRequire(import.meta.url), { build } = await import('vite')
const root = resolve(import.meta.dirname, '../../..'), fixture = join(root, 'packages/client-ui/test/fixtures/markdown-worker')
const library = process.argv.includes('--library-dist')
const evidence = join(root, `.bagakit/editor-format-implementation/evidence/markdown-worker-${library ? 'library-' : ''}chromium.json`)
const temporary = await mkdtemp(_hygiene_fixturePath("tmp/amx-markdown-chromium-")), sources = {}, sha = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { passed: false, boundary: 'Actual MarkdownMath/MarkdownCodeBlock and production Worker assets compiled by Vite in private ordinary Chromium; timer-gap/DOM/safety/termination probe. No installed App or FileRegion claim.', sources }
try {
  for (const name of ['verify-markdown-worker-performance.mjs', 'probe-process.mjs']) sources['apps/desktop/scripts/' + name] = sha(await readFile(join(root, 'apps/desktop/scripts', name)))
  const out = join(temporary, 'out')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, esbuild: { jsx: 'automatic' },
    resolve: { alias: library ? ['MarkdownMath', 'MarkdownCodeBlock'].map(component => ({ find: `../../../src/components/${component}.js`, replacement: join(root,`packages/client-ui/dist/components/${component}.js`) })) : [] },
    plugins: [{ name: 'source-binding', async generateBundle() { for (const file of this.getWatchFiles()) if (file.startsWith(root+'/') && !file.includes('/node_modules/')) sources[relative(root,file)] = sha(await readFile(file)) } }],
    build: { outDir: out, emptyOutDir: true } })
  const main = join(temporary, 'main.cjs'), output = join(temporary, 'result.json')
  await copyFile(join(fixture, 'main.cjs'), main); sources[relative(root,join(fixture,'main.cjs'))] = sha(await readFile(main))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  report.outcome = await runProbeProcess(require('electron'), [main, join(out,'index.html'), join(temporary,'profile'), output], { temporaryRoot: temporary, cwd: root, env, timeoutMs: 90_000 })
  assert.equal(report.outcome.timedOut, false); assert.equal(report.outcome.interruption, null)
  report.native = JSON.parse(await readFile(output,'utf8'))
  assert.equal(report.outcome.exitCode,0,report.native.failure?.message); assert.equal(report.native.passed,true)
  for (const [file, digest] of Object.entries(sources)) assert.equal(sha(await readFile(join(root,file))),digest,'Stable candidate '+file)
  report.passed = true
} catch (error) { report.failure = { message: error.message, stack: error.stack } }
finally {
  for (const pid of await listProbeProcesses(-1,temporary)) await signalOwnedProbeProcess(pid,temporary,'SIGKILL')
  report.cleanup = { remaining: await listProbeProcesses(-1,temporary) }
  await rm(temporary,{recursive:true,force:true}); await mkdir(resolve(evidence,'..'),{recursive:true}); await import('node:fs/promises').then(fs=>fs.writeFile(evidence,JSON.stringify(report,null,2)))
  console.log(JSON.stringify({passed:report.passed,evidence,failure:report.failure??null})); process.exitCode = report.passed ? 0 : 1
}
