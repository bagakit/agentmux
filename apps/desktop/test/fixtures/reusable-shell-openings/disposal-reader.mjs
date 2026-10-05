import assert from 'node:assert/strict'
import { connectAgentMuxRpc, connectHostedAgentMux } from '@agentmux/core'
const [socket, requestsJson] = process.argv.slice(2)
const requests = JSON.parse(requestsJson)
assert.equal(requests.length, 2)
const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
const client = await connectHostedAgentMux({ rpc })
try {
  const runs = []
  for (const { request, runId, pid } of requests) {
    const confirmed = await client.createTerminal(request)
    assert.equal(confirmed.runId, runId); assert.equal(confirmed.pid, pid); assert.equal(confirmed.state, 'running')
    const marker = 'callback-preserved-' + runId
    const expectedByte = (await client.readRunReplay({ runId })).run.acceptedInputBytes
    await client.writeTerminal({ runId }, { ownerInstanceId: client.runtimeIdentity().instanceId,
      operationId: marker, expectedByte, data: `printf '\\n%s%s\\n' 'callback-preserved-' '${runId}'\r` })
    let replay
    for (let attempt = 0; attempt < 100; attempt++) {
      replay = await client.readRunReplay({ runId })
      if (replay.replay.map(event => event.data).join('').includes(marker)) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(replay.replay.map(event => event.data).join('').includes(marker))
    assert.equal(replay.run.pid, pid); assert.equal(replay.run.state, 'running')
    assert.ok(replay.run.acceptedInputBytes > expectedByte)
    runs.push({ runId, pid, state: replay.run.state, interactive: true, acceptedInputBytes: replay.run.acceptedInputBytes })
  }
  process.stdout.write(JSON.stringify({ pid: process.pid, owner: client.runtimeOwnerIdentity(), runtime: client.runtimeIdentity(), runs }) + '\n')
} finally { await client.dispose(); await rpc.dispose() }
