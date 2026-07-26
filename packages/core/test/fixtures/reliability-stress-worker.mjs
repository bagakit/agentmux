import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const coreEntry = process.env.AGENTMUX_CORE_ENTRY
const daemonPath = process.env.AGENTMUX_DAEMON_PATH
const runtimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY
const workload = process.env.AGENTMUX_RUN_KERNEL_WORKLOAD
const workspace = process.env.AGENTMUX_RELIABILITY_WORKSPACE
const sourceCommit = process.env.AGENTMUX_SOURCE_COMMIT
const trackedDiffClean = process.env.AGENTMUX_TRACKED_DIFF_CLEAN
assert.ok(
  coreEntry && daemonPath && runtimeDirectory && workload && workspace &&
  sourceCommit && (trackedDiffClean === '0' || trackedDiffClean === '1')
)

const { connectLocalAgentMux } = await import(pathToFileURL(coreEntry).href)
const socketPath = `${runtimeDirectory}/ctxmux.sock`
const trackedPids = new Set()

const budgetDocument = JSON.parse(await readFile(
  new URL('./reliability-budgets.json', import.meta.url),
  'utf8'
))
assert.equal(budgetDocument.schema, 'agentmux.t017-reliability-budgets.v1')
const { schema: _budgetSchema, ctxmuxSourceCommit, ...budgets } = budgetDocument

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(description, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const result = await predicate()
    if (result) return result
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

async function processIsGone(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return true
    throw error
  }
}

async function daemonProcesses() {
  const result = await execFileAsync('/bin/ps', ['-axo', 'pid=,command='], {
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024
  })
  return result.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
    if (!match) return []
    const command = match[2]
    if (
      !command.includes(daemonPath) ||
      !command.includes(`--socket ${socketPath}`) ||
      !command.includes(`--state-dir ${runtimeDirectory}/state`)
    ) return []
    return [Number(match[1])]
  })
}

async function exactDaemon() {
  return await waitFor('one exact test-owned ctxmuxd', async () => {
    const pids = await daemonProcesses()
    if (pids.length > 1) throw new Error('More than one ctxmuxd owns the reliability runtime.')
    return pids[0] ?? null
  })
}

async function processMetrics(pid) {
  const rss = await execFileAsync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], {
    timeout: 5_000,
    maxBuffer: 64 * 1024
  })
  const threads = await execFileAsync('/bin/ps', ['-M', '-p', String(pid)], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024
  })
  const descriptors = await execFileAsync('/usr/sbin/lsof', [
    '-n', '-P', '-a', '-p', String(pid), '-Ff'
  ], {
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const rssKiB = Number.parseInt(rss.stdout.trim(), 10)
  const threadCount = Math.max(0, threads.stdout.trimEnd().split('\n').length - 1)
  const fdCount = descriptors.stdout.split('\n').filter((line) => /^f(?:cwd|txt|\d+)/u.test(line)).length
  assert.ok(Number.isSafeInteger(rssKiB) && rssKiB > 0)
  return { pid, rssKiB, threads: threadCount, fds: fdCount }
}

async function sample(label, daemonPid) {
  await delay(100)
  return {
    label,
    daemon: await processMetrics(daemonPid),
    clientRssKiB: Math.round(process.memoryUsage().rss / 1024)
  }
}

function observe(client) {
  const tails = new Map()
  const bytes = new Map()
  const gaps = new Map()
  const release = client.onEvent((event) => {
    // A saturated live Consumer is a best-effort View: CtxMux drops the bytes
    // it could not deliver and signals the loss as one explicit OUTPUT_GAP
    // (client.ts turns the daemon's RunEvent::Gap into agent-error/OUTPUT_GAP,
    // never a terminal-output). Count those here so the burst invariant can
    // require that every live shortfall is accounted for, not silently lost.
    if (event.type === 'agent-error' && event.code === 'OUTPUT_GAP') {
      const gappedRunId = event.evidence?.run?.runId
      if (gappedRunId) gaps.set(gappedRunId, (gaps.get(gappedRunId) ?? 0) + 1)
      return
    }
    if (event.type !== 'terminal-output') return
    const runId = event.run.runId
    bytes.set(runId, (bytes.get(runId) ?? 0) + Buffer.byteLength(event.data))
    tails.set(runId, `${tails.get(runId) ?? ''}${event.data}`.slice(-16 * 1024))
  })
  return {
    release,
    tail: (runId) => tails.get(runId) ?? '',
    bytes: (runId) => bytes.get(runId) ?? 0,
    gaps: (runId) => gaps.get(runId) ?? 0
  }
}

async function stopTestDaemons() {
  for (const pid of await daemonProcesses()) {
    try { process.kill(pid, 'SIGKILL') } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ESRCH')) throw error
    }
    await waitFor(`ctxmuxd ${pid} cleanup`, async () => await processIsGone(pid), 5_000)
  }
}

