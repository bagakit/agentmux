import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_SERVICE, PROBE_CORE_INSTALL } from '../src/remote-core-install-programs.js'

const exec = promisify(execFile), roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'core-service-')); roots.push(home)
  const dir = join(home, '.config', 'systemd', 'user'), prefix = join(home, '.agentmux', 'server')
  await mkdir(dir, { recursive: true })
  return { home, prefix, unit: join(dir, 'agentmux-core.service') }
}
async function invoke(command: string, args: string[], input: unknown, home: string, environment: Record<string, string> = {}) {
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, HOME: home, ...environment }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }))
    child.stdin.end(JSON.stringify(input))
  })
}

describe('first install preserves an existing user service', () => {
  it.each(['file', 'dangling-link'] as const)('probe reports an occupied %s and install leaves it untouched', async kind => {
    const f = await fixture(), original = '[Service]\nExecStart=/other/core/serve.sh\n'
    if (kind === 'file') await writeFile(f.unit, original)
    else await symlink(join(f.home, 'missing-owned-service'), f.unit)
    const probe = await invoke('/usr/bin/python3', ['-c', PROBE_CORE_INSTALL], { prefix: f.prefix }, f.home)
    expect(probe.status).toBe(0)
    expect(JSON.parse(probe.stdout).systemd.unitAvailable).toBe(false)
    const result = await invoke(process.execPath, ['-e', INSTALL_SERVICE], { prefix: f.prefix, home: f.home, node: process.execPath, keepRunning: 'systemd' }, f.home)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('existing AgentMux user service was preserved')
    if (kind === 'file') expect(await readFile(f.unit, 'utf8')).toBe(original)
    else expect((await exec('readlink', [f.unit])).stdout.trim()).toBe(join(f.home, 'missing-owned-service'))
    await expect(readFile(join(f.prefix, 'start.sh'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('probe offers a free unit slot independently of user manager availability', async () => {
    const f = await fixture()
    const result = await invoke('/usr/bin/python3', ['-c', PROBE_CORE_INSTALL], { prefix: f.prefix }, f.home)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).systemd.unitAvailable).toBe(true)
  })
})


describe('first install recognises an existing installation without its current pointer', () => {
  it.each(['bin/amux', 'start.sh', 'serve.sh', 'state/semantic-runtime.json', 'state/agent-sessions.json', 'state/core-releases/old/deployment.json'])('preserves %s', async entry => {
    const f = await fixture(), marker = join(f.prefix, entry)
    await mkdir(dirname(marker), { recursive: true }); await writeFile(marker, 'retained user installation')
    const result = await invoke('/usr/bin/python3', ['-c', PROBE_CORE_INSTALL], { prefix: f.prefix }, f.home)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).installed).toBe(true)
    expect(await readFile(marker, 'utf8')).toBe('retained user installation')
  })
})


it('preserves a same-named loaded unit supplied by another systemd search directory', async () => {
  const f = await fixture(), bin = join(f.home, 'probe-bin')
  await mkdir(bin)
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\ncase "$*" in *show-environment*) exit 0 ;; *LoadState*) echo loaded ;; *) exit 1 ;; esac\n', { mode: 0o755 })
  const env = { PATH: bin }
  const probe = await invoke('/usr/bin/python3', ['-c', PROBE_CORE_INSTALL], { prefix: f.prefix }, f.home, env)
  expect(probe.status).toBe(0)
  expect(JSON.parse(probe.stdout).systemd).toMatchObject({ user: true, unitAvailable: false })
  const service = await invoke(process.execPath, ['-e', INSTALL_SERVICE], { prefix: f.prefix, home: f.home, node: process.execPath, keepRunning: 'systemd' }, f.home, env)
  expect(service.status).not.toBe(0)
  expect(service.stderr).toContain('original service was left unchanged')
  await expect(readFile(join(f.prefix, 'start.sh'))).rejects.toMatchObject({ code: 'ENOENT' })
})


it('does not overwrite a unit created concurrently after the service preflight', async () => {
  const f = await fixture(), bin = join(f.home, 'race-bin')
  await mkdir(bin)
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\ncase "$*" in *LoadState*) printf "not-found\\n"; printf "concurrent user service\\n" > "$HOME/.config/systemd/user/agentmux-core.service" ;; *) exit 0 ;; esac\n', { mode: 0o755 })
  const service = await invoke(process.execPath, ['-e', INSTALL_SERVICE], { prefix: f.prefix, home: f.home, node: process.execPath, keepRunning: 'systemd' }, f.home, { PATH: bin + ':' + process.env.PATH })
  expect(service.status).not.toBe(0)
  expect(await readFile(f.unit, 'utf8')).toBe('concurrent user service\n')
})
