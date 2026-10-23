import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { parseHostConfigurations } from '@agentmux/host/host-configuration'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('the original Desktop configuration writer delegates the shared Host contract and preserves complete fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hc-d-')); roots.push(directory)
  const path = join(directory, 'config.json'), store = new ConfigStore(path)
  const hosts = [{ id: 'local' as const, kind: 'local' as const, label: 'Original local' }, { id: 'ssh-original', kind: 'ssh' as const, label: 'Original remote',
    hostname: 'original.example', user: 'original-user', port: 2222, identityFile: '/original/identity', remoteCommand: '/original/amux', remoteSocketPath: '/original/owner.sock', runtimeId: 'original-runtime' }]
  const saved = await store.save({ ...DEFAULT_CONFIG, hosts })
  expect(saved.hosts).toEqual(hosts)
  expect(parseHostConfigurations(JSON.parse(await readFile(path, 'utf8')).hosts)).toEqual({ success: true, data: hosts })
})

it('the actual Desktop rejection and original error presenter retain the exact failing Host fields and authored list errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hc-e-')); roots.push(directory)
  const store = new ConfigStore(join(directory, 'config.json'))
  for (const [invalid, path] of [
    [{ id: 'r', kind: 'telnet', label: 'x' }, 'hosts.1.kind'],
    [{ id: 'r', kind: 'ssh', label: 'x' }, 'hosts.1.hostname'],
    [{ id: 'r', kind: 'ssh', label: 'x', hostname: 'h', port: 1.5 }, 'hosts.1.port'],
    [{ id: 'r', kind: 'ssh', label: 'x', hostname: 'h', remoteSocketPath: 'relative.sock' }, 'hosts.1.remoteSocketPath'],
    [{ id: 'r', kind: 'ssh', label: 'x', hostname: 'h', extra: 'unrecognized' }, 'hosts.1']
  ] as const) {
    const rejected = await store.save({ ...DEFAULT_CONFIG, hosts: [...DEFAULT_CONFIG.hosts, invalid] } as never).then(() => null, error => error)
    expect(rejected).toBeDefined()
    const shown = presentError(new Error("Error invoking remote method 'settings:save': " + rejected.message))
    expect(shown).toContain(path); expect(shown).not.toBe('Invalid input')
  }
  for (const [hosts, message] of [[[], 'Local host is required'], [[...DEFAULT_CONFIG.hosts, ...DEFAULT_CONFIG.hosts], 'Host ids must be unique']] as const) {
    const rejected = await store.save({ ...DEFAULT_CONFIG, hosts } as never).then(() => null, error => error)
    expect(presentError(rejected)).toContain(message)
  }
})
