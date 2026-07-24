import assert from 'node:assert/strict'
import { connectLocalAgentMux, connectSshAgentMux } from '@agentmux/core'

const controlFixture = process.env.AGENTMUX_CONTROL_FIXTURE
const stubbornFixture = process.env.AGENTMUX_STUBBORN_FIXTURE
assert.ok(controlFixture && stubbornFixture)

async function waitFor(description, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

function output(events, runId) {
  return events
    .filter((event) => event.type === 'terminal-output' && event.run.runId === runId)
    .map((event) => event.data)
    .join('')
}

async function processIsGone(pid) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return true
    throw error
  }
  return false
}

let first = await connectLocalAgentMux()
assert.deepEqual(await first.listRuns(), [])
const firstEvents = []
first.onEvent((event) => firstEvents.push(event))
const run = await first.createTerminal({
  workspacePath: process.cwd(),
  command: process.execPath,
  args: [controlFixture],
  cols: 80,
  rows: 24
})
const firstAttachment = await first.attachTerminal(run.runId, 0)
assert.equal(firstAttachment.gap, null)
await waitFor('fragmented UTF-8 output', () => output(firstEvents, run.runId).includes('control-ready'))
assert.equal(output(firstEvents, run.runId).includes('prefix:😀:tail'), true)
assert.equal(output(firstEvents, run.runId).includes('�'), false)
const beforeReconnect = (await first.listRuns()).find((candidate) => candidate.runId === run.runId)
assert.ok(beforeReconnect)
assert.ok(beforeReconnect.pid)
const originalPid = beforeReconnect.pid
await first.dispose()
first = null

const second = await connectLocalAgentMux()
const reconnected = (await second.listRuns()).find((candidate) => candidate.runId === run.runId)
assert.ok(reconnected)
assert.equal(reconnected.runId, run.runId)
assert.equal(reconnected.pid, originalPid)
const secondEvents = []
second.onEvent((event) => secondEvents.push(event))
const suffix = await second.attachTerminal(run.runId, Buffer.byteLength('prefix:'))
assert.equal(suffix.gap, null)
assert.equal(suffix.replay[0]?.startByte, Buffer.byteLength('prefix:'))
assert.equal(suffix.replay.map((event) => event.data).join('').includes('😀:tail'), true)

await second.resizeTerminal(run, 101, 37)
await waitFor('applied resize', () => output(secondEvents, run.runId).includes('size:101x37'))
await second.signalTerminal(run, 'SIGINT')
await waitFor('interrupt receipt from the still-live process', () => (
  output(secondEvents, run.runId).includes('interrupt-observed')
))
assert.equal((await second.listRuns()).find((candidate) => candidate.runId === run.runId)?.state, 'running')
await second.stopTerminal(run)

const stubbornEvents = []
const unsubscribe = second.onEvent((event) => stubbornEvents.push(event))
const stubborn = await second.createTerminal({
  workspacePath: process.cwd(),
  command: process.execPath,
  args: [stubbornFixture]
})
await second.attachTerminal(stubborn.runId, 0)
const stubbornOutput = await waitFor('stubborn process tree identities', () => {
  const text = output(stubbornEvents, stubborn.runId)
  return text.includes('stubborn-root:') && text.includes('stubborn-child:') ? text : null
})
const rootMatch = /stubborn-root:(\d+):(\d+)/u.exec(stubbornOutput)
const childMatch = /stubborn-child:(\d+)/u.exec(stubbornOutput)
assert.ok(rootMatch && childMatch)
const stubbornPids = [Number(rootMatch[1]), Number(rootMatch[2]), Number(childMatch[1])]
await second.stopTerminal(stubborn)
await waitFor('complete stubborn process-tree stop', async () => (
  (await Promise.all(stubbornPids.map(processIsGone))).every(Boolean)
))
unsubscribe()

await assert.rejects(
  connectSshAgentMux({ target: { hostId: 'remote', hostname: 'example.invalid' } }),
  (error) => error?.code === 'REMOTE_UNSUPPORTED'
)
await second.dispose()

process.stdout.write(`${JSON.stringify({
  runId: run.runId,
  pid: originalPid,
  replayStartByte: suffix.replay[0]?.startByte,
  resize: '101x37',
  interruptStillLive: true,
  stubbornPids,
  remote: 'unsupported'
})}\n`)
