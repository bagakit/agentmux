import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, open, readFile, writeFile, mkdir, mkdtemp, realpath, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentManagedHookInstaller, AgentProviderRegistry } from '@agentmux/core'
import { agentPromptCondition } from '@agentmux/core/prompt-condition'

const execFileAsync = promisify(execFile)
const wait = async (description, predicate, milliseconds = 120_000) => {
  const deadline = Date.now() + milliseconds
  do {
    const value = await predicate()
    if (value) return value
    await new Promise(done => setTimeout(done, 50))
  } while (Date.now() < deadline)
  const error = new Error('Qualification observation was not confirmed.')
  error.qualificationStep = description
  throw error
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const coreDirectory = dirname(dirname(fileURLToPath(import.meta.resolve('@agentmux/core'))))

async function worker(data) {
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(data.scenario, 'agent-sessions.json')) })
  let output = ''
  const raw = []
  const events = []
  client.onEvent(event => {
    if (event.type === 'terminal-output') { raw.push(Buffer.from(event.dataBytes)); output += event.data }
    if (event.type === 'interaction') events.push(event.request)
  })
  try {
    await client.connect()
    const identity = client.runtimeIdentity()
    if (data.ownerInstance) assert.equal(identity.instanceId, data.ownerInstance, 'Private daemon was replaced.')
    const diagnostic = await client.runtimeDiagnostics()
    assert.equal(diagnostic.supported, true)
    assert.equal(diagnostic.platform, 'linux')
    assert.equal(diagnostic.arch, 'x64')
    assert.equal(diagnostic.ctxmux.bundled.artifactPlatform, 'linux-x64')
    assert.equal(diagnostic.ctxmux.bundled.sourceCommit, data.source.commit)
    assert.equal(diagnostic.ctxmux.serving.protocolVersion, data.protocol)
    const env = { CODEX_HOME: data.providerSeed }
    const args = ['--config', 'cli_auth_credentials_store="file"', '--config', 'notify=[]',
      '--config', 'features.hooks=true', '--config', 'features.plugins=false',
      '--config', 'features.plugin_hooks=false', '--config', 'features.memories=false',
      '--config', 'features.chronicle=false', '--dangerously-bypass-hook-trust', '--no-alt-screen', '--ask-for-approval', 'on-request',
      '--sandbox', 'read-only', '--config', 'model_reasoning_effort="low"',
      '--config', `projects={${JSON.stringify(data.workspace)}={trust_level="trusted"}}`]
    const attach = async session => {
      const value = await client.reattachAgent(session.agentSessionId, 0, 'terminal')
      output += value.attachment.replay.map(event => event.data).join('')
      return value
    }
    const completed = async (sessionId, marker) => await wait(marker, () => {
      const current = client.agentSession(sessionId)
      return output.includes(marker) && current.hookReceipt?.eventName === 'Stop' &&
        current.hookReceipt.run.runId === current.run.runId && current.nativeHandle?.kind === 'provider' &&
        current.terminalPromptReadiness?.source === 'native-stop' ? current : null
    })
    if (data.phase === 'create') {
      const terminal = await client.createTerminal({ createOperationId: `linux-shell-${data.id}`,
        workspacePath: data.workspace, command: '/bin/sh', args: ['-c',
          'printf "\\200\\377AGENTMUX_RAW_READY\\n"; while IFS= read -r line; do printf "REPLY:%s\\n" "$line"; done'] })
      const attachment = await client.attachTerminal(terminal.runId, 0, 'raw')
      raw.push(...attachment.replay.map(event => Buffer.from(event.dataBytes)))
      await wait('original binary bytes', () => Buffer.concat(raw).includes(Buffer.from([128, 255])))
      const current = (await client.runtimeSubject({ kind: 'terminal-run', runId: terminal.runId })).run
      const input = 'AGENTMUX_RAW_INPUT\n'
      await client.writeTerminal(terminal, { ownerInstanceId: identity.instanceId,
        operationId: `linux-shell-input-${data.id}`, expectedByte: current.acceptedInputBytes, data: input })
      await wait('new shell response bytes', () => Buffer.concat(raw).includes(Buffer.from('REPLY:AGENTMUX_RAW_INPUT')))
      assert.deepEqual(await client.resizeTerminal(terminal, 91, 29), { runId: terminal.runId, cols: 91, rows: 29 })
      await client.stopTerminal(terminal)
      const provider = new AgentProviderRegistry().get('codex')
      const installer = new AgentManagedHookInstaller(join(data.scenario, 'managed-hooks'))
      const plan = provider.planManagedHooks({ workspacePath: data.workspace })
      const preview = await installer.preview(plan)
      await installer.install(preview.id)
      const session = await client.createAgent({ agentSessionId: `linux-codex-${data.id}`,
        createOperationId: `linux-codex-create-${data.id}`, providerId: 'codex', executorId: 'codex',
        workspacePath: data.workspace, commandOverride: data.providerCommand, injectAgentMuxGuide: false,
        args, env, prompt: 'Reply exactly AGENTMUX_LINUX_READY and do not use tools.' })
      await attach(session)
      const ready = await completed(session.agentSessionId, 'AGENTMUX_LINUX_READY')
      const status = await client.statusAgent(session.agentSessionId)
      assert.equal(status.run.state, 'running')
      return { phase: data.phase, ownerInstance: identity.instanceId, sessionId: session.agentSessionId,
        runId: status.run.runId, pid: status.run.pid, nativeHandle: ready.nativeHandle,
        rawBytes: true, providerHook: ready.hookReceipt.providerId === 'codex' && ready.hookReceipt.eventName === 'Stop' && ready.hookReceipt.run.runId === status.run.runId, processId: process.pid }
    }
    if (data.phase === 'reattach') {
      const session = client.agentSession(data.previous.sessionId)
      assert.equal(session.run.runId, data.previous.runId)
      assert.deepEqual(session.nativeHandle, data.previous.nativeHandle)
      const status = await client.statusAgent(session.agentSessionId)
      assert.equal(status.run.pid, data.previous.pid)
      assert.equal(status.run.state, 'running')
      await attach(session)
      await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(session.agentSessionId)),
        agentSessionId: session.agentSessionId, operationId: `linux-codex-permission-${data.id}`,
        prompt: `Request elevated sandbox permission to run exactly printf AGENTMUX_LINUX_PERMISSION > ${data.workspace}/permission-marker. Do not use another method or work around a denial. After the response, reply exactly AGENTMUX_LINUX_PERMISSION_DONE.` })
      const request = await wait('real Provider permission', () => events.find(request => request.kind === 'permission'))
      assert.equal(request.evidence.source, 'native-hook')
      assert(request.options.length > 0)
      const allow = request.options.find(option => option.kind === 'allow-once')
      assert(allow, 'Real permission did not declare a one-time approval option.')
      await client.respondAgentInteraction({ agentSessionId: session.agentSessionId, expectedRun: session.run,
        response: { kind: 'permission', requestId: request.id, decision: { outcome: 'selected', optionId: allow.id } } })
      await completed(session.agentSessionId, 'AGENTMUX_LINUX_PERMISSION_DONE')
      assert.equal(await readFile(join(data.workspace, 'permission-marker'), 'utf8'), 'AGENTMUX_LINUX_PERMISSION')
      const timeline = await client.sessionTimeline(session.agentSessionId)
      assert(timeline.items.length > 0)
      const history = await client.sessionHistoryPage(session.agentSessionId, { env, commandOverride: data.providerCommand })
      assert(history.items.length > 0)
      await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(session.agentSessionId)),
        agentSessionId: session.agentSessionId, operationId: `linux-codex-exit-${data.id}`, prompt: '/exit' })
      await wait('original Run exit', async () => (await client.statusAgent(session.agentSessionId)).run.state === 'exited')
      return { ...data.previous, phase: data.phase, providerPermission: true, originalRunSurvived: true,
        historyItems: history.items.length, processId: process.pid }
    }
    if (data.phase === 'resume') {
      const before = client.agentSession(data.previous.sessionId)
      const resumed = await client.resumeAgent({ agentSessionId: before.agentSessionId,
        operationId: `linux-codex-resume-${data.id}`, prompt: 'Reply exactly AGENTMUX_LINUX_RESUMED and do not use tools.',
        args, env, commandOverride: data.providerCommand })
      assert.equal(resumed.agentSessionId, before.agentSessionId)
      assert.notEqual(resumed.run.runId, before.run.runId)
      await attach(resumed)
      const ready = await completed(resumed.agentSessionId, 'AGENTMUX_LINUX_RESUMED')
      assert.equal(ready.nativeHandle.sessionId, data.previous.nativeHandle.sessionId)
      if (data.retainForFederation) {
        const status = await client.statusAgent(resumed.agentSessionId)
        assert.equal(status.run.state, 'running')
        const runs = await client.listRuns()
        assert(runs.length > 0)
        assert.deepEqual(runs.filter(run => run.state === 'running').map(run => run.runId), [resumed.run.runId])
        return { ...data.previous, phase: data.phase, runId: resumed.run.runId, pid: status.run.pid,
          nativeHandle: ready.nativeHandle, resumedRunId: resumed.run.runId, sameSessionResume: true,
          prerequisiteRunsStopped: true, retainedForFederation: true, processId: process.pid }
      }
      await client.stopAgent(resumed.agentSessionId, resumed.run)
      assert.deepEqual(client.agentSessions(), [])
      const runs = await client.listRuns()
      assert(runs.length > 0)
      assert(!runs.some(run => run.state === 'running'))
      return { ...data.previous, phase: data.phase, resumedRunId: resumed.run.runId, sameSessionResume: true,
        cleanedOwnedRuns: true, processId: process.pid }
    }
    if (data.phase === 'cleanup') {
      for (const session of client.agentSessions()) {
        assert.equal(session.workspacePath, data.workspace)
        await client.stopAgent(session.agentSessionId, session.run)
      }
      for (const run of await client.listRuns()) {
        if (run.state !== 'running') continue
        assert.equal(run.workspacePath, data.workspace)
        await client.stopTerminal(run)
      }
      const runs = await client.listRuns()
      assert(!runs.some(run => run.state === 'running'))
      return { cleanedOwnedRuns: true }
    }
    throw new Error('Unknown private consumer phase.')
  } finally { await client.dispose() }
}

