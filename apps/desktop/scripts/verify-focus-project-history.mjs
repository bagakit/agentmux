import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2), slice = args[args.indexOf('--slice') + 1]
if (slice === 'complete-history') {
  await verifyCompleteHistory()
  process.exit(process.exitCode ?? 0)
}
if (slice !== 'retained-focus') throw new Error('Select retained-focus or complete-history.')
const directory = resolve(root, `.tmp/focus-project-history-source-${Date.now()}`)
mkdirSync(directory, { recursive: true })
const sourcePaths = [
  'apps/desktop/src/renderer/src/lib/agent-focus.ts',
  'apps/desktop/src/renderer/src/lib/focus-history-identity.ts',
  'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts',
  'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx',
  'apps/desktop/src/renderer/src/styles/focus.css',
  'apps/desktop/src/renderer/src/store.ts'
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const binding = () => Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(resolve(root, path)))]))
const before = binding()
const phases = []
function run(name, command, options = {}) {
  const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', env: { ...process.env, ...options.env }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(directory, `${name}.stdout.log`), result.stdout ?? '')
  writeFileSync(resolve(directory, `${name}.stderr.log`), result.stderr ?? '')
  phases.push({ name, command, exit: result.status, signal: result.signal, error: result.error?.message })
  console.log(`${name}: exit ${result.status}`)
  if (result.error || result.signal || (options.red ? result.status === 0 : result.status !== 0)) throw new Error(`${name} failed its ${options.red ? 'loaded AssertionRED' : 'GREEN'} requirement; original logs retained at ${directory}`)
  return result
}
function tests(name, config, options = {}) {
  const output = resolve(directory, `${name}.json`)
  run(name, ['node', 'node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', '--reporter=json', `--outputFile=${output}`], options)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  if (!(report.numTotalTests > 0)) throw new Error(`${name} collected no tests.`)
  if (options.red && !(report.numFailedTests > 0 && report.testResults.some(file => file.assertionResults.some(test => test.failureMessages.some(message => message.includes('AssertionError')))))) throw new Error(`${name} did not produce an actual loaded semantic AssertionError.`)
  return { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests }
}
const receipt = { slice, scope: 'Source qualification only; GUI restart and independent visual review remain required.', before, directory: relative(root, directory), phases }
try {
  // The canonical Vitest setup requires fresh normal Core artifacts.
  // Consume that shared producer; this Renderer-only proof must not clear its concurrent dist.
  receipt.owning = tests('owning', 'apps/desktop/scripts/fixtures/focus-project-history/vitest.owning.config.mts')
  receipt.mutations = []
  for (const mutation of ['window-filter', 'current-members', 'historical-owner', 'presence-cost']) {
    const result = tests(`mutation-${mutation}`, 'apps/desktop/scripts/fixtures/focus-project-history/vitest.mutation.config.mts', { red: true, env: { AGENTMUX_FOCUS_HISTORY_MUTATION: mutation } })
    if (result.total !== receipt.owning.total) throw new Error(`${mutation} changed the test population.`)
    receipt.mutations.push({ mutation, ...result })
  }
  receipt.restored = tests('restored', 'apps/desktop/scripts/fixtures/focus-project-history/vitest.owning.config.mts')
  receipt.adjacent = tests('adjacent', 'apps/desktop/scripts/fixtures/focus-project-history/vitest.adjacent.config.mts')
  run('production-types', ['pnpm', '--filter', '@agentmux/desktop', 'typecheck'])
  run('owning-types', ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/focus-project-history/tsconfig.owning.json'])
  const callers = {
    observeFocusHistoryIdentity: ['apps/desktop/src/renderer/src/store.ts', 'observeFocusHistoryIdentity(session,'],
    groupFocusTimeline: ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'groupFocusTimeline(contexts,'],
    RecentFocusTimeline: ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', '<RecentFocusTimeline ']
  }
  receipt.callers = Object.fromEntries(Object.entries(callers).map(([symbol, [file, invocation]]) => {
    const content = readFileSync(resolve(root, file), 'utf8'), start = content.indexOf(invocation)
    if (start < 0) throw new Error(`${symbol} has no non-definition production caller.`)
    return [symbol, { file, line: content.slice(0, start).split('\n').length, invocation }]
  }))
  receipt.after = binding()
  for (const path of sourcePaths) if (before[path] !== receipt.after[path]) throw new Error(`${path} changed during qualification; original evidence retained, rerun on a stable own Source slice.`)
  receipt.sourcePass = true
  receipt.taskDone = false
  receipt.pending = ['ordinary private GUI restart with exact delivery binding', 'actual wide/narrow interaction and independent visual review']
  if (!args.includes('--source-only')) {
    const guiFile = process.env.AGENTMUX_FOCUS_PROJECT_HISTORY_GUI_RECEIPT
    const reviewFile = process.env.AGENTMUX_FOCUS_PROJECT_HISTORY_VISUAL_REVIEW
    if (!guiFile || !reviewFile) throw new Error('Source qualified; supply the sealed actual GUI receipt and independent image review for final qualification. This Task remains active.')
    const guiBytes = readFileSync(resolve(root, guiFile)), gui = JSON.parse(guiBytes)
    const reviewBytes = readFileSync(resolve(root, reviewFile)), review = JSON.parse(reviewBytes)
    if (gui.schema !== 'agentmux.focus-project-history-gui.v1' || gui.passed !== true || gui.phases?.length !== 2 || gui.phases[0].actual.pid === gui.phases[1].actual.pid || gui.originalRuns?.length !== 3 || JSON.stringify(gui.originalRuns) !== JSON.stringify(gui.survivingRuns)) throw new Error('Final GUI qualification requires two ordinary processes and exact surviving private Run/PID facts.')
    run('gui-main-ancestry', ['git', 'merge-base', '--is-ancestor', gui.candidate, 'HEAD'])
    for (const path of sourcePaths) if (gui.inputs?.[path] !== before[path] || gui.inputsAfter?.[path] !== before[path]) throw new Error(`${path} differs from the actual complete Main GUI cut; recapture this slice rather than signing stale bytes.`)
    if (!gui.cleanup?.privateRootRemoved || gui.cleanup.errors?.length || gui.cleanup.remaining?.length) throw new Error('Private GUI/profile/Run cleanup remains incomplete.')
    if (review.schema !== 'agentmux.focus-project-history-visual-review.v1' || review.verdict !== 'pass' || typeof review.reviewerAgentId !== 'string' || !review.reviewerAgentId || review.guiReceiptSha256 !== sha(guiBytes) || !Array.isArray(review.viewedImages) || review.viewedImages.length !== gui.visualPaths?.length || review.viewedImages.length < 6) throw new Error('Independent review must identify the exact GUI receipt and every real wide/fold/narrow image; capture success alone is insufficient.')
    for (const image of gui.visualPaths) {
      const expected = sha(readFileSync(resolve(gui.sourceRoot, image)))
      if (!review.viewedImages.some(viewed => viewed.path === image && viewed.sha256 === expected && typeof viewed.observation === 'string' && viewed.observation.trim().length > 0)) throw new Error(`${image} lacks an actual nonempty independent image observation on these bytes.`)
    }
    receipt.gui = { file: guiFile, sha256: sha(guiBytes), candidate: gui.candidate, compiled: gui.compiled, originalRuns: gui.originalRuns, phases: gui.phases.map(phase => ({ phase: phase.phase, pid: phase.actual.pid })) }
    receipt.visualReview = { file: reviewFile, sha256: sha(reviewBytes), reviewerAgentId: review.reviewerAgentId, viewedImages: review.viewedImages }
    receipt.taskDone = true
    receipt.pending = []
    receipt.scope = 'Exact retained-focus slice and bound complete Main GUI cut; not installation, native archived Agent body, full Focus or upstream Provider Writer sign-off.'
  }
  writeFileSync(resolve(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`Source qualification: ${relative(root, resolve(directory, 'receipt.json'))}`)
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error)
  writeFileSync(resolve(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.error(receipt.error)
  process.exitCode = 1
}

async function verifyCompleteHistory() {
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const output = resolve(root, process.env.AGENTMUX_FOCUS_CLOSED_OUTPUT ?? `.tmp/focus-closed-session-history-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const paths = [
    'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx',
    'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx',
    'apps/desktop/src/renderer/src/lib/focus-history-sources.ts',
    'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts',
    'apps/desktop/src/renderer/src/lib/focus-history-identity.ts',
    'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
    'apps/desktop/src/renderer/src/lib/workbench-view-close.ts',
    'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts',
    'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts',
    'apps/desktop/src/renderer/src/styles/focus.css',
    'apps/desktop/test/focus-closed-session-history.test.tsx',
    'apps/desktop/scripts/fixtures/focus-project-history/vitest.closed-session.config.mts',
    'apps/desktop/scripts/fixtures/focus-project-history/tsconfig.closed-session.json',
    'apps/desktop/scripts/verify-focus-closed-session-history-gui.mjs',
    'apps/desktop/scripts/verify-focus-project-history.mjs'
  ]
  const bind = () => Object.fromEntries(paths.map(path => [path, digest(readFileSync(resolve(root, path)))]))
  const receipt = { schema: 'agentmux.focus-closed-session-history-qualification.v1', slice: 'complete-history',
    passed: false, sourcePass: false, taskDone: false, before: bind(), stages: [],
    boundary: 'Public Core/private Runtime/actual Run, built-in Reader, production registered IPC/preload and mounted Workbench/Focus owning. GUI qualification requires separately bound two ordinary complete-Main processes and independent actual images. Not upstream Vendor writer, full Focus, packaging or user installation.' }
  const save = () => writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  function command(label, argv, mutation) {
    const report = resolve(output, `${label}.json`), loaded = resolve(output, `${label}.loaded.jsonl`)
    const env = { ...process.env, AGENTMUX_FOCUS_CLOSED_LOADED_SOURCE: loaded }
    delete env.AGENTMUX_FOCUS_CLOSED_MUTATION
    if (mutation) env.AGENTMUX_FOCUS_CLOSED_MUTATION = mutation
    const actual = argv ?? [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config',
      'apps/desktop/scripts/fixtures/focus-project-history/vitest.closed-session.config.mts', '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
    const result = spawnSync(actual[0], actual.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    writeFileSync(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
    const stage = { label, command: actual, exitCode: result.status, error: result.error?.message, mutation: mutation ?? null }
    receipt.stages.push(stage); save()
    if (argv) {
      if (result.status !== 0) throw new Error(`${label}: failed; original output retained`)
    } else {
      const tests = JSON.parse(readFileSync(report)), assertions = tests.testResults.flatMap(file => file.assertionResults)
      if (!assertions.length) throw new Error(`${label}: nonempty actual assertions required`)
      const modules = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      const relevant = modules.filter(item => Object.hasOwn(receipt.before, item.path))
      if (!relevant.length) throw new Error(`${label}: no product module actually loaded`)
      for (const item of relevant) if (item.originalSHA256 !== receipt.before[item.path]) throw new Error(`Moving Source: ${item.path}`)
      Object.assign(stage, { population: assertions.length, passed: tests.numPassedTests, failed: tests.numFailedTests,
        reportSHA256: digest(readFileSync(report)), loadedSHA256: digest(readFileSync(loaded)) })
      if (mutation) {
        const changed = relevant.filter(item => item.mutation === mutation && item.sha256 !== item.originalSHA256)
        const failed = assertions.filter(item => item.status === 'failed')
        if (result.status === 0 || !changed.length || !failed.length || failed.some(item => !item.failureMessages.some(message => message.includes('AssertionError')))) throw new Error(`${label}: actual loaded semantic AssertionRED required`)
        stage.loadedMutants = changed; stage.assertionFailures = failed.map(item => item.fullName)
      } else {
        if (result.status !== 0 || !tests.success || assertions.some(item => item.status !== 'passed')) throw new Error(`${label}: all nonempty actual product assertions must pass`)
        for (const item of relevant) if (item.sha256 !== item.originalSHA256) throw new Error(`${label}: restored Source must actually load`)
      }
    }
    save(); console.log(`${label}: actual exit ${result.status}`)
    return stage
  }
  function artifact(environment) {
    const file = process.env[environment]
    if (!file) throw new Error(`${environment}: exact actual receipt required; Source alone is not whole Task`)
    const bytes = readFileSync(resolve(root, file))
    return { path: resolve(root, file), sha256: digest(bytes), value: JSON.parse(bytes) }
  }
  try {
    const baseline = command('owning')
    for (const mutation of ['readonly-disconnected', 'current-members-only', 'equal-body-merge']) {
      if (command(mutation, undefined, mutation).population !== baseline.population) throw new Error(`${mutation}: changed population`)
      if (command(`${mutation}-exact-restore`).population !== baseline.population) throw new Error(`${mutation}: restore changed population`)
    }
    command('retired-reader-adjacent', [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config',
      'apps/desktop/scripts/fixtures/focus-project-history/vitest.renderer-history.config.mts', '--maxWorkers=1'])
    command('production-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
    command('owning-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/focus-project-history/tsconfig.closed-session.json'])
    const seams = {
      historyCatalogue: ['apps/desktop/src/main/ipc.ts', "args.runtime.sessionHistorySources()"],
      readonlyPage: ['apps/desktop/src/main/ipc.ts', 'args.runtime.sessionHistoryPage(session, options, config)'],
      actualTabClose: ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'await closeTab(workspaceId, group.id, tabId, { keepAgentSessions })'],
      stopOwner: ['apps/desktop/src/renderer/src/store.ts', 'await api.sessions.stop(resource.control)'],
      pureProjector: ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'projectSessionUserMessages({'],
      productionTimeline: ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', '<RecentFocusTimeline ']
    }
    receipt.callers = Object.fromEntries(Object.entries(seams).map(([name, [path, needle]]) => {
      const source = readFileSync(resolve(root, path), 'utf8'), index = source.indexOf(needle)
      if (index < 0) throw new Error(`${name}: nondefinition product caller missing`)
      return [name, { path, needle, line: source.slice(0, index).split('\n').length }]
    }))
    receipt.sourcePass = true; save()
    if (args.includes('--source-only')) receipt.pending = ['Two bound ordinary complete-Main GUI processes, three healthy Run/PID/ACK and actual independent image review']
    else {
      const gui = artifact('AGENTMUX_FOCUS_CLOSED_GUI_RECEIPT'), review = artifact('AGENTMUX_FOCUS_CLOSED_VISUAL_REVIEW')
      if (!gui.value.passed || gui.value.schema !== 'agentmux.focus-closed-session-history-gui.v1') throw new Error('An actual complete-history GUI receipt is required')
      if (gui.value.processes.length !== 2 || gui.value.processes[0].pid === gui.value.processes[1].pid || gui.value.processes[1].seedCount !== 0) throw new Error('Two ordinary processes and zero second seed required')
      if (gui.value.healthyRuns.length !== 3 || gui.value.healthyRuns.some(run => !run.sameId || !run.samePid || !run.ack)) throw new Error('Three actual healthy original Run/PID/ACK receipts required')
      if (gui.value.historyControlDelta.create || gui.value.historyControlDelta.resume || gui.value.historyControlDelta.stop) throw new Error('Readonly history must not control archived Runs')
      if (!gui.value.defaultCloseRetired || !gui.value.keepSessionPreserved || !gui.value.neverFocusedArchivedSource || !gui.value.restoredBodyAndLayout) throw new Error('Actual ordinary close, native/captured and restore facts required')
      for (const path of paths.slice(0, 13)) if (gui.value.source[path] !== receipt.before[path]) throw new Error(`GUI/Source mismatch: ${path}`)
      command('gui-main-ancestry', ['git', 'merge-base', '--is-ancestor', gui.value.candidate, 'HEAD'])
      if (!gui.value.cleanup?.privateRootRemoved || gui.value.cleanup.errors?.length || gui.value.cleanup.remainingOwnedProcesses?.length) throw new Error('Ordinary private GUI cleanup must complete without remaining processes')
      if (!gui.value.compile?.candidate || gui.value.compile.candidate !== gui.value.candidate) throw new Error('Ordinary GUI must consume its exact complete-Main build candidate')
      if (review.value.verdict !== 'pass' || !review.value.reviewerAgentId || review.value.sceneReceiptSHA256 !== gui.sha256) throw new Error('Independent exact ordinary GUI review required')
      if (gui.value.images.length < 4) throw new Error('Nonempty actual wide/narrow ordinary GUI images required')
      for (const image of gui.value.images) {
        const file = resolve(gui.path, '..', image.path)
        if (digest(readFileSync(file)) !== image.sha256 || !review.value.viewedImages.some(viewed => viewed.sha256 === image.sha256 && viewed.observation?.trim())) throw new Error(`${image.path}: exact actual independent image observation required`)
      }
      receipt.gui = gui; receipt.visualReview = review; receipt.taskDone = true
    }
    receipt.after = bind()
    if (JSON.stringify(receipt.before) !== JSON.stringify(receipt.after)) throw new Error('Owned complete-history Source moved during qualification')
    receipt.passed = true
  } catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
  finally { save(); console.log(JSON.stringify({ sourcePass: receipt.sourcePass, passed: receipt.passed, taskDone: receipt.taskDone, receipt: relative(root, resolve(output, 'receipt.json')) })) }
}
