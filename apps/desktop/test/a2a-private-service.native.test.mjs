import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { stopPrivateA2aHostService } from '../scripts/lib/a2a-inbox-product-proof.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
async function fixture(root, { unavailable = false, endpoint = 'dead' } = {}) {
  const log = join(root, 'calls.jsonl'), coreRoot = join(root, 'core')
  await mkdir(join(coreRoot, 'dist'), { recursive: true })
  await writeFile(join(coreRoot, 'package.json'), '{"type":"module"}')
  await writeFile(join(coreRoot, 'dist/index.js'), `export async function probeSocketLiveness(){return ${JSON.stringify(endpoint)}}`)
  const modulePath = join(root, 'private-host-service.mjs')
  const source = `import{appendFileSync}from'node:fs';let registered=true;const log=value=>appendFileSync(${JSON.stringify(log)},JSON.stringify(value)+'\\n');
export const macosHostServiceAddress=()=>({label:'private-service',target:'gui/private-service'});
export async function macosHostServiceRegistration(){log('registration');if(${unavailable})throw Error('Original service observation unavailable');return registered?{pid:42}:null}
export async function inspectMacosHostService(){log('inspect');return{owner:{runtimeId:'original-runtime'},storePath:${JSON.stringify(join(root, 'user-data/agent-sessions.json'))}}}
export async function stopMacosHostService(service,owner){log(['stop',service.target,owner.owner.runtimeId]);registered=false}
`
  await writeFile(modulePath, source)
  return { modulePath, moduleSHA256: sha(source), coreRoot,
    service: { label: 'private-service', target: 'gui/private-service', storePath: join(root, 'user-data/agent-sessions.json'),
      socketPath: join(root, 'runtime/control.sock'), plistPath: join(root, 'user-data/private-service.plist') }, log }
}
const temporary = async run => { const root = await realpath(await mkdtemp(join(tmpdir(), 'a2a-service-test-'))); try { await run(root) } finally { await rm(root, { recursive: true, force: true }) } }

test('private service cleanup requires its exact namespace before any owner operation', async () => temporary(async root => {
  const record = await fixture(root); record.service.storePath = join(root, 'another-store')
  await assert.rejects(stopPrivateA2aHostService(record), { name: 'AssertionError' })
  await assert.rejects(readFile(record.log), { code: 'ENOENT' })
}))

test('private cleanup delegates the original owner and requires an unregistered service plus dead endpoint', async () => temporary(async root => {
  const record = await fixture(root), result = await stopPrivateA2aHostService(record)
  assert.equal(result.owner.owner.runtimeId, 'original-runtime'); assert.equal(result.status, 'unregistered'); assert.equal(result.endpoint, 'confirmed-dead')
  const calls = (await readFile(record.log, 'utf8')).trim().split('\n').map(row => JSON.parse(row))
  assert.deepEqual(calls, ['registration', 'inspect', ['stop', 'gui/private-service', 'original-runtime'], 'registration'])
}))

test('unknown registration retains the original error and never attempts a stop', async () => temporary(async root => {
  const record = await fixture(root, { unavailable: true })
  await assert.rejects(stopPrivateA2aHostService(record), /Original service observation unavailable/u)
  assert.equal((await readFile(record.log, 'utf8')).trim(), '"registration"')
}))

test('a still-live endpoint cannot be signed as successful cleanup', async () => temporary(async root => {
  const record = await fixture(root, { endpoint: 'alive' })
  await assert.rejects(stopPrivateA2aHostService(record), { name: 'AssertionError', message: /endpoint exit must be confirmed/u })
}))
