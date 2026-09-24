import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

// This finite counterexample producer consumes an already frozen private source copy.
// It never copies, builds, installs, or writes the shared checkout/dependency cache.
const root = path.resolve(import.meta.dirname, '../../..')
assert.deepEqual(process.argv.slice(2, 3), ['--source'])
const markerPath = path.join(root, '.bounded-store-source.json')
assert.ok(await fs.stat(markerPath).then(s => s.isFile(), () => false),
  'Run only from a fixed private source copy with .bounded-store-source.json; shared checkout mutations are prohibited')
assert.equal(await fs.stat(path.join(root, '.git')).then(() => true, () => false), false)
const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'))
assert.equal(marker.privateSource, await fs.realpath(root))
const index = process.argv.indexOf('--evidence')
const evidence = index < 0 ? path.join(root, '..', `source-mutations-${Date.now()}`) : path.resolve(process.argv[index + 1])
await fs.mkdir(evidence, { recursive: false })
const store = 'apps/desktop/src/renderer/src/store.ts'
const helper = 'apps/desktop/src/renderer/src/lib/workbench-surface-kinds.ts'
const catalog = 'apps/desktop/src/renderer/src/lib/space-agent-control.ts'
const guard = 'apps/desktop/test/workbench-surface-kind-exhaustiveness.test.ts'
const tests = [guard, 'apps/desktop/test/desktop-client-observation.test.ts', 'apps/desktop/test/demand-pmo-tab-context.test.ts']
const files = [...new Set([store, helper, catalog, ...tests, 'apps/desktop/scripts/verify-store-surface-guard.mjs'])]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const originals = new Map(await Promise.all(files.map(async file => [file, await fs.readFile(path.join(root, file))])))
const inputs = Object.fromEntries([...originals].map(([file, bytes]) => [file, sha(bytes)]))
for (const [file, digest] of Object.entries(marker.inputs)) assert.equal(inputs[file], digest, `Fixed input changed: ${file}`)
const receipt = { schema: 'agentmux.store-surface-guard-source.v1', passed: false,
  scope: 'bounded Source only; not T011 done, whole-main, Native, App, Run or installed-package qualification',
  source: marker, inputs, artifacts: {}, cases: [] }
