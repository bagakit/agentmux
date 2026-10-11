import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_MOTE_FACE } from '@agentmux/core/mote-face'
import { GRAPHITE_THEME } from '@agentmux/client-ui/theme'
import { SEMANTIC_ICON_CATALOG } from '@agentmux/client-ui/icons'
import { moteConnectionOwner } from './fixtures/mote-connection-owner'
import { imageInput, imagePng } from './fixtures/mote-identity-image'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import type { SpaceIconChoice } from '../src/shared/space-object-appearance'

const clean: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close() })
const image = () => ({ dataUrl: imageInput().dataUrl, width: 256, height: 256 })
async function fixture(choice: SpaceIconChoice | null) {
  const root = await mkdtemp(join(tmpdir(), 'amx-avatar-'))
  clean.push(() => rm(root, { recursive: true, force: true }))
  const render = vi.fn(async (_svg: string) => image())
  const f = await moteConnectionOwner(root, { generic: true, avatarChoice: choice, renderAvatar: render })
  clean.push(f.close)
  const target = { workspaceId: f.workspace.id, topicId: f.motes[0]!.id, objectKey: f.target().spaceId }
  return { ...f, render, avatarTarget: target }
}

it.each([null, 'rocket', { ...DEFAULT_MOTE_FACE, palette: 'rose', accessory: 'glasses' }] as Array<SpaceIconChoice | null>)(
  'exports the current appearance %j through SDK, compiled CLI and original creation without saving another avatar', async choice => {
    const f = await fixture(choice), before = structuredClone(f.config)
    const read = await f.client.call('space.mote.avatar.read', { target: f.avatarTarget })
    expect(read.choice).toEqual(choice); expect(read.image).toEqual(image()); expect(read.issues).toEqual([])
    expect(f.render).toHaveBeenCalled(); expect(f.render.mock.calls[0]![0]).toContain('<svg')
    const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.server.path, 'space', 'mote', 'avatar', 'read', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify({ target: f.avatarTarget }))
    expect(cli.code, cli.stdout + cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result).toEqual(read)
    const input = await f.input()
    const created = await f.client.call('space.mote.connection.create', input)
    expect(created.snapshot.avatarSha256).toBe(createHash('sha256').update(imagePng()).digest('hex'))
    expect(created.source.expectedAvatarRevision).toBe(read.revision)
    expect(f.counts.begin).toBe(1); expect(f.writes).toBe(0); expect(f.config).toEqual(before)
  }
)

it('refuses a stale exact icon drawing before dispatch while unrelated theme edits do not change its source', async () => {
  const f = await fixture(null), { id: _id, ...theme } = structuredClone(GRAPHITE_THEME)
  f.config.appearance.themeId = 'custom.avatar-test'
  f.config.appearance.customThemes = { 'custom.avatar-test': theme }
  const input = await f.input(), before = await f.client.call('space.mote.avatar.read', { target: f.avatarTarget })
  theme.variants.dark.colors.warning = '#102030'
  expect((await f.client.call('space.mote.avatar.read', { target: f.avatarTarget })).revision).toBe(before.revision)
  theme.icons['object.mote'] = { kind: 'glyph', glyph: SEMANTIC_ICON_CATALOG['space.rocket'].glyph }
  await expect(f.client.call('space.mote.connection.create', input)).rejects.toMatchObject({ code: 'MOTE_CONNECTION_SOURCE_UNCONFIRMED' })
  expect(f.counts.begin).toBe(0)
  expect((await f.client.call('space.mote.avatar.read', { target: f.avatarTarget })).revision).not.toBe(before.revision)
})

it('keeps face revisions independent of unrelated themes and rejects changes during the exact image export', async () => {
  const f = await fixture({ ...DEFAULT_MOTE_FACE, palette: 'rose' })
  const before = await f.client.call('space.mote.avatar.read', { target: f.avatarTarget })
  f.config.appearance.appAppearance = 'light'
  expect((await f.client.call('space.mote.avatar.read', { target: f.avatarTarget })).revision).toBe(before.revision)
  f.render.mockImplementationOnce(async () => { f.config.appearance.spaceObjectIcons![f.avatarTarget.objectKey] = 'rocket'; return image() })
  const changed = await f.client.call('space.mote.avatar.read', { target: f.avatarTarget })
  expect(changed.image).toBeUndefined(); expect(changed.issues.join(' ')).toContain('changed')
})

it('keeps image and series PNGs on their original asset path without rerendering a 3D source', async () => {
  const f = await fixture(null), ref = f.motes[0]!.avatar
  for (const choice of [ref, { kind: 'series' as const, image: ref,
    source: { origin: 'user' as const, seriesId: 'original-series', entryId: 'original-entry', revision: 'sha256:' + 'a'.repeat(64) },
    definition: { kind: 'glb' as const, file: 'original.glb' },
    parameters: { kind: 'glb' as const, mode: 'original' as const, roughness: .5, color: '#102030', morphs: {}, yaw: 0 } }]) {
    f.config.appearance.spaceObjectIcons![f.avatarTarget.objectKey] = choice
    const read = await f.client.call('space.mote.avatar.read', { target: f.avatarTarget })
    expect(read.image).toEqual(image()); expect(read.choice).toEqual(choice)
  }
  expect(f.render).not.toHaveBeenCalled()
})

it('retains original appearance and reports export failure without inventing another avatar', async () => {
  const f = await fixture('rocket'), before = structuredClone(f.config)
  f.render.mockRejectedValue(Error('Exact avatar export failed'))
  const read = await f.client.call('space.mote.avatar.read', { target: f.avatarTarget })
  expect(read.image).toBeUndefined(); expect(read.choice).toBe('rocket'); expect(read.issues).toContain('Exact avatar export failed')
  expect(f.config).toEqual(before); expect(f.counts.begin).toBe(0)
})
