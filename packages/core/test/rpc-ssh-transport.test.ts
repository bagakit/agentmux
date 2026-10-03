import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'

let directory: string
const clients: Array<Awaited<ReturnType<typeof connectAgentMuxRpc>>> = []
const old = { protocol: 'jsonrpc-2.0', framing: 'json-lines', endpoint: { transport: 'unix', path: fixturePath("original/control.sock") } }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentmux-endpoint-interface-'))
  await writeFile(join(directory, 'ssh'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';\nimport {appendFileSync} from 'node:fs';\nconst value=JSON.parse(process.env.AGENTMUX_TEST_ENDPOINT_RESULT);\nfor await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);appendFileSync(process.env.AGENTMUX_TEST_ENDPOINT_LOG,r.method+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:process.env.AGENTMUX_TEST_WRONG_REQUEST?'other-request':r.id,result:value})+'\\n');}\n`, { mode: 0o700 })
  vi.stubEnv('PATH', `${directory}:${process.env.PATH}`)
  vi.stubEnv('AGENTMUX_TEST_ENDPOINT_LOG', join(directory, 'requests'))
})
afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})
async function endpoint(value: unknown) {
  vi.stubEnv('AGENTMUX_TEST_ENDPOINT_RESULT', JSON.stringify(value))
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'ssh', host: 'literal-test-host', socketPath: fixturePath("original/control.sock") } })
  clients.push(client)
  return client.call('system.endpoint', {})
}
it('rejects the exact old receipt with an actionable upgrade code before admitting a business operation', async () => {
  await expect(endpoint(old)).rejects.toMatchObject({ code: 'REMOTE_CORE_UPGRADE_REQUIRED', message: expect.stringContaining('connection settings') })
  expect(await readFile(join(directory, 'requests'), 'utf8')).toBe('system.endpoint\n')
})
it.each([
  { ...old, endpoint: { transport: 'unix', path: fixturePath("another/control.sock") } },
  { ...old, framing: 'other-framing' },
  { ...old, endpoint: { transport: 'unix', path: 7 } },
  { ...old, unexpected: true },
  { ...old, connection: 'not-attempted' }
])('does not call an arbitrary malformed or wrong-target result an old service: %j', async value => {
  await expect(endpoint(value)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
})
it('does not classify a receipt belonging to another request as an upgrade requirement', async () => {
  vi.stubEnv('AGENTMUX_TEST_WRONG_REQUEST', 'yes')
  await expect(endpoint(old)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
})
it('continues consuming the current confirmed receipt on the same SSH channel', async () => {
  await expect(endpoint({ ...old, connection: 'responded' })).resolves.toMatchObject({ connection: 'responded' })
  expect(await readFile(join(directory, 'requests'), 'utf8')).toBe('system.endpoint\nsystem.endpoint\n')
})
