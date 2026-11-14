import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareTailcatKey } from '../src/tailcat-key.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const publicKey = 'nodekey:' + 'c'.repeat(64)

async function fixture(extra: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tailcat-key-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin'), home = join(root, 'home'), log = join(root, 'calls.log')
  await mkdir(bin); await mkdir(home)
  await copyFile(join(import.meta.dirname, 'fixtures/fake-tailcat.sh'), join(bin, 'tailcat')); await chmod(join(bin, 'tailcat'), 0o755)
  const environment: NodeJS.ProcessEnv = { PATH: bin + ':/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), FAKE_TAILCAT_LOG: log, ...extra }
  const keys = process.platform === 'darwin' ? join(home, 'Library/Application Support/tailcat/keys') : join(home, '.config/tailcat/keys')
  return {
    root, environment, keyFile: (name: string) => join(keys, name + '.private.json'),
    prepare: (role: 'server' | 'client', key: string) => prepareTailcatKey({ role, key }, { environment }),
    calls: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
      .map(line => line.replace(/--key=.*\.agentmux-key-[^/]+\/key\.private\.json/u, '--key=<private-staging>')),
    files: () => readdir(keys)
  }
}

it('creates a missing server key once, then reuses it byte for byte and never returns its private address', async () => {
  const f = await fixture()
  expect(await f.prepare('server', 'agentmux-server')).toEqual({ role: 'server', key: 'agentmux-server', created: true })
  const saved = await readFile(f.keyFile('agentmux-server'), 'utf8')
  expect(await f.prepare('server', 'agentmux-server')).toEqual({ role: 'server', key: 'agentmux-server', created: false })
  expect(await readFile(f.keyFile('agentmux-server'), 'utf8')).toBe(saved)
  expect(await f.calls()).toEqual(['genkey --key=<private-staging> --fixed-region|'])
  expect(await f.files()).toEqual(['agentmux-server.private.json'])
})

it('creates a missing client key once and reads its public key as the connection code every time', async () => {
  const f = await fixture()
  expect(await f.prepare('client', 'agentmux-client')).toEqual({ role: 'client', key: 'agentmux-client', created: true, publicKey })
  expect(await f.prepare('client', 'agentmux-client')).toEqual({ role: 'client', key: 'agentmux-client', created: false, publicKey })
  expect(await f.calls()).toEqual(['genkey --client --key=<private-staging>|', '--key=agentmux-client printpub|', '--key=agentmux-client printpub|'])
})

it('an existing key of the wrong kind is reported and left untouched', async () => {
  const f = await fixture()
  await f.prepare('client', 'office')
  const before = await readFile(f.keyFile('office'), 'utf8')
  await expect(f.prepare('server', 'office')).rejects.toMatchObject({ code: 'TAILCAT_KEY_CONFLICT', message: expect.stringContaining('unchanged') })
  expect(await readFile(f.keyFile('office'), 'utf8')).toBe(before)
  expect((await f.calls()).filter(call => call.startsWith('genkey'))).toEqual(['genkey --client --key=<private-staging>|'])
})

it('a key saved concurrently under the same name is reused rather than replaced', async () => {
  const seed = await fixture()
  await seed.prepare('server', 'seed')
  const f = await fixture()
  f.environment.FAKE_TAILCAT_RACE = seed.keyFile('seed')
  f.environment.FAKE_TAILCAT_RACE_TARGET = f.keyFile('agentmux-server')
  expect(await f.prepare('server', 'agentmux-server')).toEqual({ role: 'server', key: 'agentmux-server', created: false })
  expect(await readFile(f.keyFile('agentmux-server'), 'utf8')).toBe(await readFile(seed.keyFile('seed'), 'utf8'))
})

it('simultaneous preparations publish exactly one key and remove their private staging files', async () => {
  const f = await fixture()
  const results = await Promise.all([f.prepare('server', 'shared'), f.prepare('server', 'shared')])
  expect(results.map(result => result.created).sort()).toEqual([false, true])
  expect(await f.files()).toEqual(['shared.private.json'])
  expect((await f.calls()).filter(call => call.startsWith('genkey'))).toHaveLength(2)
})

it('a failed creation, a missing CLI or an unprepared environment reports unavailability and saves nothing', async () => {
  const failing = await fixture({ FAKE_TAILCAT_GENKEY_FAIL: '1' })
  await expect(failing.prepare('server', 'agentmux-server')).rejects.toMatchObject({ code: 'TAILCAT_UNAVAILABLE', message: expect.stringContaining('network') })
  await expect(stat(failing.keyFile('agentmux-server'))).rejects.toMatchObject({ code: 'ENOENT' })

  const missing = await fixture()
  const environment = { ...missing.environment, PATH: join(missing.root, 'home') }
  await expect(prepareTailcatKey({ role: 'client', key: 'agentmux-client' }, { environment }))
    .rejects.toMatchObject({ code: 'TAILCAT_CLI_MISSING', message: expect.stringContaining('PATH') })

  const unprepared = await fixture(), prepareEnvironment = vi.fn().mockRejectedValue(Error('login shell'))
  await expect(prepareTailcatKey({ role: 'client', key: 'agentmux-client' }, { environment: unprepared.environment, prepareEnvironment }))
    .rejects.toMatchObject({ code: 'TAILCAT_UNAVAILABLE' })
  expect(await unprepared.calls()).toEqual([])
})

it('ambient Tailcat and Agent credentials never reach the official CLI', async () => {
  const f = await fixture({ TAILCAT_ADDR_FILE: '/tmp/published-address', AGENTMUX_AGENT_CAPABILITY: 'agent-secret' })
  await f.prepare('server', 'agentmux-server')
  expect(await f.calls()).toEqual(['genkey --key=<private-staging> --fixed-region|'])
})
