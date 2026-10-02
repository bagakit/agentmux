import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { sourceUpdateIdentity } from '../scripts/update-identity.mjs'

const boundary = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: boundary.spawn
}))
const roots: string[] = []
const selected = `${process.platform}-${process.arch}`
const foreign = process.platform === 'linux' ? 'darwin-arm64' : 'linux-x64'
const runtimeRelative = 'Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux'
afterEach(async () => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function file(path: string, bytes: string) {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes)
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-artifact-identity-')); roots.push(root)
  const source = join(root, 'source'), home = join(root, 'home')
  const current = join(home, 'Applications/AgentMux.app'), candidate = join(root, 'candidate.app')
  for (const directory of ['apps/desktop/src/main', 'apps/desktop/src/preload', 'apps/desktop/src/shared',
    'apps/desktop/scripts', 'packages/core/src', 'packages/core/scripts', 'packages/core/bin'])
    await mkdir(join(source, directory), { recursive: true })
  for (const name of ['apps/desktop/package.json', 'apps/desktop/electron.vite.config.ts',
    'packages/core/package.json', 'pnpm-lock.yaml']) await file(join(source, name), 'unchanged shell')
  for (const directory of [join(source, 'packages/core/vendor/ctxmux'), join(current, runtimeRelative), join(candidate, runtimeRelative)]) {
    await file(join(directory, selected, 'manifest.json'), 'current host manifest')
    await file(join(directory, selected, 'bin/ctxmuxd'), 'current host daemon')
    await file(join(directory, foreign, 'manifest.json'), 'other host manifest')
  }
  return { root, source, home, current, candidate }
}

function refuseCandidateCopy() {
  boundary.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    queueMicrotask(() => child.emit('error', new Error('OWNED_CANDIDATE_COPY_BOUNDARY')))
    return child
  })
}

it('source release Native identity ignores foreign artifacts while retaining actual Core changes', async () => {
  const f = await fixture(), before = await sourceUpdateIdentity(f.source)
  await file(join(f.source, 'packages/core/vendor/ctxmux', foreign, 'bin/ctxmuxd'), 'new foreign daemon')
  expect(await sourceUpdateIdentity(f.source), 'Foreign artifacts must not change the current host release identity').toEqual(before)
  await file(join(f.source, 'packages/core/src/runtime-client.ts'), 'actual Core change')
  const after = await sourceUpdateIdentity(f.source)
  expect(after.ctxmux).toBe(before.ctxmux); expect(after.shell).not.toBe(before.shell)
})

it('source release Native identity changes for each current host artifact and rejects missing host facts', async () => {
  const f = await fixture()
  let before = await sourceUpdateIdentity(f.source)
  for (const name of ['manifest.json', 'bin/ctxmuxd', 'bin/ctxmux', 'ctxmux-sdk.tgz']) {
    await file(join(f.source, 'packages/core/vendor/ctxmux', selected, name), `changed current ${name}`)
    const after = await sourceUpdateIdentity(f.source)
    expect(after.ctxmux, `The current host ${name} must change its Native identity`).not.toBe(before.ctxmux)
    expect(after.shell).toBe(before.shell); before = after
  }
  await rm(join(f.source, 'packages/core/vendor/ctxmux', selected), { recursive: true })
  const missing = await sourceUpdateIdentity(f.source).then(() => null, (error: unknown) => error)
  expect(missing, 'Missing current host facts must reject with their actual filesystem error').toMatchObject({ code: 'ENOENT' })
})

it('full installer keeps semantic reload eligible when only another platform artifact changed', async () => {
  const f = await fixture()
  await file(join(f.candidate, runtimeRelative, foreign, 'bin/ctxmuxd'), 'new foreign daemon')
  // Stop at the first OS copy boundary. This proves actual installer route
  // selection without copying, quitting, signaling or inspecting any user App.
  refuseCandidateCopy()
  const { installApplication } = await import('../scripts/package-macos.mjs')
  const quit = vi.fn(), launch = vi.fn()
  await expect(installApplication(f.candidate, { intent: 'full', homeDirectory: f.home, quit, launch }),
    'Foreign artifact changes must reach ordinary full installation without a Native review request').rejects.toThrow('OWNED_CANDIDATE_COPY_BOUNDARY')
  expect(boundary.spawn).toHaveBeenCalledOnce()
  expect(boundary.spawn.mock.calls[0]?.[0]).toBe('ditto')
  expect(quit).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
})

it('full installer still demands Native review before copy or quit for a current host artifact change', async () => {
  const f = await fixture()
  await file(join(f.candidate, runtimeRelative, selected, 'bin/ctxmuxd'), 'changed current host daemon')
  const { installApplication } = await import('../scripts/package-macos.mjs')
  const quit = vi.fn(), launch = vi.fn()
  await expect(installApplication(f.candidate, { intent: 'full', homeDirectory: f.home, quit, launch })).rejects.toThrow('CtxMux runtime differs')
  expect(boundary.spawn).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
})

it('explicit UI-only preparation retains its separate route when the current host Native artifact differs', async () => {
  const f = await fixture()
  await file(join(f.candidate, runtimeRelative, selected, 'bin/ctxmuxd'), 'changed current host daemon')
  refuseCandidateCopy()
  const { installApplication } = await import('../scripts/package-macos.mjs')
  const quit = vi.fn(), launch = vi.fn()
  await expect(installApplication(f.candidate, { intent: 'ui-only', homeDirectory: f.home, quit, launch })).rejects.toThrow('OWNED_CANDIDATE_COPY_BOUNDARY')
  expect(boundary.spawn).toHaveBeenCalledOnce()
  expect(quit).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
})
