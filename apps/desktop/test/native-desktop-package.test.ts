import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildNativeDesktop, packagedNativeApp, verifyNativeDesktopCopy, verifyNativeDesktopSigning } from '../scripts/native-desktop-package.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-native-package-source-')); roots.push(root)
  const source = join(root, 'packages/native-desktop'), app = join(root, 'apps/desktop/resources/AgentMux Native.app')
  const binary = join(root, 'compiled/agentmux-native-macos'), exe = join(app, 'Contents/MacOS/agentmux-native-macos')
  await mkdir(join(source, 'macos'), { recursive: true }); await mkdir(join(app, 'Contents/Resources'), { recursive: true })
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true }); await mkdir(join(root, 'compiled'), { recursive: true })
  await writeFile(binary, 'fixture compiled bytes'); await writeFile(exe, 'fixture compiled bytes')
  await writeFile(join(app, 'Contents/Info.plist'), 'fixture stable bundle plist')
  for (const [name, path] of [['LICENSE.orca', join(source, 'macos/LICENSE.orca')], ['UPSTREAM.md', join(source, 'macos/UPSTREAM.md')], ['THIRD_PARTY_NOTICES.md', join(source, 'THIRD_PARTY_NOTICES.md')]]) {
    await writeFile(path, 'pinned fixture ' + name); await writeFile(join(app, 'Contents/Resources', name), 'pinned fixture ' + name)
  }
  const receipt = { schema: 'agentmux.native-build.v1', profile: 'application', configuration: 'release', arch: 'x86_64', signed: false, bundleId: 'dev.agentmux.native', appPath: app, binaryPath: binary, executablePath: exe }
  return { root, app, binary, exe, receipt }
}
it('build wrapper consumes exact release receipt and copied compiled bytes with pinned notices', async () => {
  const f = await fixture(), run = vi.fn(async () => ({ stdout: JSON.stringify(f.receipt) }))
  expect(await buildNativeDesktop({ root: f.root, arch: 'x64', platform: 'darwin', run })).toEqual(f.receipt)
  expect(run.mock.calls[0][1]).toEqual([join(f.root, 'packages/native-desktop/scripts/build-macos.mjs'), '--configuration', 'release', '--arch', 'x86_64', '--output', f.app])
  expect(await readFile(join(f.app, 'Contents/Resources/UPSTREAM.md'), 'utf8')).toBe('pinned fixture UPSTREAM.md')
})
it('release wrapper refuses wrong profile, bundle, path, architecture or compiled payload', async () => {
  const f = await fixture()
  for (const wrong of [{ profile: 'bare-debug' }, { configuration: 'debug' }, { bundleId: 'other.bundle' }, { appPath: join(f.root, 'foreign.app') }, { executablePath: f.binary }, { arch: 'arm64' }]) {
    await expect(buildNativeDesktop({ root: f.root, arch: 'x64', platform: 'darwin', run: async () => ({ stdout: JSON.stringify({ ...f.receipt, ...wrong }) }) })).rejects.toThrow()
  }
  await writeFile(f.exe, 'stale binary')
  await expect(buildNativeDesktop({ root: f.root, arch: 'x64', platform: 'darwin', run: async () => ({ stdout: JSON.stringify(f.receipt) }) })).rejects.toThrow(/compiled binary/)
})
it('DEBUG wrapper explicitly uses bare profile and the fixed developer launch file', async () => {
  const f = await fixture(), binary = join(f.root, 'packages/native-desktop/macos/.build/debug/agentmux-native-macos')
  await mkdir(join(binary, '..'), { recursive: true }); await writeFile(binary, 'DEBUG fixture')
  const receipt = { schema: 'agentmux.native-build.v1', profile: 'bare-debug', configuration: 'debug', arch: 'arm64', signed: false, binaryPath: binary, executablePath: binary }
  const run = vi.fn(async () => ({ stdout: JSON.stringify(receipt) }))
  expect(await buildNativeDesktop({ root: f.root, development: true, arch: 'arm64', platform: 'darwin', run })).toEqual(receipt)
  expect(run.mock.calls[0][1]).toContain('--bare'); expect(run.mock.calls[0][1]).not.toContain('--output')
})
it('unsupported platform keeps native build separate from healthy Desktop capabilities', async () => {
  const run = vi.fn()
  expect(await buildNativeDesktop({ root: '/unused', platform: 'linux', run })).toEqual({ state: 'unsupported', platform: 'linux' })
  expect(run).not.toHaveBeenCalled()
})
it('packager verifies exact resource copy and notices before signing', async () => {
  const f = await fixture(), desktop = join(f.root, 'candidate/AgentMux.app'), target = packagedNativeApp(desktop)
  await mkdir(join(target, '..'), { recursive: true }); await cp(f.app, target, { recursive: true })
  expect((await verifyNativeDesktopCopy(desktop, f.root)).appPath).toBe(target)
  await writeFile(join(target, 'Contents/MacOS/agentmux-native-macos'), 'foreign compiled file')
  await expect(verifyNativeDesktopCopy(desktop, f.root)).rejects.toThrow(/differs/)
  await cp(f.app, target, { recursive: true })
  await writeFile(join(target, 'Contents/Resources/UPSTREAM.md'), 'floating source')
  await expect(verifyNativeDesktopCopy(desktop, f.root)).rejects.toThrow(/differs/)
})
it('native signature qualification consumes same exact selected leaf and its own bundle', async () => {
  const identity = 'A'.repeat(40), teamId = 'TESTTEAM01', desktop = (new URL('file:///').pathname + "fixture/AgentMux.app")
  const run = vi.fn(async (_command, args) => args.includes('--requirements') ? { stdout: 'designated => identifier "dev.agentmux.native" and anchor apple generic' } :
    args.includes('--display') ? { stdout: `Identifier=dev.agentmux.native\nAuthority=Developer ID Application: Fixture (${teamId})\nTeamIdentifier=${teamId}` } : { stdout: '' })
  await expect(verifyNativeDesktopSigning(desktop, { kind: 'certificate', identity, teamId }, { run })).resolves.toMatchObject({ authorizationContinuity: 'unverified' })
  expect(run.mock.calls[0][1]).toContain(`=identifier "dev.agentmux.native" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}" and certificate leaf = H"${identity}"`)
  expect(run.mock.calls[0][1].at(-1)).toBe(packagedNativeApp(desktop))
})
