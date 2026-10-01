const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const [electron, healthBundle, main, ...args] = process.argv.slice(2)
const [, , privateRoot, evidence] = args
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const record = { schema: 'agentmux.toolkit-template-gui-restart.v1', completed: false, processes: [], health: [] }
let client, healthy
async function launch(stage) {
  const child = spawn(electron, [main, ...args], { cwd: process.cwd(), env: { ...process.env, AGENTMUX_TOOLKIT_UI_GUI_STAGE: stage }, stdio: 'inherit' })
  const startedAt = Date.now()
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  record.processes.push({ stage, pid: child.pid, startedAt, exitedAt: Date.now(), ...exit })
  assert.equal(exit.code, 0, 'Ordinary private GUI exits successfully: ' + stage)
  assert.equal(exit.signal, null, 'Ordinary GUI exit is not a forced process termination')
  const file = path.join(evidence, 'toolkit-render.json'), raw = JSON.parse(await fs.readFile(file, 'utf8'))
  await fs.copyFile(file, path.join(evidence, stage + '-render.json'))
  assert.equal(raw.qualified, true, 'Actual desktop assertions are complete: ' + stage)
  return raw
}
async function health(name, input) {
  const before = (await client.listRuns()).find(run => run.runId === healthy.runId)
  const probe = input ? input + '-' + randomUUID() : null, payload = probe ? '\n' + probe + '\n' : null
  const result = { name, before: before ?? null, probe, payload, ack: null, run: null, replay: null, text: null, completed: false }
  record.health.push(result)
  try {
    assert.ok(before, 'The exact healthy Raw Run is nonempty')
    assert.equal(before.pid, healthy.pid); assert.equal(before.state, 'running')
    if (payload) result.ack = await client.writeTerminal(healthy, { ownerInstanceId: client.runtimeIdentity().instanceId, operationId: randomUUID(), expectedByte: before.acceptedInputBytes, data: payload })
    const deadline = Date.now() + 8000
    do {
      const replay = await client.readRunReplay(healthy, 0, 'raw')
      result.run = replay.run; result.replay = replay; result.text = replay.replay.map(event => event.data).join(''); result.readAt = Date.now()
      if (!probe || result.text.includes('ACK:' + probe)) break
      assert.ok(Date.now() < deadline, 'Real healthy Input ACK appears in raw replay'); await pause(20)
    } while (true)
    assert.equal(result.run.pid, healthy.pid); assert.equal(result.run.state, 'running'); assert.equal(result.replay.gap, null)
    if (result.ack) assert.deepEqual(result.ack.appliedByteRange, { startByte: before.acceptedInputBytes, endByte: before.acceptedInputBytes + Buffer.byteLength(payload) })
    result.completed = true; return result
  } catch (error) { result.failure = { name: error.name, message: error.message }; throw error }
}
;(async () => {
  try {
    const { AgentMuxClient, AgentMuxMemoryAgentSessionStore } = await import(pathToFileURL(healthBundle).href)
    client = new AgentMuxClient({ providers: [], store: new AgentMuxMemoryAgentSessionStore() }); await client.connect()
    record.setup = { connected: true, at: Date.now(), runtime: client.runtimeIdentity() }
    const work = path.join(privateRoot, 'work'); await fs.mkdir(work, { recursive: true })
    const program = String.raw`process.stdin.setEncoding('utf8');let text='';console.log('HEALTH_READY');process.stdin.on('data',data=>{text+=data;let n;while((n=text.indexOf('\n'))>=0){const line=text.slice(0,n).replace(/\r$/u,'');text=text.slice(n+1);console.log('ACK:'+line)}})`
    healthy = await client.createTerminal({ createOperationId: randomUUID(), workspacePath: work, command: process.execPath, args: ['-e', program], env: {}, cols: 100, rows: 24 })
    await client.attachTerminal(healthy.runId, 0, 'raw')
    await fs.writeFile(path.join(privateRoot, 'healthy-run.json'), JSON.stringify(healthy))
    await health('before-GUI', 'before-gui')
    const first = await launch('control')
    if (process.env.AGENTMUX_TOOLKIT_TEMPLATE_INPUT_PREFLIGHT === '1') {
      assert.equal(first.inputPreflight.completed, true); assert.equal(first.inputPreflight.sourceExact, true); assert.deepEqual(first.inputPreflight.externalCalls, [])
      await health('after-input-only-GUI', 'after-input-only'); record.completed = true; record.taskQualified = false; return
    }
    const between = await health('between-ordinary-GUI-processes', 'between-gui')
    assert.ok(between.text.includes('ACK:gui-control'), 'Original TerminalView input reaches the actual healthy process')
    const second = await launch('restart')
    const after = await health('after-second-GUI', 'after-gui')
    assert.ok(after.text.includes('ACK:gui-restart'), 'Restored TerminalView input reaches the same healthy process')
    assert.notEqual(record.processes[0].pid, record.processes[1].pid, 'Two ordinary GUI processes have distinct identities')
    assert.deepEqual(second.before, first.after, 'The second App restores the original durable workbench; it is not reseeded')
    assert.equal(second.sessionAttach.runId, healthy.runId, 'The second actual Terminal consumer automatically attaches the original Run')
    assert.ok(first.templateToolId && first.templateToolId === second.templateToolId, 'The created ordinary tool identity survives the ordinary GUI restart')
    const confirmed = first.facts.snapshots.find(snapshot => snapshot.toolId === first.templateToolId).latestConfirmed
    assert.ok(confirmed?.executionId, 'A real confirmed result exists before GUI exit')
    assert.deepEqual(second.facts.snapshots.find(snapshot => snapshot.toolId === first.templateToolId).latestConfirmed, confirmed, 'The exact durable confirmed result is restored')
    assert.deepEqual(second.facts.tools, first.facts.tools, 'All independently edited ordinary definitions restore exactly')
    const combined = { ...first, frames: [...first.frames, ...second.frames], restart: { ordinaryGuiProcesses: 2, exactSurface: true, confirmedResultRetained: true,
      healthyRunSamePid: between.run.pid === after.run.pid && after.run.pid === healthy.pid, realInputAckReplay: true,
      actualTerminalAutomaticAttach: true, control: first.sessionAttach, restored: second.sessionAttach, processes: record.processes, health: record.health },
      afterDisposalLeases: second.afterDisposalLeases, qualified: true }
    await fs.writeFile(path.join(evidence, 'toolkit-render.json'), JSON.stringify(combined, null, 2) + '\n')
    record.completed = true
  } catch (error) { record.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
  finally {
    try {
      if (client && healthy) {
        await client.releaseRunAttachment(healthy); await client.stopTerminal(healthy)
        const deadline=Date.now()+8000
        while((await client.listRuns()).some(run=>run.runId===healthy.runId&&run.state==='running')) {assert.ok(Date.now()<deadline,'Owned healthy process ends before removal');await pause(20)}
        await client.removeTerminal(healthy)
      }
      await client?.dispose()
    } catch (error) { record.cleanupFailure = String(error); record.completed = false; process.exitCode = 1 }
    await fs.writeFile(path.join(evidence, 'ordinary-gui-restart.json'), JSON.stringify(record, null, 2) + '\n')
  }
})()
