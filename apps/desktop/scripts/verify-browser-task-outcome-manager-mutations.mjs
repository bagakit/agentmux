// Actual Source consumer proof. Copies and mutations live only in /private/tmp.
// Native Chromium transfer and application restart remain separate canonical gates.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Run exact Renderer tests against private copied sources; never mutate the shared worktree. */
async function verifyManagerSourceMutations({ name, tests, sources, mutations }) {
  const root = resolve(import.meta.dirname, '../../..')
  const copy = await mkdtemp('/tmp/amx-task-outcome-manager-mutation-')
  const evidence = join(root, '.tmp', name)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const inputs = [...new Set([...tests, ...sources])]
  const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
  const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
  const receipt = { schema: 'agentmux.browser-task-outcome-manager-source-mutations.v1', passed: false, name,
    sourceBefore: hashes(original), sharedTreeMutations: 0, runtimeControl: [], cases: [] }
  const run = async label => {
    const args = ['exec', 'vitest', 'run', ...tests, '--config', join(copy, 'vitest.mutation.config.mts'), '--maxWorkers=1']
    const result = await new Promise((yes, no) => {
      const child = spawn('pnpm', args, { cwd: copy, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 90_000)
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.on('error', error => { clearTimeout(timer); no(error) }); child.on('close', (code, signal) => { clearTimeout(timer); yes({ code, signal, timedOut, output }) })
    })
    await writeFile(join(evidence, `${label}.log`), result.output)
    return { ...result, log: `${label}.log` }
  }
  try {
    await mkdir(evidence, { recursive: true })
    for (const file of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts']) await cp(join(root, file), join(copy, file))
    await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
    for (const pkg of ['core', 'layout', 'demand']) {
      const destination = join(copy, 'packages', pkg)
      await mkdir(destination, { recursive: true })
      for (const entry of await readdir(join(root, 'packages', pkg))) {
        if (['node_modules', 'vendor'].includes(entry)) continue
        await cp(join(root, 'packages', pkg, entry), join(destination, entry), { recursive: true })
      }
      await symlink(join(root, 'packages', pkg, 'node_modules'), join(destination, 'node_modules'))
    }
    const desktop = join(copy, 'apps/desktop')
    await mkdir(desktop, { recursive: true })
    for (const file of ['src', 'resources', 'package.json', 'tsconfig.json']) await cp(join(root, 'apps/desktop', file), join(desktop, file), { recursive: true })
    await mkdir(join(desktop, 'node_modules/@agentmux'), { recursive: true })
    for (const entry of await readdir(join(root, 'apps/desktop/node_modules'))) {
      if (entry !== '@agentmux') await symlink(join(root, 'apps/desktop/node_modules', entry), join(desktop, 'node_modules', entry))
    }
    for (const pkg of ['core', 'layout', 'demand']) await symlink(join(copy, 'packages', pkg), join(desktop, 'node_modules/@agentmux', pkg))
    for (const [file, bytes] of original) { await mkdir(dirname(join(copy, file)), { recursive: true }); await writeFile(join(copy, file), bytes) }
    await writeFile(join(copy, 'vitest.mutation.config.mts'), `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ resolve: { alias: { '@agentmux/core': ${JSON.stringify(join(copy, 'packages/core/src/index.ts'))} } }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { include: ${JSON.stringify(tests)}, setupFiles: [${JSON.stringify(join(copy, 'vitest.setup.ts'))}] } });\n`)
    receipt.sourceBoundary = { electronAndCdp: 'test doubles', ownersAndFiles: 'production source', coreResolution: 'packages/core/src/index.ts', nativeTransfer: false, applicationRestart: false }
    for (const [file, bytes] of original) { await mkdir(dirname(join(evidence, 'actual-source', `${file}.txt`)), { recursive: true }); await writeFile(join(evidence, 'actual-source', `${file}.txt`), bytes) }
    const baseline = await run('baseline-green')
    assert.equal(baseline.code, 0, baseline.output)
    assert.match(baseline.output, /Tests\s+17 passed/)
    for (const { label, file, before, after } of mutations) {
      const source = original.get(file).toString()
      assert.equal(source.split(before).length - 1, 1, `Unique mutation anchor: ${label}`)
      try {
        await writeFile(join(copy, file), source.replace(before, after))
        const red = await run(`${label}-red`)
        assert.ok(red.code > 0 && red.signal === null && !red.timedOut, red.output)
        assert.match(red.output, /AssertionError/)
        assert.match(red.output, /Tests\s+[1-9]\d* failed/)
        receipt.cases.push({ label, file, before, after, exit: red.code, log: red.log })
        console.log(JSON.stringify({ label, assertionRed: true }))
      } finally { await writeFile(join(copy, file), original.get(file)) }
      const green = await run(`${label}-restore-green`)
      assert.equal(green.code, 0, green.output)
      assert.match(green.output, /Tests\s+17 passed/)
      receipt.cases.at(-1).restore = { exit: green.code, log: green.log }
    }
    receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))]))))
    assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
    receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(copy, file))]))))
    assert.deepEqual(receipt.copyAfter, receipt.sourceBefore)
    receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
  finally {
    await rm(copy, { recursive: true, force: true })
    receipt.cleanup = { copyRemoved: true }
    await writeFile(join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  }
  assert.equal(receipt.passed, true, receipt.failure?.message)
  console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
}

