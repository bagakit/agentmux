import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const components = 'apps/desktop/src/renderer/src/components/'
const library = 'apps/desktop/src/renderer/src/lib/'
const feedback = components + 'AgentOperationFeedback.tsx'
const communication = components + 'FocusCommunicationFeedback.tsx'
const index = library + 'focus-list-activity.ts'
const surface = components + 'GlobalFocusSurface.tsx'
const css = 'apps/desktop/src/renderer/src/styles/agent-operation-feedback.css'
const focusCss = 'apps/desktop/src/renderer/src/styles/focus.css'
export const listFeedbackSources = [surface, components + 'FocusContextCards.tsx', components + 'FocusContextCardBody.tsx', components + 'FocusContextRow.tsx', feedback, communication,
  index, library + 'use-collaboration-reading.ts', css, focusCss]
export const listFeedbackMutations = [
  { label: 'real-list-active-subscription', file: surface, before: 'useCollaborationActivity(activityScope, visible && documentActive)', after: 'useCollaborationActivity(activityScope, false)' },
  { label: 'real-card-chain-consumes-activity', file: surface, before: 'goalLinks={goalLinks} identities={contextIdentities} activity={listActivity} onSelect={focusExecutionSession}', after: 'goalLinks={goalLinks} identities={contextIdentities} onSelect={focusExecutionSession}' },
  { label: 'exact-host-session-key', file: index, before: 'hostId: context.control?.hostId ?? context.hostId', after: "hostId: 'other-host'" },
  { label: 'message-direction-is-not-reversed', file: index, before: "agentSessionId === pulse.sender ? 'sent' : 'received'", after: "agentSessionId === pulse.sender ? 'received' : 'sent'" },
  { label: 'supervision-is-not-a-send', file: index, before: "pulse.kind === 'supervision' ? 'updated'", after: "false ? 'updated'" },
  { label: 'unrelated-activity-retains-references', file: index, before: 'held?.pulse === pulse && held.direction === direction ? held', after: 'false ? held' },
  { label: 'visible-return-keeps-original-phase', file: communication, before: 'Math.min(0, activity.pulse.startedAt - Date.now())', after: '0' },
  { label: 'visible-owner-replaces-only-the-motion-mark', file: communication, before: '<span key={`${activity.pulse.id}:${visible}`} className="focus-communication-feedback__mark"', after: '<span key={activity.pulse.id} className="focus-communication-feedback__mark"' },
  { label: 'close-is-immediately-inert', file: feedback, before: 'inert={!open} aria-hidden={!open}', after: 'inert={false} aria-hidden={!open}' },
  { label: 'close-returns-inside-focus-only', file: feedback, before: 'if (!next && !compact && content.current?.contains(content.current.ownerDocument.activeElement)) trigger.current?.focus({ preventScroll: true })', after: 'if (false) trigger.current?.focus({ preventScroll: true })' },
  { label: 'only-visible-communication-moves', file: css, before: ".focus-communication-feedback[data-motion-active='true'] .focus-communication-feedback__mark { animation-play-state: running; }", after: ".focus-communication-feedback[data-motion-active='false'] .focus-communication-feedback__mark { animation-play-state: running; }" },
  { label: 'pending-motion-wrapper-keeps-accent', file: css, before: '.agent-operation-feedback__label > :is(svg, .semantic-icon-motion) { flex: none; color: var(--operation-accent); }', after: '.agent-operation-feedback__label > svg { flex: none; color: var(--operation-accent); }' },
  { label: 'feedback-siblings-keep-the-original-button-at-natural-height', file: focusCss, before: '.focus-context-card > .focus-context:only-child { height: 100%; }', after: '.focus-context-card > .focus-context { height: 100%; }' }
]

