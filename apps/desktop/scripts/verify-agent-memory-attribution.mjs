import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const evidence = join(root, 'docs/reviews/evidence/agent-memory-attribution-2026-10-02')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const tests = ['process-resource-sampler.test.ts', 'resource-usage-observability.test.tsx']
const sourceInputs = [
  'apps/desktop/src/shared/process-usage.ts',
  'apps/desktop/src/main/process-resource-sampler.ts',
  'apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx',
  'apps/desktop/scripts/fixtures/performance-panel/data.ts',
  ...tests.map((name) => `apps/desktop/test/${name}`)
]

async function inputDigests() {
  return Object.fromEntries(await Promise.all(sourceInputs.map(async (path) => [path, digest(await readFile(join(root, path)))])))
}

async function productionCallers(symbol, definition) {
  const found = []
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name)
      if (entry.isDirectory()) await visit(next)
      else if (/\.tsx?$/.test(entry.name) && next !== join(root, definition)) {
        const lines = (await readFile(next, 'utf8')).split('\n')
        lines.forEach((line, index) => {
          // A bare import is not a closed product slice. Require an invocation,
          // constructor call or JSX mount outside the defining file.
          if (new RegExp(`\\b${symbol}\\s*(?:\\(|[/>])`).test(line)) found.push({ file: next.slice(root.length), line: index + 1, text: line.trim() })
        })
      }
    }
  }
  await visit(join(root, 'apps/desktop/src'))
  assert.ok(found.length > 0, `${symbol}: no product callers outside its defining file`)
  return found
}

