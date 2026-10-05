import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { connectSshAgentMux } from '../src/runtime-client.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import type { AgentMuxClientEvent } from '../src/types.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs() })

it('updates only future SSH channels while the original consumer, live Attachment and Run keep working', async () => {
  const scope = await headlessFixture(); closes.push(scope.cleanup)
  const directory = await mkdtemp(fixturePath("tmp/amux-launch-command-")), log = join(directory, 'channels.ndjson')
  closes.push(() => rm(directory, { recursive: true, force: true }))
  const entry = pathToFileURL(resolve(import.meta.dirname, '../dist/agentmux-rpc-stdio.js')).href
  // This is a real stdio process and Unix owner, not OpenSSH/network authentication.
  await writeFile(join(directory, 'ssh'), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nimport {forwardAgentMuxRpcStdio} from ${JSON.stringify(entry)};\nappendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');\nawait forwardAgentMuxRpcStdio({endpoint:{transport:'unix',path:${JSON.stringify(scope.socketPath)}},input:process.stdin,output:process.stdout});\n`, { mode: 0o700 })
  vi.stubEnv('PATH', directory + ':' + process.env.PATH)
  const channels = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { pid: number; args: string[] })
  const client = await connectSshAgentMux({ expectedRuntimeId: scope.owner.runtimeId,
    target: { hostId: 'remote', hostname: 'private.invalid', remoteSocketPath: scope.socketPath, remoteCommand: fixturePath("original/core") } })
  closes.push(() => client.dispose())
  const originalOwner = client.runtimeOwnerIdentity()
  const run = await client.createTerminal({ createOperationId: 'original-terminal', workspacePath: scope.root, command: process.execPath,
    args: ['-e', "process.stdin.setRawMode(true);process.stdout.write('ready');process.stdin.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000)"] })
  await until(() => client.listRuns(), runs => runs[0]?.latestOutputBytes === 5, 'Native ready')
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  await client.attachTerminal(run.runId)
  client.setRemoteCommand(fixturePath("candidate/core with space"))
  expect(() => client.setRemoteCommand(fixturePath("invalid") + '\nlauncher')).toThrow()
  expect(await channels()).toHaveLength(1)
  expect(client.runtimeOwnerIdentity()).toEqual(originalOwner)
  await expect(client.writeTerminal({ runId: run.runId }, { operationId: 'input-before-reconnect', ownerInstanceId: nativeId(), expectedByte: 0, data: 'A' })).resolves.toMatchObject({ acceptedThroughByte: 1 })
  await until(() => output(), value => value === 'A', 'unchanged live Attachment after launcher update')
  const first = (await channels())[0]!
  process.kill(first.pid, 'SIGTERM')
  await until(channels, values => values.length >= 2, 'replacement channel')
  await until(() => events, values => values.some(event => event.type === 'connection-state' && event.state === 'restored'), 'original consumer restored')
  expect((await channels())[1]!.args.at(-1)).toBe(`'${fixturePath("candidate/core with space")}' '--endpoint' 'unix:${scope.socketPath}' 'system' 'endpoint' '--stdio'`)
  expect(client.runtimeOwnerIdentity()!.runtimeId).toBe(originalOwner!.runtimeId)
  expect((await client.listRuns())[0]).toMatchObject({ runId: run.runId, pid: run.pid, state: 'running', acceptedInputBytes: 1 })
  await client.writeTerminal({ runId: run.runId }, { operationId: 'input-after-reconnect', ownerInstanceId: nativeId(), expectedByte: 1, data: 'B' })
  await until(() => output(), value => value === 'AB', 'same Attachment after future channel uses the new launcher')
  const restored = events.filter(event => event.type === 'connection-state' && event.state === 'restored').length
  client.setRemoteCommand(undefined)
  process.kill((await channels())[1]!.pid, 'SIGTERM')
  await until(channels, values => values.length >= 3, 'default launcher channel')
  await until(() => events.filter(event => event.type === 'connection-state' && event.state === 'restored').length,
    count => count > restored, 'same consumer restored with default launcher')
  expect((await channels())[2]!.args.at(-1)).toBe(`'amux' '--endpoint' 'unix:${scope.socketPath}' 'system' 'endpoint' '--stdio'`)
  await client.writeTerminal({ runId: run.runId }, { operationId: 'input-after-default', ownerInstanceId: nativeId(), expectedByte: 2, data: 'C' })
  await until(() => output(), value => value === 'ABC', 'continuous original Run after default launcher update')
  await client.releaseRunAttachment({ runId: run.runId })
  await client.stopTerminal({ runId: run.runId })
  function nativeId() { return client.runtimeIdentity().instanceId }
  function output() { return events.filter(event => event.type === 'terminal-output').map(event => event.data).join('') }
}, 60_000)

it.each(['', '\n' + fixturePath("core"), fixturePath("core") + '\r', fixturePath("core") + '\0'])('rejects invalid launcher %j before changing the future connection', async command => {
  const client = await connectSshAgentMux({ waitForReady: false,
    target: { hostId: 'remote', hostname: 'private.invalid', remoteCommand: fixturePath("original/core") } })
  closes.push(() => client.dispose())
  expect(() => client.setRemoteCommand(command)).toThrow()
  expect(client.runtimeOwnerIdentity()).toBeNull()
})
