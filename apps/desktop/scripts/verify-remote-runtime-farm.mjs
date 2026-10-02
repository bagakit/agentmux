import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runRemoteDesktopProof } from './remote-runtime-native-proof.mjs'
import { desktopInput, importInstalledCore, installSdkConsumer, ownerControl, readFarmInput, repositoryRoot, target, writeReceipt } from './remote-runtime-farm-proof.mjs'

const input = await readFarmInput()
const evidence = path.join(repositoryRoot, '.tmp/remote-runtime-farm', ("run-" + (globalThis.crypto.randomUUID()) + ""))
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-farm-desktop-'))
const receipt = { schema: 'agentmux.remote-runtime-farm-proof.v1', passed: false, transport: 'ssh',
  packageIdentity: input.packageIdentity, sourceIdentity: input.sourceIdentity,
  realProviderQualification: input.qualificationReceiptPath, originalOwner: input.owner,
  limitations: ['Private ordinary Electron processes; no installed user application or user Runtime is touched.',
    'Provider permission and native resume are independently bound by the joined Linux package qualification receipt.'] }
let consumer, client, ownerStopped = false
try {
  await fs.mkdir(evidence, { recursive: true })
  const qualification = JSON.parse(await fs.readFile(input.qualificationReceiptPath, 'utf8'))
  assert.equal(qualification.status, 'qualified', 'The actual Provider qualification must succeed before joining its owner')
  for (const field of ['providerPermission', 'providerHook', 'ordinaryClientRestart', 'sameSessionResume', 'retainedForFederation']) assert.equal(qualification[field], true, field)
  assert.deepEqual([qualification.sessionId, qualification.runId, qualification.pid, qualification.nativeHandle],
    [input.agentSessionId, input.runId, input.pid, input.nativeHandle])
  consumer = await installSdkConsumer(input, evidence)
  const { connectSshAgentMux } = await importInstalledCore(consumer)
  client = await connectSshAgentMux({ target: target(input), expectedRuntimeId: input.expectedRuntimeId })
  const before = await client.statusAgent(input.agentSessionId)
  assert.deepEqual([before.session.agentSessionId, before.run.runId, before.run.pid, before.session.nativeHandle],
    [input.agentSessionId, input.runId, input.pid, input.nativeHandle])
  assert.equal(before.run.state, 'running')
  assert.ok(client.catalog().length > 0, 'The external SDK consumes the remote Provider catalog')
  const history = await client.sessionHistoryPage(input.agentSessionId, { limit: 50,
    commandOverride: input.providerCommand, env: { CODEX_HOME: input.providerSeed } })
  assert.ok(history.items.length > 0, 'The original native transcript is readable through its semantic owner')
  receipt.sdk = { outsideCheckout: true, packageDirectory: consumer.packageDirectory,
    owner: client.runtimeOwnerIdentity(), session: before.session, run: before.run, nativeHistoryItems: history.items.length }
  await client.dispose(); client = undefined
  receipt.desktop = await runRemoteDesktopProof({ privateRoot, evidence: path.join(evidence, 'desktop'), input: desktopInput(input),
    ownerCommand: async operation => {
      if (operation === 'stop') ownerStopped = true
      const value = await ownerControl(input, operation)
      if (operation === 'restart') ownerStopped = false
      return value
    } })
  client = await connectSshAgentMux({ target: target(input), expectedRuntimeId: input.expectedRuntimeId })
  const after = await client.statusAgent(input.agentSessionId)
  assert.deepEqual([after.session.agentSessionId, after.run.runId, after.run.pid, after.session.nativeHandle],
    [input.agentSessionId, input.runId, input.pid, input.nativeHandle])
  assert.equal(after.run.state, 'running')
  receipt.finalOwner = client.runtimeOwnerIdentity()
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  if (ownerStopped) {
    try { await ownerControl(input, 'restart'); ownerStopped = false }
    catch (error) { errors.push(`Private semantic owner recovery: ${error.message}`) }
  }
  try { await client?.dispose() } catch (error) { errors.push(error.message) }
  // The remote scope and its original Agent belong to the joined test coordinator until closeout.
  try { if (consumer) await fs.rm(consumer.root, { recursive: true, force: true }); await fs.rm(privateRoot, { recursive: true, force: true }) }
  catch (error) { errors.push(error.message) }
  receipt.cleanup = { errors, retainedRemoteScope: input.scopeRoot, originalAgentStopped: false }
  await writeReceipt(evidence, receipt)
}
assert.deepEqual(receipt.cleanup.errors, [])
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, receipt: path.join(evidence, 'receipt.json') }))
