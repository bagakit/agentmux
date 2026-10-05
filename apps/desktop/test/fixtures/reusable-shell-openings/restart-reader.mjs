// Fresh public Core consumer: no GUI state seeding and no new shell request.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { connectAgentMuxRpc, connectHostedAgentMux, AgentMuxSpatialStateStore } from '@agentmux/core'
const [socket, spatialPath, uiPath, requestsJson] = process.argv.slice(2)
const requests = JSON.parse(requestsJson)
assert.equal(requests.length, 2)
const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
const client = await connectHostedAgentMux({ rpc })
try {
  const spatial = await new AgentMuxSpatialStateStore(spatialPath).read()
  const ui = JSON.parse(await readFile(uiPath, 'utf8'))
  const runs = []
  for (const { request, runId, pid } of requests) {
    const confirmed = await client.createTerminal(request)
    assert.equal(confirmed.runId, runId)
    assert.equal(confirmed.pid, pid)
    assert.equal(confirmed.state, 'running')
    const marker = 'private-reopened-' + runId
    const expectedByte = (await client.readRunReplay({ runId })).run.acceptedInputBytes
    assert.ok(Number.isSafeInteger(expectedByte))
    await client.writeTerminal({ runId }, { ownerInstanceId: client.runtimeIdentity().instanceId,
      operationId: marker, expectedByte, data: `printf '\\n%s%s\\n' 'private-reopened-' '${runId}'\r` })
    let replay
    for (let attempt = 0; attempt < 100; attempt++) {
      replay = await client.readRunReplay({ runId })
      if (replay.replay.map(event => event.data).join('').includes(marker)) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(replay.replay.map(event => event.data).join('').includes(marker))
    runs.push({ runId, pid: replay.run.pid, state: replay.run.state, interactive: true, acceptedInputBytes: replay.run.acceptedInputBytes })
  }
  assert.equal((await client.listRuns()).length, 2)
  process.stdout.write(JSON.stringify({ pid: process.pid, owner: client.runtimeOwnerIdentity(), spatial, ui, runs }) + '\n')
} finally { await client.dispose(); await rpc.dispose() }