await verifyManagerSourceMutations({
  "name": "browser-task-outcome-manager-consumer-mutations",
  "tests": [
    "apps/desktop/test/browser-task-outcome-download-manager.test.ts",
    "apps/desktop/test/browser-outcome-manager.test.ts"
  ],
  "sources": [
    "apps/desktop/src/main/browser-view-manager.ts",
    "apps/desktop/src/main/browser-task-assets.ts",
    "apps/desktop/src/main/browser-outcome-criteria.ts",
    "apps/desktop/src/shared/browser-task-assets.ts",
    "apps/desktop/src/shared/browser-outcome-criteria.ts",
    "apps/desktop/src/main/browser-downloads.ts",
    "apps/desktop/src/main/workspace-files.ts",
    "apps/desktop/src/shared/browser-download.ts",
    "apps/desktop/src/shared/workspace-file-bytes.ts",
    "apps/desktop/src/main/browser-operation-journal.ts",
    "apps/desktop/src/main/browser-outcome-journal.ts",
    "apps/desktop/src/main/browser-completion-control.ts",
    "apps/desktop/src/main/browser-page-dispatch.ts",
    "apps/desktop/src/main/browser-step-evidence.ts",
    "apps/desktop/src/main/browser-result-artifact.ts",
    "apps/desktop/src/main/browser-ref-ledger-store.ts",
    "packages/core/src/index.ts",
    "packages/core/src/durable-write.ts",
    "packages/core/src/execution-host.ts",
    "packages/core/src/process-runner.ts",
    "packages/core/src/errors.ts",
    "apps/desktop/scripts/verify-browser-task-outcome-manager-mutations.mjs"
  ],
  "mutations": [
    {
      "label": "binding-disconnected-before-producer",
      "file": "apps/desktop/src/main/browser-view-manager.ts",
      "before": "const bound = await this.taskAssets!.bindOperation(cursor, operation.id)",
      "after": "const bound = true"
    },
    {
      "label": "registration-disconnected-before-producer",
      "file": "apps/desktop/src/main/browser-view-manager.ts",
      "before": "const saved = await this.operationJournal.registerOutcome(operation.id, registration)",
      "after": "const saved = undefined"
    },
    {
      "label": "manager-download-receipts-disconnected",
      "file": "apps/desktop/src/main/browser-view-manager.ts",
      "before": "return await this.downloads.list({ workspaceId: entry.workspaceId, browserId: entry.id })",
      "after": "return []"
    },
    {
      "label": "manager-download-file-reader-disconnected",
      "file": "apps/desktop/src/main/browser-view-manager.ts",
      "before": "return await this.downloads.read(reference, { workspaceId: entry.workspaceId, browserId: entry.id }, options)",
      "after": "throw new Error('Disconnected download reader')"
    },
    {
      "label": "manager-human-fact-reader-disconnected",
      "file": "apps/desktop/src/main/browser-view-manager.ts",
      "before": "const read = await this.taskAssets.readExactFact({ ...tuple, browserId: entry.id }, checkpointId)",
      "after": "const read = { status: 'not-recorded' } as const"
    },
    {
      "label": "actual-version-replaced-by-registration-block",
      "file": "apps/desktop/src/main/browser-view-manager.ts",
      "before": "        if (!run || run.completionWarning || run.id !== registration.assetRun.runId || run.assetId !== registration.assetRun.assetId ||\n            run.version !== registration.assetRun.version || !run.operationIds.includes(operationId) ||\n            (entry.activity.operation && !run.operationIds.includes(entry.activity.operation.id))) throw new Error('The actual asset execution changed.')\n        return { workspaceId: entry.workspaceId, browserId: entry.id, navigationId: entry.navigationId,\n          assetRun: { runId: run.id, assetId: run.assetId, version: run.version, operationIds: run.operationIds } }",
      "after": "        if (!run || run.completionWarning || run.id !== registration.assetRun.runId || run.assetId !== registration.assetRun.assetId ||\n            !run.operationIds.includes(operationId) ||\n            (entry.activity.operation && !run.operationIds.includes(entry.activity.operation.id))) throw new Error('The actual asset execution changed.')\n        return { workspaceId: entry.workspaceId, browserId: entry.id, navigationId: entry.navigationId,\n          assetRun: { runId: run.id, assetId: run.assetId, version: registration.assetRun.version, operationIds: run.operationIds } }"
    },
    {
      "label": "selected-run-replaced-by-first-history",
      "file": "apps/desktop/src/main/browser-task-assets.ts",
      "before": "const selected = this.document.selectedRuns?.find(item => item.browserId === browserId)",
      "after": "const first = this.document.runs.find(item => item.browserId === browserId); const selected = first && { runId: first.id }"
    },
    {
      "label": "actual-operation-join-replaced-by-registration-block",
      "file": "apps/desktop/src/main/browser-view-manager.ts",
      "before": "        if (!run || run.completionWarning || run.id !== registration.assetRun.runId || run.assetId !== registration.assetRun.assetId ||\n            run.version !== registration.assetRun.version || !run.operationIds.includes(operationId) ||\n            (entry.activity.operation && !run.operationIds.includes(entry.activity.operation.id))) throw new Error('The actual asset execution changed.')\n        return { workspaceId: entry.workspaceId, browserId: entry.id, navigationId: entry.navigationId,\n          assetRun: { runId: run.id, assetId: run.assetId, version: run.version, operationIds: run.operationIds } }",
      "after": "        if (!run || run.completionWarning || run.id !== registration.assetRun.runId || run.assetId !== registration.assetRun.assetId ||\n            run.version !== registration.assetRun.version || false ||\n            (entry.activity.operation && !run.operationIds.includes(entry.activity.operation.id))) throw new Error('The actual asset execution changed.')\n        return { workspaceId: entry.workspaceId, browserId: entry.id, navigationId: entry.navigationId,\n          assetRun: { runId: run.id, assetId: run.assetId, version: run.version, operationIds: [operationId] } }"
    },
    {
      "label": "unfinished-owner-record-becomes-not-met",
      "file": "apps/desktop/src/main/browser-outcome-criteria.ts",
      "before": "if (receipt.status === 'failed') return result(condition, 'unavailable',",
      "after": "if (receipt.status === 'failed') return result(condition, 'not-met',"
    },
    {
      "label": "optional-recording-failure-misreported-passed",
      "file": "apps/desktop/src/main/browser-view-manager.ts",
      "before": "!run || run.completionWarning || run.id !== registration.assetRun.runId",
      "after": "!run || run.id !== registration.assetRun.runId"
    },
    {
      "label": "historical-download-producer-accepted-block",
      "file": "apps/desktop/src/main/browser-outcome-criteria.ts",
      "before": "(await host.getDownloads()).filter(receipt => receipt.operationId === condition.producer.operationId &&\n    receipt.navigationId === condition.producer.navigationId && receipt.browserId === registration.context.browserId &&",
      "after": "(await host.getDownloads()).filter(receipt => receipt.browserId === registration.context.browserId &&"
    }
  ]
})