async function stopTrackedChildren() {
  for (const pid of trackedPids) {
    if (await processIsGone(pid)) continue
    try { process.kill(pid, 'SIGKILL') } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ESRCH')) throw error
    }
    await waitFor(`tracked child ${pid} cleanup`, async () => await processIsGone(pid), 5_000)
  }
}

let client = null
let observer = null
let stage = 'initial connect'
try {
  client = await connectLocalAgentMux()
  observer = observe(client)
  // A permanently unresolved Consumer callback must not become transport backpressure.
  client.onEvent(async () => await new Promise(() => {}))
  const daemonPid = await exactDaemon()
  const initialRuntimeIdentity = client.runtimeIdentity()
  const runtimeDiagnostics = await client.runtimeDiagnostics()
  assert.equal(runtimeDiagnostics.ctxmux.sourceCommit, ctxmuxSourceCommit)
  const baseline = await sample('connected-baseline', daemonPid)

  const runs = await Promise.all(Array.from({ length: budgets.runCount }, async (_, index) => {
    const run = await client.createTerminal({
      createOperationId: `stress-create-${index}-${randomUUID()}`,
      workspacePath: workspace,
      command: process.execPath,
      args: [workload, 'echo', `stress-${index}`]
    })
    assert.ok(run.pid)
    trackedPids.add(run.pid)
    return run
  }))
  assert.equal(new Set(runs.map((run) => run.runId)).size, budgets.runCount)
  assert.equal(new Set(runs.map((run) => run.pid)).size, budgets.runCount)
  const afterRuns = await sample('sixteen-idle-runs', daemonPid)

  await Promise.all(runs.map(async (run) => await client.attachTerminal(run.runId, 0)))
  const inputReceipts = await Promise.all(runs.map(async (run, index) => await client.writeTerminal(run, {
    ownerInstanceId: client.runtimeIdentity().instanceId,
    operationId: `stress-input-${index}`,
    expectedByte: run.acceptedInputBytes,
    data: `probe-${index}\n`
  })))
  await waitFor('all attached Run responses', () => runs.every((run, index) => (
    observer.tail(run.runId).includes(`run-kernel-input:probe-${index}`)
  )))
  const afterAttachments = await sample('sixteen-live-attachments', daemonPid)

  await Promise.all(runs.map(async (run) => await client.releaseRunAttachment(run)))
  for (let index = 0; index < 32; index += 1) {
    await client.attachTerminal(runs[0].runId, 0)
    await client.releaseRunAttachment(runs[0])
  }

  const raceInput = client.writeTerminal(runs[0], {
    ownerInstanceId: client.runtimeIdentity().instanceId,
    operationId: 'stress-stop-input-race',
    expectedByte: inputReceipts[0].acceptedThroughByte,
    data: 'race\n'
  })
  const stopResults = await Promise.allSettled([
    raceInput,
    client.stopTerminal(runs[0]),
    ...runs.slice(1).map(async (run) => await client.stopTerminal(run))
  ])
  assert.equal(stopResults.slice(1).every((result) => result.status === 'fulfilled'), true)
  const inputRace = stopResults[0]
  if (inputRace.status === 'rejected') {
    assert.ok(
      inputRace.reason?.code === 'CTXMUX_invalid_run_state' ||
        inputRace.reason?.code === 'CTXMUX_run_not_found',
      `concurrent Input failed outside terminal Run disposition: ${inputRace.reason?.code ?? inputRace.reason}`
    )
  }
  await waitFor('all multi-Run child processes to exit', async () => (
    (await Promise.all(runs.map(async (run) => await processIsGone(run.pid)))).every(Boolean)
  ))
  const afterCleanup = await sample('multi-run-cleanup', daemonPid)
  assert.equal((await client.listRuns()).some((run) => run.state === 'running'), false)

  const burst = await client.createTerminal({
    createOperationId: `stress-burst-${randomUUID()}`,
    workspacePath: workspace,
    command: process.execPath,
    args: [workload, 'burst', 'eviction', String(5 * 1024 * 1024)]
  })
  assert.ok(burst.pid)
  trackedPids.add(burst.pid)
  const burstAttachment = await client.attachTerminal(burst.runId, 0)
  assert.equal(burstAttachment.gap, null)
  const burstInitialOutput = burstAttachment.replay.map((event) => event.data).join('')
  if (!burstInitialOutput.includes('run-kernel-burst-ready:eviction')) {
    await waitFor('burst readiness', () => observer.tail(burst.runId).includes('run-kernel-burst-ready:eviction'))
  }
  await client.writeTerminal(burst, {
    ownerInstanceId: client.runtimeIdentity().instanceId,
    operationId: 'stress-burst-start',
    expectedByte: burst.acceptedInputBytes,
    data: 'go\n'
  })
  await waitFor('fast consumer final burst marker', () => (
    observer.tail(burst.runId).includes('run-kernel-burst-end:eviction')
  ), 30_000)
  const fastConsumerBytes = observer.bytes(burst.runId)
  const fastConsumerGapCount = observer.gaps(burst.runId)
  const delayed = await client.readRunReplay(burst, 0)
  assert.ok(delayed.gap)
  assert.ok(delayed.gap.firstAvailableByte > 0)
  let replayCursor = delayed.gap.firstAvailableByte
  for (const event of delayed.replay) {
    assert.equal(event.startByte, replayCursor)
    replayCursor = event.endByte
  }
  assert.equal(replayCursor, delayed.run.latestOutputBytes)
  assert.ok(delayed.replay.map((event) => event.data).join('').includes('run-kernel-burst-end:eviction'))
  // The authoritative output is complete (the contiguous replay above reaches
  // latestOutputBytes). The live View, by contrast, is best-effort under
  // saturation: CtxMux's bounded live channel drops what a slow Consumer cannot
  // take in time and surfaces the loss as one explicit OUTPUT_GAP (client.ts
  // maps the daemon's RunEvent::Gap to agent-error/OUTPUT_GAP, never a
  // terminal-output). This is the daemon's documented contract — see the ctxmux
  // SDK-02 test "keeps command results live while bounded output becomes an
  // explicit Gap". The invariant this Run must hold is therefore *loss must be
  // signalled*, not a live-throughput floor: any live shortfall has to be
  // accounted for by at least one gap, and a Run that reported zero gaps must
  // have observed every authoritative byte live.
  assert.ok(
    fastConsumerBytes <= delayed.run.latestOutputBytes,
    `fast Consumer observed ${fastConsumerBytes} live bytes, more than the ${delayed.run.latestOutputBytes} the Run produced`
  )
  assert.ok(
    fastConsumerBytes === delayed.run.latestOutputBytes || fastConsumerGapCount > 0,
    `fast Consumer lost ${delayed.run.latestOutputBytes - fastConsumerBytes} live bytes with no OUTPUT_GAP to account for them`
  )
  const afterReplay = await sample('five-mib-burst-retained-replay', daemonPid)
  await client.releaseRunAttachment(burst)
  await client.stopTerminal(burst)
  await waitFor('burst child cleanup', async () => await processIsGone(burst.pid))

  const crashRun = await client.createTerminal({
    createOperationId: `stress-crash-${randomUUID()}`,
    workspacePath: workspace,
    command: process.execPath,
    args: [workload, 'echo', 'daemon-crash']
  })
  assert.ok(crashRun.pid)
  trackedPids.add(crashRun.pid)
  const crashAttachment = await client.attachTerminal(crashRun.runId, 0)
  assert.equal(crashAttachment.gap, null)
  await client.writeTerminal(crashRun, {
    ownerInstanceId: client.runtimeIdentity().instanceId,
    operationId: 'stress-before-daemon-crash',
    expectedByte: crashRun.acceptedInputBytes,
    data: 'before-crash\n'
  })
  await waitFor('pre-crash marker', () => observer.tail(crashRun.runId).includes('run-kernel-input:before-crash'))
  const crashReplayBefore = await client.readRunReplay(crashRun, 0)
  assert.ok(crashReplayBefore.replay.map((event) => event.data).join('').includes('run-kernel-input:before-crash'))
  await delay(100)
  stage = 'live daemon SIGKILL'
  process.kill(daemonPid, 'SIGKILL')
  await waitFor('crashed daemon exit', async () => await processIsGone(daemonPid), 5_000)
  await waitFor('orphaned native child disposition', async () => await processIsGone(crashRun.pid), 10_000)
  observer.release()
  observer = null
  stage = 'dispose crashed-daemon Client'
  await client.dispose()
  client = null

  stage = 'connect replacement daemon'
  client = await connectLocalAgentMux()
  const recovered = client
  stage = 'locate replacement daemon'
  const replacementDaemonPid = await exactDaemon()
  const replacementRuntimeIdentity = recovered.runtimeIdentity()
  assert.notEqual(replacementDaemonPid, daemonPid)
  stage = 'list historical recovery'
  const historical = await waitFor('historical Run recovery', async () => (
    (await recovered.listRuns()).find((run) => run.runId === crashRun.runId) ?? null
  ))
  assert.notEqual(historical.state, 'running')
  assert.equal(historical.pid, null)
  stage = 'read recovered replay'
  const recoveredReplay = await recovered.readRunReplay(crashRun, 0)
  assert.ok(recoveredReplay.replay.map((event) => event.data).join('').includes('run-kernel-input:before-crash'))
  const recoveredSample = await sample('replacement-daemon-historical-recovery', replacementDaemonPid)
  await recovered.dispose()
  client = null
  const disposedClientRssKiB = Math.round(process.memoryUsage().rss / 1024)

  stage = 'resource budget audit'
  const daemonThreadDelta = afterRuns.daemon.threads - baseline.daemon.threads
  const daemonFdDelta = afterRuns.daemon.fds - baseline.daemon.fds
  assert.ok(afterRuns.daemon.rssKiB <= budgets.maxDaemonRssKiB)
  assert.ok(afterReplay.daemon.rssKiB <= budgets.maxReplayDaemonRssKiB)
  assert.ok(Math.max(
    baseline.clientRssKiB,
    afterRuns.clientRssKiB,
    afterAttachments.clientRssKiB,
    afterCleanup.clientRssKiB,
    afterReplay.clientRssKiB,
    recoveredSample.clientRssKiB,
    disposedClientRssKiB
  ) <= budgets.maxClientRssKiB)
  assert.ok(disposedClientRssKiB <= budgets.maxDisposedClientRssKiB)
  assert.ok(
    (afterAttachments.clientRssKiB - afterRuns.clientRssKiB) / budgets.runCount <=
      budgets.maxClientRssPerAttachmentKiB
  )
  assert.ok(
    afterReplay.clientRssKiB - afterAttachments.clientRssKiB <=
      budgets.maxReplayClientIncrementKiB
  )
  assert.ok(daemonThreadDelta <= budgets.runCount * budgets.maxDaemonThreadsPerRun)
  assert.ok(daemonFdDelta <= budgets.runCount * budgets.maxDaemonFdsPerRun)
  assert.ok(
    afterCleanup.daemon.rssKiB - baseline.daemon.rssKiB <= budgets.maxCleanupRssDriftKiB,
    `cleanup RSS drift: baseline=${baseline.daemon.rssKiB} cleanup=${afterCleanup.daemon.rssKiB}`
  )
  assert.ok(
    afterCleanup.daemon.threads - baseline.daemon.threads <= budgets.maxCleanupThreadDrift,
    `cleanup thread drift: baseline=${baseline.daemon.threads} cleanup=${afterCleanup.daemon.threads}`
  )
  assert.ok(
    (afterCleanup.daemon.fds - baseline.daemon.fds) / budgets.runCount <=
      budgets.maxRetainedHistoricalFdsPerRun,
    `cleanup FD drift: baseline=${baseline.daemon.fds} cleanup=${afterCleanup.daemon.fds}; samples=${JSON.stringify({ afterRuns: afterRuns.daemon, afterAttachments: afterAttachments.daemon, afterCleanup: afterCleanup.daemon })}`
  )

  process.stdout.write(`${JSON.stringify({
    schema: 'agentmux.t017-reliability.v1',
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    identity: {
      agentmux: {
        sourceCommit,
        trackedDiffClean: trackedDiffClean === '1'
      },
      ctxmux: {
        sourceCommit: runtimeDiagnostics.ctxmux.sourceCommit,
        artifactPlatform: runtimeDiagnostics.ctxmux.artifactPlatform,
        protocolVersion: runtimeDiagnostics.ctxmux.protocolVersion,
        capabilities: runtimeDiagnostics.ctxmux.capabilities
      },
      daemon: {
        initialInstanceId: initialRuntimeIdentity.instanceId,
        initialPid: daemonPid,
        replacementInstanceId: replacementRuntimeIdentity.instanceId,
        replacementPid: replacementDaemonPid
      }
    },
    budgets,
    samples: {
      baseline,
      afterRuns,
      afterAttachments,
      afterCleanup,
      afterReplay,
      recoveredSample,
      disposedClientRssKiB
    },
    deltas: {
      daemonRssPerRunKiB: (afterRuns.daemon.rssKiB - baseline.daemon.rssKiB) / budgets.runCount,
      daemonThreadsPerRun: daemonThreadDelta / budgets.runCount,
      daemonFdsPerRun: daemonFdDelta / budgets.runCount,
      daemonRssPerAttachmentKiB: (afterAttachments.daemon.rssKiB - afterRuns.daemon.rssKiB) / budgets.runCount,
      daemonFdsPerAttachment: (afterAttachments.daemon.fds - afterRuns.daemon.fds) / budgets.runCount,
      clientRssPerAttachmentKiB: (afterAttachments.clientRssKiB - afterRuns.clientRssKiB) / budgets.runCount,
      replayClientIncrementKiB: afterReplay.clientRssKiB - afterAttachments.clientRssKiB,
      retainedHistoricalFdsPerRun: (afterCleanup.daemon.fds - baseline.daemon.fds) / budgets.runCount
    },
    correctness: {
      uniqueRuns: budgets.runCount,
      attachDetachCycles: 32,
      stopInputRace: inputRace.status === 'fulfilled'
        ? { status: 'applied' }
        : { status: 'rejected-after-stop', code: inputRace.reason.code },
      slowConsumerGap: delayed.gap,
      retainedReplayBytes: delayed.run.latestOutputBytes - delayed.gap.firstAvailableByte,
      fastConsumerBytes,
      fastConsumerGapCount,
      fastConsumerLiveShortfallBytes: delayed.run.latestOutputBytes - fastConsumerBytes,
      crashRunId: crashRun.runId,
      crashDisposition: historical.state,
      crashChildGone: true,
      recoveredReplay: true
    }
  })}\n`)
} catch (error) {
  throw new Error(
    `reliability stage ${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error }
  )
} finally {
  observer?.release()
  if (client) {
    try {
      for (const run of await client.listRuns()) {
        if (run.state === 'running') await client.stopTerminal(run).catch(() => {})
      }
    } catch {}
    await client.dispose().catch(() => {})
  }
  await stopTrackedChildren()
  await stopTestDaemons()
}