async function verify() {
  const root = resolve(import.meta.dirname, '../../..')
  const config = 'apps/desktop/test/vitest.focus-list-feedback.config.mts'
  const test = 'apps/desktop/test/focus-list-feedback.test.tsx'
  const self = 'apps/desktop/scripts/verify-focus-list-feedback-mutations.mjs'
  const digest = value => createHash('sha256').update(value).digest('hex')
  const inputs = [...listFeedbackSources, config, test, self]
  const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(root, file)))])))
  const sourceBefore = await hashes()
  assert.ok(listFeedbackMutations.length > 0)
  for (const mutation of listFeedbackMutations) assert.equal((await readFile(join(root, mutation.file), 'utf8')).split(mutation.before).length, 2, mutation.label + ' has one actual source target')
  if (process.env.AGENTMUX_LIST_FEEDBACK_RECEIPT !== undefined) {
    assert.ok(process.env.AGENTMUX_LIST_FEEDBACK_RECEIPT.trim(), 'An explicit receipt path must not be empty')
    const path = resolve(process.env.AGENTMUX_LIST_FEEDBACK_RECEIPT)
    const bytes = await readFile(path), saved = JSON.parse(bytes)
    assert.equal(saved.schema, 'agentmux.focus-list-source-mutations.v1'); assert.equal(saved.passed, true)
    assert.deepEqual(saved.cases?.map(({ label, file, before, after }) => ({ label, file, before, after })), listFeedbackMutations,
      'Saved mutation definitions must match every current case')
    assert.deepEqual(saved.sourceBefore, sourceBefore, 'Saved mutation inputs must match current bytes')
    assert.deepEqual(saved.sourceAfter, sourceBefore, 'Saved mutation inputs must remain unchanged')
    assert.equal(saved.sharedTreeMutations, 0); assert.deepEqual(saved.sharedWrites, []); assert.deepEqual(saved.runtimeControl, [])
    assert.equal(saved.cleanup?.length, 1 + 2 * listFeedbackMutations.length)
    assert.ok(saved.cleanup.every(item => item.cacheRemoved === true), 'Every test cache must be removed')
    const directory = dirname(path)
    async function phase(result, label, mutation = null) {
      assert.equal(result.signal, null)
      assert.equal(result.log, label + '.log'); assert.equal(result.loaded, label + '-loaded.jsonl'); assert.equal(result.executed, label + '-executed.jsonl')
      const output = await readFile(join(directory, result.log), 'utf8'); assert.ok(output.trim())
      let passed = null
      if (mutation) {
        assert.ok(Number.isInteger(result.exit) && result.exit > 0)
        assert.match(output, /AssertionError/); assert.match(output, /Tests\s+[1-9]\d* failed/)
      } else {
        assert.equal(result.exit, 0)
        passed = output.match(/Tests\s+([1-9]\d*) passed/)
        assert.ok(passed, 'Restored and baseline logs must contain active passing tests')
        assert.doesNotMatch(output, /Tests\s+[1-9]\d* failed/)
      }
      for (const file of [result.loaded, result.executed]) {
        const proof = (await readFile(join(directory, file), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        assert.ok(proof.length > 0, 'Loaded and executed evidence must not be empty')
        for (const item of proof) {
          assert.ok(listFeedbackSources.includes(item.file), 'Only original List source evidence is accepted')
          const changed = mutation?.file === item.file
          const expected = changed ? digest((await readFile(join(root, item.file), 'utf8')).replace(mutation.before, mutation.after)) : sourceBefore[item.file]
          assert.equal(item.originalSHA256, sourceBefore[item.file]); assert.equal(item.loadedSHA256, expected)
          assert.equal(item.mutation, changed ? mutation.label : null)
        }
        for (const target of mutation ? [mutation.file] : listFeedbackSources)
          assert.ok(proof.some(item => item.file === target), 'Actual source must load and execute: ' + target)
      }
      return passed ? Number(passed[1]) : null
    }
    const baseline = await phase(saved.baseline, 'baseline-green')
    for (const item of saved.cases) {
      await phase(item.red, item.label + '-red', item)
      assert.equal(await phase(item.restored, item.label + '-restored-green'), baseline, 'Every restoration must run the original active test set')
    }
    assert.deepEqual(await hashes(), sourceBefore, 'Current inputs must stay unchanged during receipt verification')
    console.log(JSON.stringify({ passed: true, exactEvidenceReused: true, cases: saved.cases.length, receipt: path, receiptSHA256: digest(bytes) }))
    return
  }
  const parent = process.env.AGENTMUX_LIST_FEEDBACK_EVIDENCE ?? join(root, '.tmp/focus-list-feedback-mutations')
  await mkdir(parent, { recursive: true })
  const evidence = await mkdtemp(join(parent, 'run-'))
  const receipt = { schema: 'agentmux.focus-list-source-mutations.v1', passed: false, sourceBefore, cases: [], sharedTreeMutations: 0, sharedWrites: [], runtimeControl: [], cleanup: [] }
  const run = async (label, mutation = null) => {
    const cache = await mkdtemp(join(tmpdir(), 'amux-list-test-cache-'))
    const loaded = join(evidence, label + '-loaded.jsonl'), executed = join(evidence, label + '-executed.jsonl')
    await writeFile(loaded, ''); await writeFile(executed, '')
    let result
    try {
      result = await new Promise((accept, reject) => {
        const child = spawn(join(root, 'node_modules/.bin/vitest'), ['run', '--config', config, test, '--maxWorkers=1'], {
          cwd: root, env: { ...process.env, AGENTMUX_LIST_MUTATION: mutation ? JSON.stringify(mutation) : '', AGENTMUX_LIST_CACHE: cache,
            AGENTMUX_LIST_LOADED: loaded, AGENTMUX_LIST_EXECUTED: executed }, stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''
        child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
        child.on('error', reject); child.on('close', (code, signal) => accept({ code, signal, output }))
      })
    } finally { await rm(cache, { recursive: true, force: true }); receipt.cleanup.push({ cacheRemoved: true }) }
    await writeFile(join(evidence, label + '.log'), result.output)
    const proof = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const loads = await proof(loaded), executions = await proof(executed)
    assert.ok(loads.length > 0 && executions.length > 0, 'The real production source must load and execute')
    if (mutation) {
      const original = await readFile(join(root, mutation.file), 'utf8'), expected = digest(original.replace(mutation.before, mutation.after))
      assert.ok(loads.some(item => item.file === mutation.file && item.loadedSHA256 === expected && item.mutation === mutation.label), 'Exact mutated source loaded')
      assert.ok(executions.some(item => item.file === mutation.file && item.loadedSHA256 === expected && item.mutation === mutation.label), 'Exact mutated source executed')
    } else for (const file of listFeedbackSources) {
      assert.ok(loads.some(item => item.file === file && item.loadedSHA256 === sourceBefore[file]), 'Original source loaded: ' + file)
      assert.ok(executions.some(item => item.file === file && item.loadedSHA256 === sourceBefore[file]), 'Original source executed: ' + file)
    }
    assert.match(result.output, /Tests\s+[1-9]\d* (?:passed|failed)/)
    return { exit: result.code, signal: result.signal, log: label + '.log', loaded: label + '-loaded.jsonl', executed: label + '-executed.jsonl', output: result.output }
  }
  try {
    const baseline = await run('baseline-green')
    assert.equal(baseline.exit, 0, baseline.output)
    receipt.baseline = { ...baseline, output: undefined }
    for (const mutation of listFeedbackMutations) {
      const red = await run(mutation.label + '-red', mutation)
      assert.ok(red.exit > 0, 'Mutation must fail assertions: ' + mutation.label)
      assert.match(red.output, /AssertionError/); assert.match(red.output, /Tests\s+[1-9]\d* failed/)
      const green = await run(mutation.label + '-restored-green')
      assert.equal(green.exit, 0, green.output)
      receipt.cases.push({ ...mutation, red: { ...red, output: undefined }, restored: { ...green, output: undefined } })
      console.log('LIST_MUTATION ' + mutation.label + ' RED/GREEN')
    }
    receipt.sourceAfter = await hashes(); assert.deepEqual(receipt.sourceAfter, sourceBefore)
    receipt.passed = true
  } finally {
    receipt.sourceAfter = await hashes()
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify({ passed: receipt.passed, cases: receipt.cases.length, evidence, sourceStable: JSON.stringify(receipt.sourceAfter) === JSON.stringify(sourceBefore) }))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verify()
