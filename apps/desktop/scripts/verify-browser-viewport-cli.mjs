import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'

assert.ok(process.argv.slice(2).every(arg => arg === '--mutations'))
const require = createRequire(resolve('apps/desktop/package.json'))
const { build } = browserSourceBuild(createRequire(require.resolve('vite'))('esbuild'))
const out = resolve('.tmp/browser-viewport-cli/proof')
await mkdir(out, { recursive: true })
const receipt = { passed: false, source: {}, runs: [] }
const files = ['packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/browser-viewport.ts',
  'packages/core/src/browser-page-capability.ts', 'packages/browser/src/browser-page-dispatch.ts',
  'apps/desktop/src/main/browser-view-manager.ts']
for (const file of files) receipt.source[file] = createHash('sha256').update(await readFile(file)).digest('hex')
const work = await mkdtemp(join(tmpdir(), 'amux-vp-'))
const mutants = {
  'omit-native-apply': ['browser-view-manager.ts', '    this.applyViewport(entry, entry.view, ownedViewport)', '    void ownedViewport'],
  'omit-owner-dispatch': ['browser-page-dispatch.ts', '        return context.setViewport(args[0])', '        return context.pageInfo()'],
  'omit-cli-call': ['agentmux-cli-commands.ts', 'code: `return await setViewport(${JSON.stringify(viewport)})`', 'code: `return await pageInfo()`']
}
async function dependencies(destination, source) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) { await dependencies(join(destination, entry), join(source, entry)); continue }
    try { await symlink(join(source, entry), join(destination, entry)) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
}
try {
  for (const name of ['baseline', ...(process.argv.includes('--mutations') ? Object.keys(mutants) : []), 'restored']) {
    const root = join(work, 'r' + receipt.runs.length); await mkdir(root)
    for (const pkg of ['core', 'browser']) await dependencies(join(root, 'node_modules'), resolve('packages', pkg, 'node_modules'))
    await dependencies(join(root, 'node_modules'), resolve('apps/desktop/node_modules'))
    const mutation = mutants[name]
    const plugins = mutation ? [{ name: 'exact-production-mutation', setup(bundle) {
      bundle.onLoad({ filter: new RegExp('/' + mutation[0].replaceAll('.', '\\.') + '$') }, async ({ path }) => {
        const original = await readFile(path, 'utf8')
        assert.equal(original.split(mutation[1]).length - 1, 1, 'Mutation must bind one actual production expression')
        return { contents: original.replace(mutation[1], mutation[2]), loader: 'ts', resolveDir: dirname(path) }
      })
    } }] : []
    const options = { bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
      alias: { '@agentmux/core': resolve('packages/core/src') }, plugins,
      banner: { js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);" } }
    await build({ ...options, entryPoints: ['apps/desktop/scripts/fixtures/browser-viewport-cli/main.ts'], outfile: join(root, 'main.mjs') })
    await build({ ...options, entryPoints: ['packages/core/src/agentmux.ts'], outfile: join(root, 'cli.mjs') })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|ELECTRON_RUN_AS_NODE$)/.test(key)))
    env.AGENTMUX_VIEWPORT_CLI_ROOT = root
    const result = await new Promise((resolveChild, reject) => {
      const child = spawn(require('electron'), [join(root, 'main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', expired = false, escalation
      child.stdout.on('data', bytes => { stdout += bytes; process.stdout.write(bytes) }); child.stderr.on('data', bytes => { stderr += bytes; process.stderr.write(bytes) })
      const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1500) }, 90000)
      child.once('error', reject)
      child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(escalation); resolveChild({ code, signal, expired, stdout, stderr, pid: child.pid }) })
    })
    await writeFile(join(out, name + '-process.json'), JSON.stringify(result, null, 2))
    const native = JSON.parse(await readFile(join(root, 'native-receipt.json'), 'utf8'))
    receipt.runs.push({ name, ...result, native })
    await writeFile(join(out, name + '.json'), JSON.stringify(receipt.runs.at(-1), null, 2))
    assert.equal(result.expired, false, 'A timeout is not a mutation failure')
    if (mutation) {
      assert.equal(result.code, 1)
      assert.match(native.error, /AssertionError/)
    } else assert.equal(result.code, 0, native.error ?? result.stderr)
    console.log(name + ': ' + (mutation ? 'assertion red' : 'passed'))
  }
  receipt.passed = true
} finally {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await rm(work, { recursive: true, force: true })
}
