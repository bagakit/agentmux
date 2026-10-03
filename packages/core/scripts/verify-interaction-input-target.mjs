import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { qualifySharedMainSource } from './qualify-shared-main-source.mjs'

const execute = promisify(execFile), root = fileURLToPath(new URL('../../../', import.meta.url))
const core = join(root, 'packages/core'), evidence = join(root, '.tmp/verify-interaction-input-target')
const options = process.argv.slice(2)
assert(options.every(option => ['--source', '--mutations', '--native'].includes(option)), 'Unknown interaction proof option')
await mkdir(evidence, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const run = argv => execute(process.execPath, argv, { cwd: root, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' } })
const tests = () => run([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(core, 'scripts/interaction-input-target.vitest.config.mts')])
const build = async () => { const result = await run([join(core, 'scripts/build.mjs')]); await writeFile(join(evidence, 'build.log'), result.stdout + result.stderr) }
const report = { schema: 'agentmux.interaction-input-target.v1', passed: false, callers: [], mutations: [], native: 'not-requested' }
const selected = ['packages/core/src', 'packages/demand/src', 'packages/relay/src', 'packages/core/package.json',
  'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json', 'packages/core/scripts/build.mjs',
  'packages/core/scripts/verify-interaction-input-target.mjs', 'packages/core/scripts/interaction-input-target.vitest.config.mts',
  'packages/core/scripts/qualify-shared-main-source.mjs', 'packages/core/test/interaction-input-target.test.ts',
  'packages/core/test/interaction-input-provider.test.ts', 'packages/core/test/client-interaction-lifecycle.test.ts',
  'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/helpers/hosted-runtime-port.ts',
  'packages/demand/package.json', 'packages/demand/tsconfig.build.json', 'packages/relay/package.json', 'packages/relay/tsconfig.json',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts', 'tsconfig.base.json', 'pnpm-lock.yaml']
const collect = async (path, entries) => {
  const children = await readdir(path, { withFileTypes: true }).catch(error => { if (error.code !== 'ENOTDIR') throw error; return null })
  if (children) for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) await collect(join(path, child.name), entries)
  else entries[relative(root, path)] = sha(await readFile(path))
}
const source = async () => { const entries = {}; for (const path of selected) await collect(join(root, path), entries); return entries }
function method(source, name) {
  const file = ts.createSourceFile('production.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  assert.equal(file.parseDiagnostics.length, 0)
  const found = []; const visit = node => { if (ts.isMethodDeclaration(node) && node.name?.getText(file) === name) found.push(node); ts.forEachChild(node, visit) }; visit(file)
  assert.equal(found.length, 1, `Missing or ambiguous production method ${name}`)
  return { file, node: found[0] }
}
async function qualifyNativeBinding(proof, productSource) {
  const document = async entry => {
    assert(entry && typeof entry.path === 'string' && /^[a-f0-9]{64}$/u.test(entry.sha256), 'Missing exact Native document binding')
    const bytes = await readFile(entry.path)
    assert.equal(sha(bytes), entry.sha256, 'Native document hash changed')
    return JSON.parse(bytes)
  }
  assert.equal(proof.schema, 'agentmux.interaction-input-native-binding.v1')
  assert.equal(proof.passed, true)
  assert.deepEqual(proof.productSource, productSource)
  assert.equal(proof.cases?.length, 2)
  assert.equal(new Set(proof.cases.map(value => value.protocol)).size, 2)
  const review = await document(proof.independentReview)
  assert.equal(review.schema, 'agentmux.interaction-input-native-review.v1')
  assert.equal(review.status, 'approved', 'Native review must be approved')
  assert.deepEqual(review.productSource, productSource)
  const bindings = proof.cases.map(({ protocol, path, sha256, build, sourceJoin }) =>
    ({ protocol, path, sha256, build, ...(sourceJoin ? { sourceJoin } : {}) }))
  assert.deepEqual(review.cases, bindings, 'Review must bind these exact cases and actual build documents')
  const seen = new Set()
  for (const entry of bindings) {
    assert(typeof entry.protocol === 'string' && entry.protocol.length > 0)
    const actual = await document(entry), buildDocument = await document(entry.build)
    assert.equal(actual.passed, true, 'Actual Native case did not pass')
    assert(typeof actual.qualifiedScope === 'string' && actual.qualifiedScope.length > 0, 'Missing actual Native scope')
    assert.equal(actual.userRunTouched, false)
    const build = buildDocument.schema === 'agentmux.private-question-native.v1' ? buildDocument.build : buildDocument
    const buildSource = Object.fromEntries(Object.entries(build.sources).filter(([path]) => path.startsWith('packages/core/src/')))
    if (entry.sourceJoin) {
      const sourceJoin = await document(entry.sourceJoin)
      assert.equal(sourceJoin.schema, 'agentmux.interaction-input-native-source-join.v1', 'Wrong Native Source join schema')
      assert.equal(sourceJoin.status, 'approved', 'Native Source join must be approved')
      const { sourceJoin: _join, ...originalCase } = entry
      assert.deepEqual(sourceJoin.case, originalCase, 'Native Source join binds a different case or build')
      assert.deepEqual(sourceJoin.oldSource, buildSource, 'Native Source join old Source differs from actual build')
      assert.deepEqual(sourceJoin.newSource, productSource, 'Native Source join new Source differs from current product')
      const oldReview = await document(sourceJoin.oldNativeReview)
      assert.equal(oldReview.schema, 'agentmux.interaction-input-native-review.v1', 'Wrong original Native review schema')
      assert.equal(oldReview.status, 'approved', 'Original Native review must be approved')
      assert.deepEqual(oldReview.productSource, buildSource, 'Original Native review Source differs from actual build')
      const matching = oldReview.cases?.filter(value => value.protocol === entry.protocol && value.path === entry.path && value.sha256 === entry.sha256)
      assert.equal(matching?.length, 1, 'Original Native review must bind this exact case')
      assert.deepEqual(matching[0], originalCase, 'Original Native review must bind this exact case and build')
      const newManifest = await document(sourceJoin.newSourceManifest)
      assert(['agentmux.typed-input-source.v1', 'agentmux.typed-input-full-main-actual-source.v1', 'agentmux.prompt-preparation-stage-actual-main-source.v1'].includes(newManifest.schema),
        'Wrong current Native Source manifest schema')
      assert.deepEqual(Object.fromEntries(Object.entries(newManifest.sourceInputs).filter(([path]) => path.startsWith('packages/core/src/'))),
        productSource, 'Current Native Source manifest differs from current product')
    } else assert.deepEqual(buildSource, productSource, 'Actual compiled Native source differs')
    assert(!seen.has(actual.schema), 'Two protocols require distinct actual Native cases'); seen.add(actual.schema)
    if (actual.schema === 'agentmux.typed-response-first-hook-native.v1') {
      assert.equal(buildDocument.schema, 'agentmux.pending-edit-restart-build.v1')
      const facts = actual.firstHookResponse, pending = facts?.afterReturn?.pendingInteraction
      assert.equal(actual.typedResponseFirstHook?.passed, true)
      assert.equal(actual.typedResponseFirstHook.fixtureApprovalPaneWaitUsed, false)
      assert.equal(pending?.request.id, facts.request.id)
      assert.equal(pending?.response?.acknowledged, true); assert.equal(pending.nativeCompleted, undefined)
      assert.equal(facts.completionTransition.expected.pendingInteraction.request.id, facts.request.id)
      assert.equal(facts.completionTransition.expected.pendingInteraction.response.acknowledged, true)
      assert.equal(facts.completionTransition.next.pendingInteraction, undefined)
      assert.equal(facts.completionTransition.next.hookReceipt.eventName, 'PostToolUse')
      assert.deepEqual(facts.completionTransition.next.hookReceipt.run, facts.request.evidence.run)
      assert.equal(facts.nativeEmptyComposer.inspection, 'idle')
      assert.equal(actual.phases?.length, 1)
      const phase = actual.phases[0]; assert.equal(phase.passed, true)
      const native = await readFile(phase.nativePath); assert.equal(sha(native), phase.nativeSha256)
      const rows = native.toString().split('\n').filter(Boolean).map(value => JSON.parse(value))
      assert.equal(rows.filter(row => row.type === 'response_item' && row.payload?.type === 'function_call_output' && row.payload.call_id === facts.request.nativeToolCallId).length, 1)
    } else {
      assert.equal(actual.schema, 'agentmux.private-question-native.v1')
      assert.deepEqual(actual.phases?.map(phase => phase.scenario), ['question', 'ordinary', 'wrong-call'])
      for (const phase of actual.phases) {
        assert.equal(phase.passed, true)
        const native = await readFile(phase.nativePath); assert.equal(sha(native), phase.nativeSha256)
        const rows = native.toString().split('\n').filter(Boolean).map(value => JSON.parse(value))
        if (phase.scenario === 'question') {
          const pending = phase.afterResponse.pendingInteraction
          assert.equal(pending.request.id, phase.request.id); assert.equal(pending.response.acknowledged, true)
          assert.equal(pending.nativeCompleted, undefined)
          assert.deepEqual(phase.afterUnrelated.pendingInteraction.response, pending.response)
          assert.equal(phase.settled.pendingInteraction, undefined)
          assert.equal(rows.filter(row => row.event === 'outcome' && row.callId === phase.request.nativeToolCallId).length, 1)
          assert.equal(rows.filter(row => row.event === 'answer-consumed' && row.callId === phase.request.nativeToolCallId).length, 1)
        } else {
          assert.equal(phase.error?.code, 'AGENT_INTERACTION_UNCONFIRMED')
          assert.equal(phase.afterResponse.pendingInteraction.request.id, phase.request.id)
          assert.equal(phase.afterResponse.pendingInteraction.response, undefined)
          assert.equal(rows.filter(row => row.event === 'answer-consumed').length, 0)
          if (phase.scenario === 'ordinary') assert.equal(phase.ordinaryInputStillAvailable, true)
          else assert.equal(phase.afterRun.acceptedInputBytes, 0)
        }
      }
    }
  }
  return review
}
try {
  report.sharedMain = await qualifySharedMainSource(root, selected)
  report.base = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  report.sourceInputs = await source()
  const sdk = await realpath(join(core, 'node_modules/@ctxmux/sdk'))
  report.sdk = { realPath: sdk, entrySha256: sha(await readFile(join(sdk, 'dist/index.js'))), typesSha256: sha(await readFile(join(sdk, 'dist/index.d.ts'))) }
  for (const tool of ['vitest/vitest.mjs', 'typescript/bin/tsc']) {
    const path = await realpath(join(root, 'node_modules', tool))
    report[tool] = { realPath: path, sha256: sha(await readFile(path)) }
  }
  await build(); report.build = true
  const client = await readFile(join(core, 'src/client.ts'), 'utf8')
  const response = method(client, 'respondAgentInteraction'), native = method(client, 'submitNativeInteractionResponse')
  const body = response.node.getText(response.file), preparation = 'provider.prepareInteractionResponse(', lane = 'this.serializeAgentInput('
  assert(body.includes(preparation) && body.includes(lane) && body.indexOf(preparation) < body.indexOf(lane), 'Typed preparation must precede the input lane')
  const nativeBody = native.node.getText(native.file)
  assert(nativeBody.includes('prepared.verifyCurrentTarget(') && nativeBody.includes('this.screenEvidence.currentCompleteFrame(') && nativeBody.includes('this.kernel.input('), 'Final target qualification must reach the real byte owner')
  report.callers.push({ file: 'packages/core/src/client.ts', caller: 'respondAgentInteraction -> Provider preparation -> submitNativeInteractionResponse -> kernel.input' })
  for (const [path, patterns] of [
    ['packages/core/src/agent-provider.ts', [/definition\.prepareInteractionResponse \? \{ prepareInteractionResponse: definition\.prepareInteractionResponse \}/u]],
    ['packages/core/src/hook-normalizer.ts', [/projectNativeHookToolInvocation\(specification, eventName, payload, context, mainSubject\)/u, /specification\.toolInvocation\?\.\(eventName, flattenNestedPayload\(payload\), context, mainSubject\)/u]],
    ['packages/core/src/agent-interaction.ts', [/nativeHookToolCallId\(payload\) \?\? resolvedToolCallId/u]],
    ['packages/core/src/agent-session-store.ts', [/nativeSessionId: string\(invocation\.nativeSessionId/u, /nativeToolCallId: string\(invocation\.nativeToolCallId/u]],
    ['packages/core/src/providers/codex.ts', [/prepareInteractionResponse: createCodexInteractionResponsePreparation\(interaction\.planResponse\)/u]],
    ['packages/core/src/screen-evidence.ts', [/entry\.evidence\.completeSnapshot/u]],
    ['packages/core/src/hosted-client-contract.ts', [/'respondAgentInteraction'/u]],
    ['packages/core/src/hosted-runtime-service.ts', [/AGENTMUX_HOSTED_METHODS/u, /this\.client\[invocation\.method\]/u, /operation\.apply\(this\.client, invocation\.args\)/u]],
    ['apps/desktop/src/main/runtime-controller.ts', [/\.respondAgentInteraction\(/u, /agentInteractionResponseUnavailableReason\(/u]],
    ['apps/desktop/src/main/ipc.ts', [/'sessions:respondInteraction'/u]],
    ['apps/desktop/src/preload/index.ts', [/'sessions:respondInteraction'/u]],
    ['packages/core/src/public-rpc-service.ts', [/case 'agent\.inspect'/u, /client\.statusAgent\(session\.agentSessionId\)/u, /readAgentContext\(scope\.client/u]],
    ['packages/core/src/rpc-native-codec.ts', [/interactionResponseUnavailableReason !==/u]],
    ['packages/core/src/agentmux-cli-commands.ts', [/'agent\.inspect'/u, /'agent\.context'/u]]
  ]) {
    const text = await readFile(join(root, path), 'utf8')
    for (const pattern of patterns) assert(pattern.test(text), `Missing production caller ${path}: ${pattern}`)
    report.callers.push({ file: path, witnesses: patterns.length })
  }
  assert(report.callers.length >= 10, 'Empty production caller collection cannot qualify')
  const typeConfig = join(evidence, 'typecheck.json')
  await writeFile(typeConfig, JSON.stringify({ extends: join(core, 'tsconfig.json'), compilerOptions: { noEmit: true, composite: false, rootDir: root },
    include: ['interaction-input-target', 'interaction-input-provider', 'client-interaction-lifecycle'].map(name => join(core, 'test', name + '.test.ts')), exclude: [] }, null, 2))
  const types = await run([join(root, 'node_modules/typescript/bin/tsc'), '--project', typeConfig]); await writeFile(join(evidence, 'types.log'), types.stdout + types.stderr); report.owningTypes = true
  const green = await tests(); await writeFile(join(evidence, 'tests.log'), green.stdout + green.stderr)
  assert(/82 passed/u.test(green.stdout)); report.tests = 82
  if (options.includes('--mutations')) {
    const mutations = [
      ['ack-alone-settles', 'src/agent-interaction-state.ts', "pending.response?.acknowledged === true && pending.nativeCompleted?.source === 'native-hook'", 'pending.response?.acknowledged === true || false'],
      ['completion-first-tuple', 'src/client.ts', 'if (pending.response && !agentInteractionResponseSettled(completed))', 'if (false)'],
      ['new-request-drops-old', 'src/client.ts', 'previous.nativeCompleted && (!previous.response || agentInteractionResponseSettled(previous))', 'previous.nativeCompleted'],
      ['cold-claim-does-not-close-health', 'src/client.ts', "run.state.type === 'running' && (acceptedInputBytes === null || acceptedInputBytes < response.inputByteRange.endByte)", 'false'],
      ['ended-original-receipt-query', 'src/client.ts', "const canApply = run.state.type === 'running' && !prior?.acknowledged", 'const canApply = !prior?.acknowledged'],
      ['ended-unknown-does-not-close-health', 'src/client.ts', "if (error instanceof AgentMuxError && error.detail === 'unknown') {\n          // The ended Run", "if (false) {\n          // The ended Run"],
      ['unknown-original-query-reason', 'src/agent-interaction-state.ts', "if (pending.response) return 'The original typed response receipt is unconfirmed. Reconcile its exact response; automatic input is paused.'", "if (false) return 'The original typed response receipt is unconfirmed. Reconcile its exact response; automatic input is paused.'"],
      ['wrong-completion-correlation', 'src/client.ts', ['session.pendingInteraction.request.nativeToolCallId === completion.nativeToolCallId', 'pending.request.nativeToolCallId === completion.nativeToolCallId'], ['true', 'true']],
      ['cached-new-claim-cursor', 'src/client.ts', 'const expectedByte = run.acceptedInputBytes\n        if (expectedByte === null)', 'const expectedByte = this.agentInputCursors.get(session.agentSessionId) ?? run.acceptedInputBytes\n        if (expectedByte === null)'],
      ['rebase-original-input', 'src/client.ts', 'expectedByte: state.inputByteRange.startByte,\n        data\n      })', 'expectedByte: run.acceptedInputBytes ?? state.inputByteRange.startByte,\n        data\n      })'],
      ['duplicate-acked-input', 'src/client.ts', 'if (!state.acknowledged) {\n      if (canApply)', 'if (true) {\n      if (canApply)'],
      ['wrong-request', 'src/client.ts', 'result.target.requestId !== pending.request.id', 'false'],
      ['wrong-native-call', 'src/client.ts', 'result.target.nativeToolCallId !== pending.request.nativeToolCallId', 'false'],
      ['wrong-source', 'src/client.ts', '!result.target.nativeSourceId', 'false'],
      ['wrong-run', 'src/client.ts', '!sameRun(result.target.run, canonical.run)', 'false'],
      ['wrong-input-fence', 'src/client.ts', ['result.target.inputByte !== run.acceptedInputBytes', 'currentRun.acceptedInputBytes !== prepared.target.inputByte'], ['false', 'false']],
      ['wrong-frame-run', 'src/client.ts', '!sameRun(result.target.frame.run, canonical.run)', 'false'],
      ['final-native-check', 'src/client.ts', 'verify && !await prepared.verifyCurrentTarget(', 'false && !await prepared.verifyCurrentTarget('],
      ['after-claim-native-check', 'src/client.ts', 'observeFinalTarget(current, true)', 'observeFinalTarget(current, false)'],
      ['final-runtime-pid', 'src/client.ts', 'currentRun.pid !== qualification.processId', 'false'],
      ['ordinary-composer', 'src/providers/codex-interaction-target.ts', 'if (start < 0) return false', 'if (start < 0) start = 0'],
      ['exact-pane-command', 'src/providers/codex-interaction-target.ts', 'row.trim() === `$ ${cmd}`', 'true'],
      ['writer-pid', 'src/providers/codex-interaction-target.ts', 'writer.pid !== pid', 'false'],
      ['writer-birth', 'src/providers/codex-interaction-target.ts', 'writer.birth !== birth', 'false'],
      ['writer-image', 'src/providers/codex-interaction-target.ts', 'writer.image !== image.identity', 'false'],
      ['multiple-writers', 'src/providers/codex-interaction-target.ts', 'owners.length !== 1', 'false'],
      ['root-birth', 'src/providers/codex-interaction-target.ts', 'await nativeProcessBirth(rootPid, signal) !== rootBirth', 'false'],
      ['provider-forwarding', 'src/agent-provider.ts', 'definition.prepareInteractionResponse ? { prepareInteractionResponse: definition.prepareInteractionResponse }', 'false ? { prepareInteractionResponse: definition.prepareInteractionResponse }'],
      ['hosted-finite-method', 'src/hosted-client-contract.ts', "'respondAgentInteraction', 'setAgentPosture'", "'setAgentPosture'"],
      ['public-current-reason', 'src/client.ts', '...(interactionResponseUnavailableReason ? { interactionResponseUnavailableReason } : {})', '...({})'],
      ['public-reason-codec', 'src/rpc-native-codec.ts', 'p.interactionResponseUnavailableReason !== (responseReason || undefined)', 'false', true]
    ]
    for (const [name, file, before, after, compiled] of mutations) {
      const path = join(core, file), original = await readFile(path, 'utf8')
      let mutated = original
      for (const [needle, replacement] of Array.isArray(before) ? before.map((needle, index) => [needle, after[index]]) : [[before, after]]) {
        assert.equal(mutated.split(needle).length, 2, `Ambiguous mutation ${name}`)
        mutated = mutated.replace(needle, replacement)
      }
      try {
        await writeFile(path, mutated)
        if (compiled) await build()
        const red = await tests().then(value => ({ ...value, code: 0 }), error => error)
        await writeFile(join(evidence, `mutation-${name}.log`), (red.stdout ?? '') + (red.stderr ?? ''))
        assert.notEqual(red.code, 0, `Survived production mutation ${name}`)
        assert(/\d+ failed/u.test(red.stdout + red.stderr), `Mutation did not reach an owning assertion ${name}`)
        report.mutations.push({ name, file, killed: true, originalSha256: sha(original), mutatedSha256: sha(mutated) })
        process.stdout.write(`Killed ${name}\n`)
      } finally {
        const temporary = `${path}.t008-restore-${process.pid}`
        await writeFile(temporary, original); await rename(temporary, path)
        if (compiled) await build()
      }
    }
    const restored = await tests(); assert(/82 passed/u.test(restored.stdout)); await writeFile(join(evidence, 'restored.log'), restored.stdout + restored.stderr)
  }
  assert.deepEqual(await source(), report.sourceInputs, 'Source changed during its proof')
  if (options.includes('--native')) {
    // Native is expensive and owned by a separate approved private harness. Consume its
    // frozen actual receipts instead of starting a second run or substituting Source tests.
    const path = join(evidence, 'native-bound-proof.json'), proof = JSON.parse(await readFile(path, 'utf8'))
    await qualifyNativeBinding(proof, Object.fromEntries(Object.entries(report.sourceInputs).filter(([path]) => path.startsWith('packages/core/src/'))))
    report.native = { path, sha256: sha(await readFile(path)), proof }
  }
  report.passed = true
} catch (error) {
  report.error = { message: String(error), code: error.code, stdout: error.stdout, stderr: error.stderr }
  process.exitCode = 1
} finally { await writeFile(join(evidence, 'verification.json'), JSON.stringify(report, null, 2) + '\n') }
process.stdout.write(JSON.stringify({ passed: report.passed, tests: report.tests, mutations: report.mutations.length, callers: report.callers.length, evidence, error: report.error?.message }) + '\n')