const artifact = async (name, bytes) => {
  await fs.writeFile(path.join(evidence, name), bytes)
  receipt.artifacts[name] = sha(bytes)
  return name
}
const run = async (name, focused = tests) => {
  const args = ['node_modules/vitest/vitest.mjs', 'run', ...focused, '--maxWorkers=1']
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env,
    encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { exit: result.status, error: result.error?.message, command: `node ${args.join(' ')}`,
    log: await artifact(`${name}.log`, log), text: log }
}
const positive = (run, red = false) => {
  assert.ok(Number.isInteger(run.exit), run.error ?? 'test process did not complete')
  assert.match(run.text, red ? /Tests\s+[1-9]\d* failed/ : /Tests\s+[1-9]\d* passed/)
  for (const file of red ? [guard] : tests) assert.ok(run.text.includes(path.basename(file)), `Owning file did not execute: ${file}`)
}
const compact = ({ text, ...value }) => value
const mutations = [
  { name: 'inspect-mapper-loses-never-default', file: store,
    assertion: /store\.ts::\(anonymous @ store\.ts:\d+\) \[surface\] branches on \{agent, browser, file, git-diff, launcher, terminal\}/,
    before: "case 'launcher': return { ...base, kind: surface.kind }\n              default: return assertUnreachableSurface(surface)",
    after: "case 'launcher': return { ...base, kind: surface.kind }" },
  { name: 'central-topic-predicate-loses-never-default', file: helper,
    assertion: /every exported surface predicate must have its real never default/,
    before: "case 'terminal':\n    case 'file':\n    case 'git-diff':\n    case 'browser':\n      return false\n    default:\n      return assertUnreachableSurface(surface)",
    after: "case 'terminal':\n    case 'file':\n    case 'git-diff':\n    case 'browser':\n      return false\n    default:\n      return false" },
  { name: 'discovery-all-collections-reset-empty', file: guard,
    assertion: /the central never backstop must resolve uniquely/,
    before: 'return { backstop, predicates, declaredPredicates, anchors }',
    after: 'return { backstop: null, predicates: new Set<ts.Symbol>(), declaredPredicates: new Set<ts.Symbol>(), anchors: new Set<ts.Symbol>() }' },
  { name: 'foreign-same-name-symbol-admitted', file: guard,
    assertion: /falseOwnerEnumerator routes through no SSOT anchor/,
    before: 'if (symbol && anchors.has(symbol) && node.arguments[0]) {',
    after: 'if (symbol && [...anchors].some(anchor => anchor.getName() === symbol.getName()) && node.arguments[0]) {' },
  { name: 'all-receiver-and-anchor-keys-merged', file: guard,
    assertion: /central owner on another receiver cannot anchor this enumerator|different receivers must remain separate/,
    before: 'const receiverKey = (value: ts.Node, seen = new Set<ts.Symbol>()): string | null => {',
    after: "const receiverKey = (value: ts.Node, seen = new Set<ts.Symbol>()): string | null => {\n    return 'whole-function'" },
  { name: 'catalog-bypasses-central-session-predicate', file: catalog,
    assertion: /lib\/space-agent-control\.ts::spatialCatalog \[surface\] branches on \{agent, terminal\}/,
    before: 'const session = isSessionSurface(surface) ? sessions.get(surface.sessionId) : undefined',
    after: "const session = surface.kind === 'agent' || surface.kind === 'terminal' ? sessions.get(surface.sessionId) : undefined" },
  { name: 'direct-iife-owner-no-longer-consumed', file: guard,
    assertion: /a direct IIFE must propagate the same receiver owner/,
    before: 'return current === fn',
    after: 'return enclosingFunction(node) === fn' }
]
try {
  const green = await run('baseline-green'); positive(green); assert.equal(green.exit, 0, green.text)
  receipt.baseline = compact(green)
  for (const mutation of mutations) {
    const original = originals.get(mutation.file)
    const source = original.toString('utf8')
    assert.equal(source.split(mutation.before).length - 1, 1, `Mutation anchor must be unique: ${mutation.name}`)
    const changed = source.replace(mutation.before, mutation.after)
    try {
      await fs.writeFile(path.join(root, mutation.file), changed)
      const red = await run(mutation.name, [guard]); positive(red, true)
      assert.notEqual(red.exit, 0, `Mutation survived: ${mutation.name}`)
      assert.match(red.text, /AssertionError/, `Environment failure is not a behavioral RED: ${mutation.name}`)
      assert.match(red.text, mutation.assertion, `Unrelated failure cannot sign ${mutation.name}`)
      receipt.cases.push({ ...mutation, assertion: mutation.assertion.source, mutatedSha256: sha(changed), ...compact(red) })
    } finally {
      await fs.writeFile(path.join(root, mutation.file), original)
      assert.equal(sha(await fs.readFile(path.join(root, mutation.file))), inputs[mutation.file])
    }
  }
  const greenRestored = await run('restored-green'); positive(greenRestored); assert.equal(greenRestored.exit, 0, greenRestored.text)
  receipt.green = compact(greenRestored)

  // These are actual AST call sites; definitions, imports, tests and metadata are excluded.
  const contracts = [
    ['assertUnreachableSurface', 'apps/desktop/src/renderer/src/lib/workbench-surface-kinds.ts', store],
    ['isAgentOrLauncherSurface', 'apps/desktop/src/renderer/src/lib/workbench-surface-kinds.ts', store],
    ['isSessionSurface', helper, catalog],
    ['executeSpatialControl', catalog, store],
    ['inspectDesktopClient', 'apps/desktop/src/main/client-observation.ts', 'apps/desktop/src/main/ipc.ts'],
    ['openDemandPmo', store, 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx'],
    ['requestDemandPmoTask', store, 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx']
  ]
  receipt.callers = []
  for (const [symbol, definition, file] of contracts) {
    assert.notEqual(file, definition)
    const bytes = await fs.readFile(path.join(root, file))
    receipt.inputs[file] = sha(bytes)
    const source = ts.createSourceFile(file, bytes.toString(), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const hits = []
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null
        if (name === symbol) hits.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, call: node.expression.getText(source) })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    assert.ok(hits.length > 0, `No actual non-definition/non-import caller: ${symbol}`)
    receipt.callers.push({ symbol, definition, file, hits })
  }
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
  for (const [file, bytes] of originals) await fs.writeFile(path.join(root, file), bytes)
  receipt.restored = Object.fromEntries(await Promise.all(Object.keys(receipt.inputs).map(async file => [file, sha(await fs.readFile(path.join(root, file)))])))
  receipt.exactRestoration = JSON.stringify(receipt.restored) === JSON.stringify(receipt.inputs)
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.exactRestoration, true)
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, cases: receipt.cases.length, exactRestoration: true, evidence }))
