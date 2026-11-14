import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const read = async path => await readFile(new URL(path, import.meta.url), 'utf8')
const budget = await read('../src/main/representative-resource-budget.ts')
const harness = await read('./measure-desktop-resources.mjs')
const measure = await read('../src/main/representative-resource-probe.ts')
const resourceProbe = await read('../src/main/resource-probe.ts')
const main = await read('../src/main/index.ts')

const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }
}).outputText
const loadPolicy = async source => await import(`data:text/javascript;base64,${Buffer.from(transpile(source)).toString('base64')}`)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
function syntax(source, predicate) {
  const tree = ts.createSourceFile('gate.ts', source, ts.ScriptTarget.Latest, true)
  const matches = []
  function visit(node) {
    if (predicate(node)) matches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.equal(matches.length, 1)
  return matches[0].getText(tree)
}
const declaration = (source, name) => syntax(source, node => ts.isFunctionDeclaration(node) && node.name?.text === name)

const original = await loadPolicy(budget)
const { REPRESENTATIVE_WARM_MS: warmMs, REPRESENTATIVE_ACTIVITY_MS: activityMs } = original
const rendererPid = 18
function samples(durationMs, rss = 870_000) {
  return Array.from({ length: durationMs / 200 + 1 }, (_, index) => ({
    elapsedMs: index * 200, documentPid: rendererPid, documentGeneration: 0,
    metrics: [{ pid: 71, type: 'Tab', workingSetKiB: 3_500_000 }, { pid: rendererPid, type: 'Tab', workingSetKiB: rss },
      { pid: 80, type: 'Browser', workingSetKiB: 6_000_000 }]
  }))
}
const evidence = {
  hostMemoryBytes: 16 * 1024 ** 3, rendererPid, documentGenerationChanges: 0,
  fixtureRevision: 5, restoredTabs: 430, restoredRegions: 430, restoredWorkspaces: 3,
  restoredRuns: Array.from({ length: 6 }, (_, index) => ({ runId: `run-${index}`, pid: 100 + index,
    seededOutputBytes: 263_000, warmStartOutputBytes: 300_000, warmOutputBytes: 400_000, finalOutputBytes: 600_000 })),
  visibleRunId: 'run-0', warmInputEcho: true, burstOutputBytes: 263_000, activityFinishedMs: 6200,
  alternateRunId: 'run-2', alternateInputEcho: true, returnedInputEcho: true,
  warm: samples(warmMs), activity: samples(activityMs)
}

function check(evaluate) {
  const result = evaluate(evidence)
  assert.equal(result.status, 'passed', 'A larger unrelated Renderer and Browser must not determine the scoped result')
  assert.equal(result.capacity.status, 'matched')
  assert.equal(evaluate({ ...evidence, hostMemoryBytes: 48 * 1024 ** 3 }).capacity.status, 'unmatched')
  assert.equal(evaluate({ ...evidence, warm: samples(warmMs, 1024 ** 2), activity: samples(activityMs, 1536 * 1024) }).status, 'passed')
  assert.equal(evaluate({ ...evidence, warm: samples(warmMs, 1024 ** 2 + 1) }).status, 'budget-exceeded', 'Warm excess must fail')
  const peak = samples(activityMs)
  peak[5].metrics[1].workingSetKiB = 1536 * 1024 + 1
  assert.equal(evaluate({ ...evidence, activity: peak }).status, 'budget-exceeded', 'A single real activity peak must fail')
  assert.equal(evaluate({ ...evidence, restoredTabs: 4 }).status, 'coverage-missing', 'A lightweight workface must not pass')
  const inactive = structuredClone(evidence)
  inactive.restoredRuns[1].warmStartOutputBytes = inactive.restoredRuns[1].warmOutputBytes
  assert.equal(evaluate(inactive).status, 'coverage-missing', 'Idle background Runs must not pass')
  assert.equal(evaluate({ ...evidence, burstOutputBytes: 0 }).status, 'coverage-missing')
  assert.equal(evaluate({ ...evidence, activityFinishedMs: activityMs + 500 }).status, 'coverage-missing', 'Actions beyond the measured window must not pass')
  assert.equal(evaluate({ ...evidence, warm: [] }).status, 'coverage-missing')
  assert.equal(evaluate({ ...evidence, warm: samples(warmMs - 800) }).status, 'coverage-missing')
  const changedDocument = samples(warmMs)
  changedDocument[6].documentPid++
  assert.equal(evaluate({ ...evidence, warm: changedDocument }).status, 'coverage-missing', 'A missing original document PID cut must not pass')
  const reloadedDocument = samples(warmMs)
  reloadedDocument[6].documentGeneration++
  assert.equal(evaluate({ ...evidence, warm: reloadedDocument }).status, 'coverage-missing', 'A same-PID document reload must not pass')
  assert.equal(evaluate({ ...evidence, documentGenerationChanges: 1 }).status, 'coverage-missing', 'Navigation between windows must not pass')
}

check(original.evaluateRepresentativeResourceBudget)
const mutants = [
  ['process rollup', 'metrics.filter((metric) => metric.pid === rendererPid)', 'metrics.filter((metric) => metric.type === "Tab").slice(0, 1)', 'larger unrelated Renderer'],
  ['diagnostic-only budget', 'maxWorkingSetKiB > limitKiB', 'false', 'Warm excess'],
  ['small topology', 'restoredTabs === REPRESENTATIVE_TAB_COUNT', 'restoredTabs > 0', 'lightweight workface'],
  ['idle originals', 'run.warmOutputBytes > run.warmStartOutputBytes', 'run.warmOutputBytes >= run.warmStartOutputBytes', 'Idle background Runs'],
  ['active interval does not cover switch', 'activityFinishedMs <= (activity.at(-1)?.elapsedMs ?? 0)', 'true', 'Actions beyond the measured window'],
  ['Renderer change', 'documentPid === rendererPid && ', '', 'original document PID cut'],
  ['same-PID reload', 'documentGeneration === 0 && ', '', 'same-PID document reload']
]
for (const [name, before, after, assertion] of mutants) {
  assert.equal(budget.split(before).length, 2, `Source mutation must change precisely one branch: ${name}`)
  const mutated = await loadPolicy(budget.replace(before, after))
  assert.throws(() => check(mutated.evaluateRepresentativeResourceBudget), { name: 'AssertionError', message: new RegExp(assertion) }, name)
}

const sampleSource = declaration(measure, 'sampleWindow')
let clock = 0, pid = rendererPid
const sampleWindow = new AsyncFunction('app', 'delay', 'performance', 'REPRESENTATIVE_SAMPLE_INTERVAL_MS',
  transpile(sampleSource) + '\nreturn sampleWindow')
const collector = await sampleWindow({ getAppMetrics: () => [{ pid, type: 'Tab', memory: { workingSetSize: 900_000 } }] },
  async millis => { clock += millis; pid++ }, { now: () => clock }, 200)
const collected = []
await collector({ webContents: { getOSProcessId: () => pid } }, collected, 400, () => Number(clock >= 400))
assert.deepEqual(collected.map(item => [item.elapsedMs, item.documentPid, item.documentGeneration, item.metrics[0].workingSetKiB]),
  [[0, rendererPid, 0, 900_000], [200, rendererPid + 1, 0, 900_000], [400, rendererPid + 2, 1, 900_000]])

const fixture = 'private-fixture.json'
const reportPath = 'private-report.json'
const outcome = { status: 'budget-exceeded', evidence: { rendererPid } }
const env = { AGENTMUX_DESKTOP_RESOURCE_REPORT: reportPath, AGENTMUX_DESKTOP_RESOURCE_WORKFACE: fixture }
const window = { webContents: {} }, runtime = {}, configStore = {}
let receipt
const entry = declaration(resourceProbe, 'runDesktopResourceProbe')
const dependency = "await import('./representative-resource-probe.js')"
assert.equal(entry.split(dependency).length, 2)
const runDesktopResourceProbe = await new AsyncFunction('process', 'fixtureMeasure', 'resourceIdentity', 'writeFile',
  transpile(entry.replace(/^export /u, '').replace(dependency, '{ measureRepresentativeWorkface: fixtureMeasure }')) + '\nreturn runDesktopResourceProbe')(
    { env, pid: 42 }, async (seenWindow, seenRuntime, seenFixture) => {
      assert.equal(seenWindow, window); assert.equal(seenRuntime, runtime); assert.equal(seenFixture, fixture)
      return outcome
    }, () => ({ agentmuxCommit: 'original-identity' }), async (path, data) => {
      assert.equal(path, reportPath)
      receipt = JSON.parse(data)
    })
const mainCall = syntax(main, node => ts.isIfStatement(node) && node.expression.getText().startsWith('await runDesktopResourceProbe('))
let quit = false
await new AsyncFunction('runDesktopResourceProbe', 'window', 'runtime', 'configStore', 'app', 'process', 'appReadyAtMs',
  'windowCreationStartedAtMs', 'rendererLoadedAtMs', mainCall)(
  runDesktopResourceProbe, window, runtime, configStore, { quit: () => { quit = true } }, { env }, 1, 2, 3)
assert.equal(quit, true)
assert.deepEqual(receipt.representative, outcome)
assert.equal(receipt.mainPid, 42)

const admitReport = new Function(declaration(harness, 'assertRepresentativeResult') + '\nreturn assertRepresentativeResult')()
assert.doesNotThrow(() => admitReport({ representative: { status: 'passed' } }))
assert.throws(() => admitReport(receipt), /budget-exceeded/u)
assert.throws(() => admitReport(null), /coverage-missing/u)
const root = JSON.parse(await read('../../../package.json'))
const desktop = JSON.parse(await read('../package.json'))
assert.match(root.scripts['test:resources'], /measure:desktop/u)
assert.match(desktop.scripts['measure:desktop'], /measure-desktop-resources\.mjs/u)
console.log(`Representative resource budget and product wiring passed. ${mutants.length} source mutants were rejected.`)
