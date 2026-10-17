import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Consume explicitly selected immutable observations, without replaying them. */
export async function verifyQualifiedPresence({ root, input, receiptPath }) {
  const git = (args, input) => execFileSync('git', args, { cwd: root, input, maxBuffer: 128 * 1024 * 1024 })
  const candidate = git(['rev-parse', 'HEAD']).toString().trim()
  const output = join(dirname(receiptPath), 'joined-' + randomUUID())
  await mkdir(output, { recursive: true })
  try { await stat(receiptPath); assert.fail('Preserve the existing receipt and select a fresh qualified output') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const receipt = { schema: 'agentmux.browser-operator-presence.qualified.v1', candidate, passed: false, taskComplete: false,
    mode: 'qualified-proof-join', inputs: {}, sources: {}, sourceDifferences: [], externalInputs: {}, sharedSourceMutations: 0,
    boundary: 'Current committed product sources joined to exact historical native/unit observations, a current real Renderer chain, private compiled Core, and an independently reviewed OS capture. No observation or diagnostic receipt is rewritten; no Browser, Run or opinion is created.' }
  const records = new Map()
  async function record(name, descriptor) {
    assert.ok(descriptor && isAbsolute(descriptor.path) && /^[0-9a-f]{64}$/u.test(descriptor.sha256), 'Explicit artifact path and SHA: ' + name)
    const bytes = await readFile(descriptor.path)
    assert.equal(sha(bytes), descriptor.sha256, 'Original artifact identity: ' + name)
    records.set(descriptor.path, descriptor.sha256)
    receipt.inputs[name] = { path: descriptor.path, sha256: descriptor.sha256 }
    await writeFile(join(output, name + '.json'), bytes)
    return JSON.parse(bytes)
  }
  try {
    receipt.verificationSources = {}
    for (const path of [fileURLToPath(import.meta.url), join(root, 'apps/desktop/scripts/verify-browser-operator-presence.mjs')]) {
      const digest = sha(await readFile(path)); records.set(path, digest); receipt.verificationSources[relative(root, path)] = digest
    }
    const bytes = await readFile(input), selection = JSON.parse(bytes)
    records.set(input, sha(bytes)); receipt.selection = { path: input, sha256: sha(bytes) }
    await writeFile(join(output, 'selection.json'), bytes)
    assert.equal(selection.schema, 'agentmux.browser-operator-presence.qualified-input.v1')
    const native = await record('native', selection.native), os = await record('os', selection.os)
    const renderer = await record('current-renderer', selection.currentRenderer), core = await record('current-core-build', selection.currentCoreBuild)
    const equivalence = await record('equivalence-review', selection.equivalenceReview)
    const manifest = await record('os-manifest', selection.osManifest), visual = await record('os-review', selection.osReview)
    assert.equal(native.schema, 'agentmux.browser-operator-presence.v1'); assert.equal(native.passed, true); assert.equal(native.diagnostic, false)
    assert.deepEqual(native.sourceDrift, []); assert.equal(native.sharedSourceMutations, 0)
    assert.equal(native.cleanup.privateRootRemoved, true)
    assert.ok(native.nativeProcesses.every(process => process.cleanupConfirmed && process.exitConfirmed && !process.timedOut && process.exitSignal === null))
    assert.equal(native.runs.length, 6)
    for (const row of native.runs) {
      const original = await record('native-' + row.label, { path: row.receipt, sha256: row.sha256 })
      assert.deepEqual(original, row.actual)
      assert.equal(original.cleanupComplete, true); assert.deepEqual(original.cleanup, [])
      if (row.mutation) {
        assert.equal(row.owningAssertion.status, 'AssertionRED'); assert.equal(original.failure.name, 'AssertionError')
        assert.ok(original.failure.message.includes(row.owningAssertion.message))
        assert.notEqual(row.transformation.before, row.transformation.after)
        assert.equal(row.transformation.before, native.sources[row.transformation.file].sha256)
      } else {
        assert.equal(original.passed, true); assert.equal(original.cases.length, 16)
        assert.ok(original.cases.every(test => test.passed))
      }
    }
    assert.deepEqual(native.runs.filter(row => !row.mutation).map(row => row.label), ['baseline', 'restored'])
    const unit = await record('unit', { path: native.unit.receipt, sha256: native.unit.sha256 })
    assert.deepEqual(unit, native.unit.actual); assert.equal(unit.passed, true); assert.equal(unit.sourceUnchanged, true)
    assert.equal(unit.sharedSourceMutations, 0); assert.equal(unit.runs.length, 9)
    for (const row of unit.runs) {
      assert.equal(row.total, 75)
      const originalResult = await readFile(row.resultPath)
      receipt.unitResults ??= []
      receipt.unitResults.push({ path: row.resultPath, observedSha256: sha(originalResult), boundary: 'Result reachable now; its source-time identity is the original pinned unit receipt, which did not record individual result-file digests.' })
      if (row.transformation) {
        assert.notEqual(row.exitCode, 0); assert.ok(row.failed.length > 0)
        // The original unit verifier qualified the owning AssertionRED. A
        // mutation may also break a later observation; retain those failures.
        assert.ok(row.failed.some(test => test.messages.some(message => message.includes('AssertionError'))))
        assert.notEqual(row.transformation.before, row.transformation.after)
        assert.equal(row.transformation.before, native.sources[row.transformation.source].sha256)
      } else { assert.equal(row.exitCode, 0); assert.deepEqual(row.failed, []) }
    }
    assert.deepEqual(unit.runs.filter(row => !row.transformation).map(row => row.name), ['source', 'restored'])
    const actualRenderer = renderer.runs.find(row => row.label === 'native-baseline')?.actual
    assert.equal(renderer.mode, 'operator-presence'); assert.equal(renderer.presenceDiagnosticComplete, true)
    assert.equal(renderer.passed, false); assert.equal(renderer.sharedTreeMutations, 0); assert.equal(renderer.failure, undefined)
    assert.equal(actualRenderer.passed, true); assert.equal(actualRenderer.presence.passed, true)
    assert.deepEqual(actualRenderer.cleanupFailures, [])
    assert.ok(actualRenderer.ipc.every(call => call.channel !== 'sessions:submitPrompt'))
    const accepted = actualRenderer.presence.accepted
    assert.equal(accepted.exactSender, true); assert.equal(accepted.exactFrame, true); assert.equal(accepted.result, true)
    assert.equal(core.passed, true); assert.equal(core.distIsSymlink, false); assert.deepEqual(core.sourceDrift, [])
    receipt.dependencyManifests = {}
    for (const file of ['pnpm-lock.yaml', 'package.json', 'apps/desktop/package.json', 'packages/core/package.json', 'packages/client-ui/package.json', 'packages/identity/package.json']) {
      const expected = sha(git(['show', native.candidate + ':' + file])), actual = sha(git(['show', candidate + ':' + file]))
      assert.equal(actual, expected, 'Reused dependency resolution remains identical: ' + file)
      receipt.dependencyManifests[file] = actual
    }
    for (const tool of Object.values(core.tools.tools)) assert.equal(sha(await readFile(tool.path)), tool.sha256, 'The exact private build tool remains bound')
    assert.equal(os.diagnostic, true); assert.equal(os.passed, false); assert.equal(os.osDiagnosticComplete, true)
    assert.equal(os.sourceProof.sha256, selection.native.sha256)
    const actualOs = os.runs[0].actual
    assert.equal(actualOs.passed, true); assert.equal(actualOs.captureQualified, true); assert.equal(actualOs.cases.length, 8)
    assert.equal(actualOs.captures.length, 9); assert.deepEqual(actualOs.cleanup, []); assert.equal(actualOs.cleanupComplete, true)
    assert.equal(visual.qualifications.staticOSWindowAesthetics, 'independently-reviewed')
    assert.equal(visual.approved, true, 'The independent review explicitly approved the exact OS images')
    assert.equal(visual.manifestSHA256, selection.osManifest.sha256); assert.equal(visual.files.length, 9)
    assert.equal(visual.nativeWindow.pid, actualOs.pid); assert.equal(visual.nativeWindow.windowId, actualOs.nativeWindowObservation.windowId)
    for (const file of manifest.files) {
      const path = resolve(dirname(selection.osManifest.path), file.file), bytes = await readFile(path)
      assert.equal(sha(bytes), file.sha256, 'Original OS artifact: ' + file.file); records.set(path, file.sha256)
    }
    for (const frame of actualOs.captures) {
      const reviewed = visual.files.find(file => file.sha256 === frame.sha256)
      assert.ok(reviewed?.viewedOriginal && reviewed.edited === false, 'Every exact OS image was independently viewed')
      assert.equal(frame.qualified, true)
      if (frame.before.phase === 'completed') {
        assert.equal(frame.before.avatar.src, accepted.args[0].png)
        assert.equal(frame.after.token, frame.before.token); assert.equal(frame.after.connected, true)
        assert.ok(frame.captureStarted >= frame.before.now && frame.captureCompleted < frame.before.expiresAt && frame.after.now < frame.before.expiresAt,
          'The ordinary completed cue was captured before its original expiry')
      } else { assert.equal(frame.before.connected, true); assert.equal(frame.after.connected, true); assert.equal(frame.after.operationId, frame.before.operationId) }
    }
    assert.equal(actualOs.captures.filter(frame => frame.before.phase === 'completed').length, 1)
    assert.equal(equivalence.reviewed, true); assert.equal(equivalence.passed, true)
    assert.equal(equivalence.nativeProofSha256, selection.native.sha256)
    assert.equal(equivalence.currentRendererSha256, selection.currentRenderer.sha256)
    const aliases = selection.sourceAliases ?? []
    const normalize = file => {
      const alias = aliases.find(alias => file.startsWith(alias.from))
      const mapped = alias ? alias.to + file.slice(alias.from.length) : file
      assert.ok(!isAbsolute(mapped) && !mapped.startsWith('../'), 'A source counterpart must remain inside the selected repository')
      return mapped
    }
    const unchangedOwners = new Set([
      ...native.runs.filter(row => row.mutation).map(row => row.transformation.file),
      ...unit.runs.filter(row => row.transformation).map(row => row.transformation.source),
      ...Object.keys(unit.sourceBefore),
      'apps/desktop/src/main/browser-native-input-shield.ts',
      'apps/desktop/src/shared/browser-agent-control.ts',
      'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx',
      'apps/desktop/src/renderer/src/lib/browser-operator-avatar.tsx',
      'apps/desktop/test/browser-operation-feedback.test.ts',
      'apps/desktop/test/browser-control-feedback.test.ts',
      'apps/desktop/test/browser-page-action-feedback.test.ts'
    ])
    const tracked = new Set(git(['ls-tree', '-rz', '--name-only', candidate]).toString().split('\0').filter(Boolean))
    const required = new Set([...Object.keys(native.sources), ...Object.keys(renderer.sources), ...Object.keys(core.sources)].map(normalize))
    const names = [...required].filter(file => tracked.has(file))
    const blobs = git(['cat-file', '--batch', '--buffer'], names.map(file => candidate + ':' + file).join('\n') + '\n')
    // execFileSync's input must be explicit; read committed bytes, never peer WIP.
    let cursor = 0
    const committed = new Map()
    for (const file of names) {
      const end = blobs.indexOf(10, cursor), header = blobs.subarray(cursor, end).toString(), size = Number(header.split(' ').at(-1))
      assert.ok(header.includes(' blob ') && Number.isSafeInteger(size), 'Committed source blob: ' + file)
      cursor = end + 1; committed.set(file, sha(blobs.subarray(cursor, cursor + size))); cursor += size + 1
    }
    async function current(file) {
      if (committed.has(file)) return committed.get(file)
      if (file.startsWith('packages/core/dist/')) {
        const digest = core.outputs[file]
        assert.ok(digest, 'The actual private Core output is build-bound: ' + file)
        assert.equal(sha(await readFile(resolve(selection.currentCoreBuild.root, file))), digest, 'The selected private compiled Core input remains original: ' + file)
        return digest
      }
      assert.ok(file.includes('/node_modules/') || file.startsWith('node_modules/') || file.includes('/dist/'), 'Nontracked inputs must be explicit dependency artifacts')
      return sha(await readFile(resolve(root, file)))
    }
    for (const [original, input] of Object.entries(native.sources)) {
      const file = normalize(original), digest = await current(file)
      receipt.sources[file] = digest
      if (unchangedOwners.has(file)) assert.equal(digest, input.sha256, 'The reused native/unit/OS owner must be byte-identical: ' + file)
      if (digest === input.sha256) continue
      const verification = ['apps/desktop/scripts/verify-browser-operator-presence.mjs', 'apps/desktop/scripts/fixtures/browser-operator-presence/main.ts'].includes(file)
      const reviewed = equivalence.changes.find(change => change.original === original && change.before === input.sha256 && change.after === digest)
      if (!verification) {
        assert.ok(reviewed, 'Every changed product input has a precise reviewed SHA pair: ' + file)
        assert.equal(renderer.sources[file], digest, 'A changed input is covered by the current real Renderer chain: ' + file)
      }
      receipt.sourceDifferences.push({ file, before: input.sha256, after: digest, coverage: verification ? 'historical-verification-code' : 'reviewed-current-renderer' })
    }
    for (const [original, digest] of Object.entries(renderer.sources)) {
      const file = normalize(original)
      assert.equal(await current(file), digest, 'Current Renderer input matches this committed product or build: ' + file)
      receipt.sources[file] = digest
    }
    assert.ok([...unchangedOwners].every(file => receipt.sources[file]), 'Every reused owning consumer is bound')
    for (const [file, digest] of Object.entries(core.sources)) {
      if (file.startsWith('packages/core/test/')) continue // tsconfig.build excludes tests.
      assert.equal(await current(file), digest, 'The private Core build uses this committed source: ' + file)
    }
    for (const [file, digest] of Object.entries(native.externalInputs)) {
      const alias = selection.externalAliases.find(alias => file.startsWith(alias.from))
      assert.ok(alias, 'Explicit current counterpart for each external input')
      const counterpart = resolve(root, alias.to, file.slice(alias.from.length))
      assert.equal(sha(await readFile(counterpart)), digest, 'Original external dependency matches the current counterpart')
      receipt.externalInputs[relative(root, counterpart)] = digest
    }
    for (const [path, digest] of records) assert.equal(sha(await readFile(path)), digest, 'Selected artifact remained immutable')
    assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), candidate, 'The target commit remained fixed')
    receipt.workingTreeStatus = git(['status', '--porcelain']).toString().trim().split('\n').filter(Boolean)
    receipt.sourceMode = 'committed-tree'; receipt.currentCoreBuild = { candidate: core.candidate, coreTree: core.coreTree, actualCompiledInputs: Object.keys(renderer.sources).filter(file => file.startsWith('packages/core/dist/')) }
    receipt.qualifications = { nativeSource: 16, nativeMutants: 4, nativeRestored: 16, unitSource: 75, unitMutants: 7, unitRestored: 75,
      currentRenderer: true, osContexts: 8, osCaptures: 9, independentOSVisualReview: true, physicalInput: 'not-tested', ordinaryRestart: 'not-this-task' }
    receipt.passed = true; receipt.taskComplete = true
  } catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ passed: receipt.passed, taskComplete: receipt.taskComplete, receipt: receiptPath }))
  return receipt
}
