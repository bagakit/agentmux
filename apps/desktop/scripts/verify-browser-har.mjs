import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import { standaloneScenario } from './fixtures/browser-standalone/scenario.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(repo, 'apps/desktop/package.json'))
const { build } = browserSourceBuild(createRequire(require.resolve('vite'))('esbuild'))
const source = 'packages/browser/src/browser-har-capture.ts'
const original = await readFile(join(repo, source), 'utf8')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(join(repo, '.local'), { recursive: true })
const evidence = await mkdtemp(join(repo, '.local/browser-har-'))
await symlink(join(repo, 'packages/browser/node_modules'), join(evidence, 'node_modules'), 'dir')
const receipt = { source: hash(original), runs: [], passed: false }
const persist = () => writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
const variants = process.argv.includes('--mutations') ? ['actual', 'omit-native-redirect', 'restored'] : ['actual']

try {
  for (const name of variants) {
    const work = await mkdtemp(join(tmpdir(), 'amux-har-'))
    const row = { name, cases: [] }
    const bundle = join(evidence, `${name}.mjs`)
    const output = join(work, 'traffic.har')
    receipt.runs.push(row)
    const mutation = name === 'omit-native-redirect' ? [{ name, setup(builder) {
      builder.onLoad({ filter: /browser-har-capture\.ts$/ }, args => {
        assert.equal(args.path, join(repo, source))
        const branch = 'if (previous && redirectResponse) {'
        assert.equal(original.split(branch).length, 2)
        return { contents: original.replace(branch, 'if (previous && redirectResponse && false) {'), loader: 'ts', resolveDir: dirname(args.path) }
      })
    } }] : []
    try {
      const built = await build({ absWorkingDir: repo, bundle: true, platform: 'node', format: 'esm', packages: 'external',
        metafile: true, logLevel: 'silent', plugins: mutation, entryPoints: ['packages/browser/src/bin.ts'], outfile: bundle })
      assert.ok(Object.hasOwn(built.metafile.inputs, source), 'Original native host must consume the HAR owner')
      assert.ok(Object.hasOwn(built.metafile.inputs, 'packages/browser/src/browser-page-dispatch.ts'), 'Original CLI must reach the real page dispatcher')
      row.bundle = hash(await readFile(bundle))
      await standaloneScenario({ repo, bundle, work, receipt: row, persist,
        executablePath: process.env.AGENTMUX_BROWSER_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        exercise: async ({ one, cli, base, observe, posts }) => {
          assert.ok(one.capabilities.includes('startHarCapture'), 'Live Browser discovers the new capture capability')
          assert.ok(one.capabilities.includes('finishHarCapture'), 'Live Browser discovers the original capture export')
          await observe('CLI exports original POST plus cross-navigation redirects', async () => {
            const request = `fetch('/submit?ticket=secret-query',{method:'POST',headers:{'X-Private':'secret-header'},body:'secret-payload'}).then(r=>r.text())`
            const result = await cli(['browser', 'run', '--browser', one.id, '--operation-id', 'har-native-capture', '--output', output], `
              await startHarCapture();
              await js(${JSON.stringify(request)});
              await gotoUrl(${JSON.stringify(base + '/network-wait/start')});
              await waitForLoad();
              await finishHarCapture();
              await js("fetch('/submit?after=stop',{method:'POST'}).then(r=>r.text())");
              return await finishHarCapture();`)
            assert.equal(result.outcome.kind, 'completed', result.outcome.message)
            const bytes = await readFile(output, 'utf8')
            const { log } = JSON.parse(bytes)
            assert.equal(log.version, '1.2')
            assert.equal(log._capture.scope, 'page-target-http')
            assert.equal(log._capture.content, 'metadata-only')
            assert.equal(log._capture.gap, null)
            const requests = log.entries.filter(entry => new URL(entry.request.url).pathname.startsWith('/network-wait/'))
            assert.deepEqual(requests.map(entry => entry.response.status), [302, 302, 200], 'HAR must preserve original native redirect statuses')
            assert.deepEqual(requests.map(entry => new URL(entry.request.url).pathname), ['/network-wait/start', '/network-wait/redirect', '/network-wait/final'])
            assert.ok(requests[0].response.redirectURL.endsWith('/network-wait/redirect'))
            assert.equal(log.entries.filter(entry => entry.request.method === 'POST').length, 1, 'The original stop must exclude later actions')
            assert.equal(posts(), 2, 'Native requests occurred once before and once after the original stop')
            for (const marker of ['secret-query', 'secret-header', 'secret-payload']) assert.ok(!bytes.includes(marker))
            assert.equal(result.result.entryCount, log.entries.length)
            row.exported = { sha256: hash(bytes), previousPosts: 1, finalPosts: posts(), retainedEntries: log.entries.length }
          })
          await observe('Browser without a Workspace returns a bounded native HAR', async () => {
            const limited = join(work, 'bounded.har')
            const burst = `Promise.all(Array.from({length:350},(_,i)=>fetch('/bounded?ticket='+i).then(response=>response.text())))`
            const result = await cli(['browser','run','--browser',one.id,'--operation-id','har-inline-capture','--output',limited],
              `await startHarCapture(); await js(${JSON.stringify(burst)}); return await finishHarCapture();`)
            const bytes = await readFile(limited, 'utf8'), { log } = JSON.parse(bytes)
            assert.equal(result.outcome.kind, 'completed', result.outcome.message)
            assert.ok(log.entries.length > 0 && log.entries.length < 350, 'Large native result is bounded rather than unavailable')
            assert.ok(log._capture.dropped > 0, 'The file reports the actual output loss')
            assert.ok(Buffer.byteLength(bytes) < 128 * 1024)
            row.boundedExport = { entries: log.entries.length, dropped: log._capture.dropped }
          })
        } })
      assert.equal(name === 'omit-native-redirect', false, 'Original native redirect regression must fail the mutant')
    } catch (error) {
      if (name !== 'omit-native-redirect') throw error
      assert.match(String(error), /HAR must preserve original native redirect statuses/)
      row.mutationRejected = true
    } finally {
      await stopProbeProcesses(row.hostPid, work)
      row.remaining = await listProbeProcesses(row.hostPid, work)
      assert.deepEqual(row.remaining, [], 'All original probe processes exited before cleanup')
      await rm(work, { recursive: true, force: true })
      await rm(bundle, { force: true })
      await persist()
    }
  }
  assert.equal(hash(await readFile(join(repo, source))), receipt.source, 'Source must stay pinned during proof')
  receipt.passed = true
} finally {
  await rm(join(evidence, 'node_modules'), { force: true })
  await persist()
  console.log('browser-har-receipt:', join(evidence, 'receipt.json'))
}
