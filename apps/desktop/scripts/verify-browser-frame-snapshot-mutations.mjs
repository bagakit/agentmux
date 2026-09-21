import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.resolve(process.argv[2] ?? await fs.mkdtemp(path.join(root, '.tmp/browser-frame-mutations-')))
const isolated = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'amux-frame-mutations-')))
const snapshot = 'apps/desktop/src/main/browser-page-snapshot.ts'
const documents = 'apps/desktop/src/main/browser-frame-documents.ts'
const query = 'apps/desktop/src/main/browser-snapshot-query.ts'
const cdp = 'apps/desktop/src/main/browser-cdp-session.ts'
const tests = ['apps/desktop/test/browser-frame-snapshot.test.ts', 'apps/desktop/test/browser-scoped-snapshot.test.ts', 'apps/desktop/test/browser-cdp-session.test.ts']
const cases = [
  ['same-process-document-branch-removed', snapshot, 'for (const document of discovery.documents) {', 'for (const document of discovery.documents.filter(item => item.depth === 0 || item.sessionId !== undefined)) {'],
  ['document-identity-merged-into-session', query, "`${node.frameId ?? '(unidentified document)'}:${node.sessionId ?? 'main'}:${node.backendNodeId}`", "`${node.sessionId ?? 'main'}:${node.backendNodeId}`"],
  ['embedded-failure-notice-removed', snapshot, 'missingFrames.push({ frameId: document.frameId!, reason: error instanceof Error ? error.message : String(error) })', 'void error'],
  ['duplicate-missing-document-notices', snapshot, 'const previousFailure = missingFrames.find((failure) => failure.frameId === frameId)', 'const previousFailure = undefined'],
  ['changed-document-refs-published', snapshot, 'for (let index = nodes.length - 1; index >= 0; index -= 1) if (nodes[index]!.frameId === frameId) nodes.splice(index, 1)', 'void frameId'],
  ['same-session-loader-change-ignored', documents, 'frame.loaderId !== document.loaderId', 'false'],
  ['document-read-budget-removed', documents, 'facts.size >= MAX_BROWSER_FRAME_DOCUMENTS', 'false'],
  ['explicit-AX-document-removed', snapshot, 'collectAxNodes(document.sendCommand, document.frameId)', 'collectAxNodes(document.sendCommand, null)'],
  ['nearest-native-sender-overwritten-by-parent', documents, 'owner ??= owners.get(cursor.id)', 'owner = owners.get(cursor.id)'],
  ['empty-embedded-tree-silently-skipped', snapshot, "if (!root) throw new Error('The accessibility tree returned no document root. Retry snapshot().')", 'if (!root) continue'],
  ['wrong-native-AX-root-accepted', snapshot, "if (document.frameId !== null && root.frameId !== undefined && root.frameId !== document.frameId) throw new Error('The accessibility root belongs to a different document. Take a new snapshot().')", 'void root.frameId'],
  ['foreign-AX-subtree-misattributed', snapshot, 'if (node.frameId !== undefined && frameId !== null && node.frameId !== frameId) return', 'void node.frameId'],
  ['viewport-uses-main-document-layout', snapshot, 'snapshot.documents?.find((item) => item.frameId !== undefined && snapshot.strings?.[item.frameId] === frameId)', 'snapshot.documents?.[0]'],
  ['viewport-uses-main-realm', snapshot, 'contextId: realm.executionContextId, returnByValue: true', 'returnByValue: true'],
  ['Main-supplement-enters-page-world', snapshot, 'expression: CURSOR_INTERACTIVE_EXPRESSION,\n      contextId: executionContextId,', 'expression: CURSOR_INTERACTIVE_EXPRESSION,'],
  ['CSS-within-enters-page-world', snapshot, 'resolveWithinSelector(scopedSend, query.within, await mainObservationContext(mainDocument?.frameId))', 'resolveWithinSelector(scopedSend, query.within)'],
  ['clickable-failure-reported-as-empty-success', snapshot, "if (evaluated.exceptionDetails || typeof evaluated.result?.value !== 'string') throw new Error('Clickable evaluation did not return an observed result')\n    const labels = JSON.parse(evaluated.result.value) as string[]", "const labels = JSON.parse(evaluated.result?.value ?? '[]') as string[]"],
  ['nested-discovery-warning-removed', cdp, 'if (this.frameSenders.has(sessionId) && this.gone === null) this.frameAttachFailure = `Nested frame discovery failed for CDP session ${sessionId} (${error instanceof Error ? error.message : String(error)}). Retry snapshot() to observe embedded documents.`', 'void error'],
  ['workers-advertised-as-frame-documents', cdp, "if (!sessionId || targetInfo?.type !== 'iframe') return", 'if (!sessionId) return']
]
const inputs = [snapshot, documents, query, cdp, ...tests]
const originals = new Map(await Promise.all(inputs.map(async file => [file, await fs.readFile(path.join(root, file))])))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries([...originals].map(([file, bytes]) => [file, hash(bytes)])), cases: [] }
await fs.mkdir(evidence, { recursive: true })
try {
  for (const directory of ['apps/desktop/src/main', 'apps/desktop/src/shared']) await fs.cp(path.join(root, directory), path.join(isolated, directory), { recursive: true })
  await fs.symlink(path.join(root, 'apps/desktop/resources'), path.join(isolated, 'apps/desktop/resources'), 'dir')
  await fs.mkdir(path.join(isolated, 'apps/desktop/test'), { recursive: true })
  for (const test of tests) await fs.writeFile(path.join(isolated, test), originals.get(test))
  await fs.symlink(path.join(root, 'node_modules'), path.join(isolated, 'node_modules'), 'dir')
  await fs.symlink(path.join(root, 'apps/desktop/node_modules'), path.join(isolated, 'apps/desktop/node_modules'), 'dir')
  await fs.writeFile(path.join(isolated, 'package.json'), '{"type":"module"}\n')
  const config = path.join(isolated, 'vitest.config.mjs')
  await fs.writeFile(config, `export default { test: { include: ${JSON.stringify(tests)} } }\n`)
  const run = async name => {
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...tests, '--root', isolated, '--config', config, '--maxWorkers=1'], { cwd: isolated, encoding: 'utf8', timeout: 60_000 })
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
    await fs.writeFile(path.join(evidence, `${name}.log`), log)
    return { exit: result.status, log }
  }
  assert.equal((await run('baseline')).exit, 0, 'The unmodified source must pass.')
  for (const [name, file, before, after] of cases) {
    const source = originals.get(file).toString('utf8')
    assert.equal(source.split(before).length - 1, 1, `Unique source anchor: ${name}`)
    await fs.writeFile(path.join(isolated, file), source.replace(before, after))
    try {
      const red = await run(name)
      assert.notEqual(red.exit, 0, `Mutation survived: ${name}`)
      assert.match(red.log, /AssertionError/, `Mutation must fail a behavioral assertion: ${name}`)
      receipt.cases.push({ name, file, redExit: red.exit, log: `${name}.log` })
    } finally { await fs.writeFile(path.join(isolated, file), originals.get(file)) }
  }
  assert.equal((await run('restored')).exit, 0, 'Restored source must pass.')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  receipt.ownSourceUnchanged = Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await fs.readFile(path.join(root, file))) === receipt.sourceHashes[file]])))
  await fs.writeFile(path.join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  await fs.rm(isolated, { recursive: true, force: true })
}
assert.equal(receipt.passed, true, receipt.failure?.message)
assert.equal(Object.values(receipt.ownSourceUnchanged).every(Boolean), true, 'Inspect concurrent edits before closing the slice.')
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, evidence }))