async function sourceProof() {
  const before = await inputDigests()
  // Runtime receipts are ignored scratch output. Publishing a frozen copy is the
  // delivery owner's explicit step; a Task gate must not rewrite tracked evidence.
  const proofDir = join(root, '.tmp/agent-memory-attribution-source-proof')
  await mkdir(proofDir, { recursive: true })
  const isolated = await mkdtemp(join(tmpdir(), 'agentmux-memory-source-'))
  let receipt
  try {
    await cp(join(root, 'apps/desktop/src'), join(isolated, 'apps/desktop/src'), { recursive: true })
    await mkdir(join(isolated, 'apps/desktop/test'), { recursive: true })
    await mkdir(join(isolated, 'apps/desktop/scripts/fixtures/performance-panel'), { recursive: true })
    await cp(join(root, 'apps/desktop/scripts/fixtures/performance-panel/data.ts'), join(isolated, 'apps/desktop/scripts/fixtures/performance-panel/data.ts'))
    for (const name of tests) await cp(join(root, 'apps/desktop/test', name), join(isolated, 'apps/desktop/test', name))
    await symlink(join(root, 'node_modules'), join(isolated, 'node_modules'), 'dir')
    await symlink(join(root, 'apps/desktop/node_modules'), join(isolated, 'apps/desktop/node_modules'), 'dir')
    await writeFile(join(isolated, 'package.json'), JSON.stringify({ type: 'module' }))
    // The same dependency-freshness guard still runs. Only the owning source/tests are copied;
    // no other worktree, daemon, installed app or shared build output is modified.
    await writeFile(join(isolated, 'vitest.config.mts'), `import { defineConfig } from 'vitest/config';
export default defineConfig({ root: ${JSON.stringify(isolated)}, esbuild: { jsx: 'automatic' }, server: { fs: { allow: ${JSON.stringify([isolated, root])} } }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: {
  include: ${JSON.stringify(tests.map((name) => `apps/desktop/test/${name}`))}, maxWorkers: 1,
  globalSetup: [${JSON.stringify(join(root, 'vitest.dist-freshness.ts'))}], setupFiles: [${JSON.stringify(join(root, 'vitest.setup.ts'))}]
} });`)

    function run(label) {
      const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(isolated, 'vitest.config.mts')], {
        cwd: isolated, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024
      })
      const output = (result.stdout ?? '') + (result.stderr ?? '')
      assert.equal(result.error, undefined, `${label}: runner did not complete: ${result.error}`)
      assert.equal(result.signal, null, `${label}: runner interrupted`)
      const log = join(proofDir, `${label}.log`)
      return writeFile(log, output).then(() => ({ label, exitCode: result.status, assertionRed: /AssertionError/.test(output), log: log.slice(root.length) }))
    }

    const baseline = await run('baseline')
    assert.equal(baseline.exitCode, 0, 'isolated baseline must pass before mutation')
    const mutants = [
      ['root-rss', 'apps/desktop/src/shared/process-usage.ts', 'const rootRssKib = byPid.get(pid)!.rssKib', 'const rootRssKib = 0'],
      ['descendant-rss', 'apps/desktop/src/shared/process-usage.ts', 'descendantsRssKib: rssKib - rootRssKib', 'descendantsRssKib: rssKib'],
      ['descendant-count', 'apps/desktop/src/shared/process-usage.ts', 'descendantProcessCount: processCount - 1', 'descendantProcessCount: 0'],
      ['pid-double-count', 'apps/desktop/src/shared/process-usage.ts', 'if (claimed.has(current)) continue', 'if (false) continue'],
      ['sampler-root-field', 'apps/desktop/src/main/process-resource-sampler.ts', 'rootRssKib: subtree?.rootRssKib ?? null', 'rootRssKib: null'],
      ['panel-root-field', 'apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx', 'memory(run.rootRssKib)', 'memory(run.descendantsRssKib)'],
      ['mounted-details', 'apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx', '<dd>{memory(run.rootRssKib)}</dd>', '<dd>—</dd>']
    ]
    const results = []
    for (const [label, path, anchor, replacement] of mutants) {
      const target = join(isolated, path)
      const original = await readFile(target, 'utf8')
      assert.equal(original.split(anchor).length - 1, 1, `${label}: mutation must reach exactly one source anchor`)
      await writeFile(target, original.replace(anchor, replacement))
      try {
        const result = await run(label)
        assert.notEqual(result.exitCode, 0, `${label}: source mutant stayed green`)
        assert.ok(result.assertionRed, `${label}: failure was not an owning assertion`)
        results.push(result)
      } finally {
        await writeFile(target, original)
      }
    }
    const restored = await run('restored')
    assert.equal(restored.exitCode, 0, 'same-input restored source must pass')
    const callers = {}
    for (const [symbol, definition] of [
      ['rollUpSubtrees', 'apps/desktop/src/shared/process-usage.ts'],
      ['ProcessResourceSampler', 'apps/desktop/src/main/process-resource-sampler.ts'],
      ['PerformanceOverview', 'apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx'],
      ['PerformancePanel', 'apps/desktop/src/renderer/src/components/performance/PerformancePanel.tsx']
    ]) callers[symbol] = await productionCallers(symbol, definition)
    const after = await inputDigests()
    assert.deepEqual(after, before, 'shared source/test inputs changed during proof')
    receipt = { schema: 'agentmux.agent-memory-source-proof.v1', result: 'pass', baseline, mutations: results, restored, sourceInputs: before, callers,
      scope: 'Isolated actual source mutations plus nonempty mounted sampler-to-Toolkit-Performance behavior; no installed acceptance or leak claim.' }
  } finally {
    await rm(isolated, { recursive: true, force: true })
  }
  await writeFile(join(proofDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(`PASS: ${receipt.mutations.length} source mutants RED, restored GREEN, four nonempty product callers; isolated copy removed.`)
}

async function deviceProof() {
  const receiptArg = process.argv.indexOf('--receipt')
  const path = receiptArg >= 0 ? resolve(process.argv[receiptArg + 1]) : join(evidence, 'device-proof.json')
  const proof = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(proof.schema, 'agentmux.agent-memory-device-proof.v1')
  assert.equal(proof.result, 'pass')
  assert.ok(proof.installedSourceCommit && proof.rendererReleaseId && proof.runtimeId && proof.daemonInstanceId)
  assert.ok(proof.observedAt && proof.sampleWindow && proof.activeLoad)
  assert.ok(Array.isArray(proof.runs) && proof.runs.length > 0, 'real installed evidence needs a nonempty Run tree')
  for (const run of proof.runs) {
    assert.ok(run.agentSessionId && run.runId && Number.isInteger(run.rootPid))
    assert.ok(run.processCount > 0 && run.descendantProcessCount === run.processCount - 1)
    assert.equal(run.rssKib, run.rootRssKib + run.descendantsRssKib)
    assert.deepEqual(run.panel, { rssKib: run.rssKib, rootRssKib: run.rootRssKib, descendantsRssKib: run.descendantsRssKib, processCount: run.processCount, descendantProcessCount: run.descendantProcessCount })
  }
  assert.equal(proof.userLifecycleMutations, 0)
  assert.equal(proof.workbenchPreserved, true)
  assert.ok(Array.isArray(proof.artifacts) && proof.artifacts.length > 0, 'device claims need actual observer artifacts')
  for (const artifact of proof.artifacts) assert.equal(digest(await readFile(resolve(dirname(path), artifact.path))), artifact.sha256)
  console.log('PASS: exact installed observation receipt and nonempty artifact digests; no live control performed by verifier.')
}

if (process.argv.includes('--source')) await sourceProof()
else if (process.argv.includes('--device')) await deviceProof()
else throw new Error('Use --source or --device [--receipt <Root installed observation receipt>]')