async function qualify(input) {
  assert.equal(`${process.platform}-${process.arch}`, 'linux-x64')
  assert(Number(process.versions.node.split('.')[0]) >= 24)
  assert((await realpath(coreDirectory)).startsWith(`${input.consumerDirectory}/node_modules/`))
  assert.equal(sha256(await readFile(input.coreArchivePath)), input.coreArchiveSha256)
  assert.equal(sha256(await readFile(input.demandArchivePath)), input.demandArchiveSha256)
  assert(Object.keys(input.compiledCoreHashes).length > 0)
  for (const [relative, hash] of Object.entries(input.compiledCoreHashes)) {
    assert(!relative.startsWith('/') && !relative.split('/').includes('..'))
    assert.equal(sha256(await readFile(join(coreDirectory, relative))), hash)
  }
  const manifestBytes = await readFile(join(coreDirectory, 'vendor/ctxmux/linux-x64/manifest.json'))
  assert.equal(sha256(manifestBytes), input.manifestSha256)
  const manifest = JSON.parse(manifestBytes.toString())
  assert.equal(manifest.source.commit, input.source.commit)
  assert.equal(manifest.source.tree, input.source.tree)
  assert.equal(manifest.product.protocol, input.protocol)
  const scenario = await mkdtemp(join(input.scopeRoot, 'consumer-run-'))
  const workspace = join(scenario, 'workspace')
  const runtime = join(scenario, 'runtime')
  await mkdir(workspace)
  await mkdir(runtime)
  await mkdir(join(scenario, 'durable/ctxmux'), { recursive: true, mode: 0o700 })
  await execFileAsync('git', ['init', '--quiet', workspace])
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, CODEX_HOME: input.providerSeed,
    AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(scenario, 'durable'),
    AGENTMUX_AGENT_SESSION_STORE: join(scenario, 'agent-sessions.json'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(scenario, 'messages.ndjson') }
  const nativeLog = await open(join(scenario, 'native-start.log'), 'a', 0o600)
  const native = spawn(join(coreDirectory, 'bin/ctxmuxd'), ['--socket', join(runtime, 'ctxmux.sock'),
    '--state-dir', join(scenario, 'durable/ctxmux'), '--readiness-fd', '3'], { env, detached: true, stdio: ['ignore', 'ignore', nativeLog.fd, 'pipe'] })
  await nativeLog.close()
  const nativeClosed = once(native, 'close')
  void nativeClosed.catch(() => {})
  let previous
  let qualified = false
  let primaryFailure
  const base = { ...input, scenario, workspace, id: randomUUID().slice(0, 12) }
  const execute = async phase => {
    const payload = { ...base, phase, previous, ownerInstance: previous?.ownerInstance }
    const path = join(scenario, `${phase}-input.json`)
    await writeFile(path, JSON.stringify(payload))
    try {
      const result = await execFileAsync(process.execPath, [fileURLToPath(import.meta.url), '--worker', path], { env, maxBuffer: 2 * 1024 * 1024 })
      return JSON.parse(result.stdout.trim())
    } catch (error) {
      try { error.workerReceipt = { ...JSON.parse(error.stdout.trim()), phase } } catch {}
      throw error
    }
  }
  try {
    await Promise.race([once(native.stdio[3], 'data'), nativeClosed.then(([code, signal]) => { const error = new Error('Owned daemon exited before readiness.'); error.qualificationStep = `owned native startup exit=${code} signal=${signal}`; throw error }),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('Owned daemon readiness unconfirmed.'), { qualificationStep: 'owned native readiness' })), 10_000).unref())])
    assert((await stat(join(runtime, 'ctxmux.sock'))).isSocket())
    native.stdio[3].destroy()
    previous = await execute('create')
    const firstProcess = previous.processId
    previous = await execute('reattach')
    assert.notEqual(previous.processId, firstProcess)
    previous = await execute('resume')
    if (input.retainForFederation) {
      const launchPath = join(scenario, 'headless-launch.json')
      await writeFile(launchPath, JSON.stringify({ nodePath: process.execPath, command: join(coreDirectory, 'bin/agentmux-runtime'), env }))
      const log = await open(join(scenario, 'headless-start.ndjson'), 'a', 0o600)
      const headless = spawn(process.execPath, [join(coreDirectory, 'bin/agentmux-runtime'), 'serve'],
        { env, detached: true, stdio: ['ignore', log.fd, log.fd] })
      await log.close()
      const owner = await wait('private Headless owner', async () => {
        const contents = await readFile(join(scenario, 'headless-start.ndjson'), 'utf8')
        for (const line of contents.trim().split('\n')) {
          if (!line) continue
          const record = JSON.parse(line)
          if (record.error) { const error = new Error('Private Headless owner startup failed.'); error.code = record.error.code; throw error }
          if (record.owner) return record.owner
        }
      })
      const bridgePath = join(input.consumerDirectory, 'agentmux-runtime-node24')
      const quote = value => `'${value.replaceAll("'", "'\\''")}'`
      await writeFile(bridgePath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(coreDirectory, 'bin/agentmux-runtime'))} \"$@\"\n`)
      await chmod(bridgePath, 0o755)
      const handoff = { owner, scenario, sessionId: previous.sessionId, runId: previous.runId, pid: previous.pid,
        nativeHandle: previous.nativeHandle, nativePid: native.pid, headlessPid: headless.pid, headlessLaunchPath: launchPath,
        endpoint: { transport: 'ssh', host: input.host, command: bridgePath, socketPath: join(runtime, 'control.sock') },
        expectedRuntimeId: owner.runtimeId, providerSeed: input.providerSeed, providerCommand: input.providerCommand,
        coreArchiveSha256: input.coreArchiveSha256, packageSourceSha256: input.packageSourceSha256 }
      await writeFile(join(scenario, 'federation-handoff.json'), JSON.stringify(handoff, null, 2) + '\n')
      previous = { ...previous, handoffPath: join(scenario, 'federation-handoff.json'), owner }
      headless.unref()
    }
    qualified = true
    return { ...previous, status: 'qualified', platform: 'linux-x64', nodeVersion: process.version,
      ctxmuxSource: manifest.source, protocol: manifest.product.protocol, manifestSha256: input.manifestSha256,
      coreArchiveSha256: input.coreArchiveSha256, demandArchiveSha256: input.demandArchiveSha256,
      packageSourceSha256: input.packageSourceSha256,
      ordinaryClientRestart: true, installedPackage: coreDirectory, scenario, nativePid: native.pid }
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    let cleanupFailure
    if (!qualified) {
      try { await execute('cleanup') } catch (error) { cleanupFailure = error }
    }
    if (qualified && input.retainForFederation) {
      native.unref()
    } else {
      native.kill('SIGINT')
      await nativeClosed
    }
    // Preserve the credential-free receipts/state for review; the enclosing owner removes the scope.
    await writeFile(join(scenario, 'cleanup-receipt.json'), JSON.stringify({ ownedNativePid: native.pid,
      nativeExitCode: native.exitCode, nativeSignal: native.signalCode, allRunsStopped: input.retainForFederation && qualified ? false : qualified || !cleanupFailure,
      retainedForFederation: Boolean(input.retainForFederation && qualified),
      cleanupFailure: cleanupFailure?.workerReceipt }) + '\n')
    if (cleanupFailure && !primaryFailure) throw cleanupFailure
  }
}

try {
  const input = JSON.parse(await readFile(process.argv.at(-1), 'utf8'))
  const receipt = process.argv[2] === '--worker' ? await worker(input) : await qualify(input)
  console.log(JSON.stringify(receipt))
} catch (error) {
  // Provider configuration and authentication output are deliberately excluded.
  console.log(JSON.stringify({ status: 'failed', errorCode: error.code ?? error.name,
    assertion: error.name === 'AssertionError' ? error.message : undefined,
    qualificationStep: error.qualificationStep, workerReceipt: error.workerReceipt,
    artifactDetail: typeof error.code === 'string' && error.code.startsWith('CTXMUX_ARTIFACT') ? error.message : undefined }))
  process.exitCode = 1
}
