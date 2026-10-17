import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** One real Provider transaction, composed with the caller's original Main capture owner.
 * api is the candidate's production bundle, so mutations cannot escape through another dist.
 * freeze is the real trusted IPC consumer; it returns only the original capture reference. */
export async function runBrowserInputContextCaptureProvider({ api, apiEntry, root, sourceRoot, node = process.execPath, captures, freeze }) {
  assert.ok(apiEntry, 'A separate Node reader imports the same candidate Core API')
  for (const name of ['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_AGENT_SESSION_STORE', 'AGENTMUX_MESSAGE_QUEUE_PATH']) {
    assert.ok(process.env[name]?.startsWith(root + '/'), 'Provider proof owns its private Runtime and durable paths: ' + name)
  }
  let core, session, mainServer, hostServer, hosted, rpc, sdk
  const output = [], storePath = join(root, 'provider-sessions.json')
  const wait = async (read, label) => {
    const deadline = Date.now() + 20000
    do { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < deadline)
    throw new Error('Private capture Provider observation expired: ' + label)
  }
  try {
    // The shipped CodexProvider talks to the repository's controlled CLI through a real ctxmux PTY.
    // No upstream service or model is called by this proof.
    core = await api.connectLocalAgentMux({ store: new api.AgentMuxFileAgentSessionStore(storePath) })
    core.onEvent(event => { if (event.type === 'terminal-output') output.push(event.data) })
    session = await core.createAgent({ agentSessionId: 'private-capture-recipient', createOperationId: 'private-capture-create',
      providerId: 'codex', executorId: 'codex', workspacePath: root,
      commandOverride: join(sourceRoot, 'packages/core/test/fixtures/fake-codex-cli.mjs'), injectAgentMuxGuide: false,
      env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(root, 'provider-native') } })
    const attached = await core.reattachAgent(session.agentSessionId, 0)
    for (const event of attached.attachment.replay) output.push(event.data)
    await wait(() => core.agentSession(session.agentSessionId).terminalPromptReadiness?.readyThroughByte !== undefined, 'original Provider readiness')
    const prompt = '  Original captured opinion\n<amux>\nAuthored example\n</amux>\n', agentMuxNote = 'Original input note'
    const operationId = 'original-provider-captured-input'
    const reference = await freeze({ agentSessionId: session.agentSessionId, originRun: session.run, operationId, prompt, agentMuxNote })
    const mainPath = join(root, 'capture-main.sock')
    mainServer = new api.AgentMuxControlServer({ socketPath: mainPath, coreClients: () => [{ hostId: 'local', client: core }], inputContextCaptures: captures })
    await mainServer.start()
    const reader = api.createDesktopInputContextCaptureReader({ desktopSocketPath: mainPath, captureHostId: 'local', executionHostId: 'local' })
    const captured = await reader.read(reference)
    assert.ok(captured.record, 'actual public Main owner returned the original capture')
    const cliEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY'].includes(key)))
    let cli, cliError
    try { cli = await promisify(execFile)(node, [join(sourceRoot, 'packages/core/bin/amux'), '--endpoint', `unix://${mainPath}`,
      'browser', 'input', 'inspect', '--host-id', reference.hostId, '--operation-id', reference.operationId], { env: cliEnv }) }
    catch (error) { cliError = error }
    assert.equal(cliError, undefined, 'actual compiled CLI reaches the original Main capture owner')
    assert.deepEqual(JSON.parse(cli.stdout).result, captured, 'actual compiled CLI reads the same original Main record')
    assert.ok(!cli.stdout.includes(prompt) && !cli.stdout.includes(agentMuxNote), 'public capture read does not expose authored body or note')
    const context = captured.record.inputContext, expectedWire = api.composeAgentPrompt(prompt, agentMuxNote, context).text
    const identity = { runtimeId: randomUUID(), ownerInstanceId: randomUUID(), protocolVersion: 2, processId: process.pid, availability: 'connected' }
    hosted = new api.AgentMuxHostedRuntimeService(core, storePath, () => ({ ...identity, ctxmux: core.runtimeIdentity() }), undefined, undefined, reader)
    const hostPath = join(root, 'capture-semantic.sock')
    hostServer = new api.AgentMuxControlServer({ socketPath: hostPath, coreClients: () => [{ hostId: 'local', client: core }], hostedRuntime: () => hosted })
    await hostServer.start()
    rpc = await api.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: hostPath } })
    sdk = await api.connectHostedAgentMux({ rpc })
    let receipt, submitError
    try { receipt = await sdk.submitAgentPrompt({ agentSessionId: session.agentSessionId, expectedRun: session.run, operationId,
      prompt, agentMuxNote, inputContextCapture: reference, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' }) }
    catch (error) { submitError = error }
    assert.equal(submitError, undefined, 'actual Hosted reader reaches original capture')
    assert.ok(receipt?.key, 'Hosted capture input retains the original transaction key')
    const record = await wait(async () => {
      const original = await core.inspectAgentPromptSubmission(receipt.key)
      return original?.admission ? original : null
    }, 'original Core captured input claim')
    const message = record.admission.intent.message
    assert.deepEqual(message.inputContext, context, 'Main scene reached the original Core claim')
    assert.equal(message.inputContextSource, 'host-capture', 'only the original Host reader supplies capture provenance')
    assert.deepEqual(message.inputContextCaptureProof, { reference: captured.record.reference, binding: captured.record.binding, intentDigest: captured.record.intentDigest }, 'original producer proof was frozen with the input')
    assert.equal(message.userContent, prompt, 'capture never rewrites authored bytes')
    assert.equal(message.systemContext, agentMuxNote, 'page data never enters platform instructions')
    assert.equal(message.authorHuman, undefined, 'capture provenance cannot promote an unattributed author')
    assert.equal(message.authorAgentSessionId, undefined)
    assert.equal(record.admission.intent.prompt, expectedWire, 'original Core froze the exact captured Provider wire')
    await wait(() => output.join('').replace(/\r\n/gu, '\n').includes('codex-submit:' + expectedWire.replace(/\r\n/gu, '\n') + ':accepted'), 'actual controlled CLI accepted the original captured Provider payload')
    await wait(() => core.agentSession(session.agentSessionId).terminalPromptReadiness?.readyThroughByte !== undefined, 'Provider is ready after the captured input')
    const accepted = (await core.statusAgent(session.agentSessionId)).run.acceptedInputBytes
    assert.ok(accepted > 0, 'real ctxmux accepted the original Provider input bytes')
    const result = { key: receipt.key, actualProvider: 'shipped CodexProvider', runtime: 'real ctxmux PTY',
      upstream: 'repository controlled fake-codex-cli.mjs subprocess; no upstream service/model',
      reference, inputContext: context, intentDigest: captured.record.intentDigest, acceptedInputBytes: accepted,
      originalWire: record.admission.intent.prompt, sourceFrozen: true, authorUnattributed: true }
    // End every current reader before the new Node process opens the exact same Store and Runtime.
    // Main is offline for this check; its absence cannot rewrite the original producer metadata.
    const expectedPath = join(root, 'capture-provider-original.json')
    await writeFile(expectedPath, JSON.stringify({ key: receipt.key, source: message, wire: expectedWire, acceptedInputBytes: accepted }))
    await sdk.dispose(); sdk = undefined
    await rpc.dispose(); rpc = undefined
    await hostServer.stop(); hostServer = undefined
    await hosted.dispose(); hosted = undefined
    await mainServer.stop(); mainServer = undefined
    await core.dispose(); core = undefined
    const code = `import assert from 'node:assert/strict';
      import {readFile} from 'node:fs/promises';
      import {pathToFileURL} from 'node:url';
      const [entry,storePath,expectedPath]=process.argv.slice(1), api=await import(entry.startsWith('file:')?entry:pathToFileURL(entry).href);
      const expected=JSON.parse(await readFile(expectedPath,'utf8')), key=expected.key;
      const core=await api.connectLocalAgentMux({store:new api.AgentMuxFileAgentSessionStore(storePath)});
      try {
        assert.deepEqual(core.agentSession(key.agentSessionId).run,key.expectedRun,'same original Run survives the Core process boundary');
        const record=await core.inspectAgentPromptSubmission(key);
        assert.deepEqual(record.admission.intent.message,expected.source,'new Node reads the exact original capture proof/context/source');
        assert.equal(record.admission.intent.prompt,expected.wire,'new Node reads the exact frozen Provider wire');
        const mailbox=await core.readAgentInputMailbox({agentSessionId:key.agentSessionId});
        const original=mailbox.items.find(item=>item.kind==='item'&&item.item.kind==='controlled'&&item.item.intent.key.submissionId===key.submissionId);
        assert.ok(original,'new Node finds the original controlled input');
        const source=original.item.intent.source;
        assert.deepEqual(source.inputContextCaptureProof,expected.source.inputContextCaptureProof,'journal keeps the original capture proof without Main');
        assert.deepEqual(source.inputContext,expected.source.inputContext,'journal keeps the original captured scene without Main');
        assert.equal(source.inputContextSource,'host-capture');assert.equal(source.promptWire,expected.wire);
        const bytes=(await core.statusAgent(key.agentSessionId)).run.acceptedInputBytes;
        assert.equal(bytes,expected.acceptedInputBytes,'readonly process recovery never replays original Provider input');
        process.stdout.write(JSON.stringify({pid:process.pid,key,acceptedInputBytes:bytes,sourceFrozen:true,mainOffline:true}));
      } finally {try{await core.stopAgent(key.agentSessionId,key.expectedRun)}finally{await core.dispose()}}
    `
    let read, readError
    try { read = await promisify(execFile)(node, ['--input-type=module', '-e', code, apiEntry, storePath, expectedPath], { env: cliEnv }) }
    catch (error) { readError = error }
    assert.equal(readError, undefined, 'actual separate Node reader restores the original capture proof with Main offline')
    result.separateProcessRead = JSON.parse(read.stdout)
    assert.notEqual(result.separateProcessRead.pid, process.pid, 'the proof reader has a real separate process identity')
    await writeFile(join(root, 'capture-provider-result.json'), JSON.stringify(result, null, 2))
    return result
  } catch (error) {
    await writeFile(join(root, 'capture-provider-failure.json'), JSON.stringify({ error: error.stack ?? String(error),
      session: core && session ? core.agentSession(session.agentSessionId) : null, output: output.join('') }, null, 2))
    throw error
  } finally {
    try { await sdk?.dispose() } finally {
      try { await rpc?.dispose() } finally {
        try { await hostServer?.stop() } finally {
          try { await hosted?.dispose() } finally {
            try { await mainServer?.stop() } finally {
              if (core) {
                try { if (session) await core.stopAgent(session.agentSessionId, core.agentSession(session.agentSessionId).run) }
                finally { await core.dispose() }
              }
            }
          }
        }
      }
    }
  }
}
