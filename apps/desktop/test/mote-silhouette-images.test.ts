import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { MoteAvatarSeriesOwner } from '../src/main/mote-avatar-series.js'
import { MoteAvatarControl } from '../src/main/mote-avatar-control.js'
import { controlledNativeImage } from './fixtures/mote-identity-image.js'

const releases: (() => Promise<void>)[] = []
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })
const expected = ['retro-future', 'low-poly', 'dada', 'polka-dot', 'ukiyo-e', 'cyberpunk', 'flat', 'neo-classical', 'vaporwave', 'klei', 'ink', 'fallout-four']
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

it('the original source owner, strict RPC and compiled CLI discover and prepare all twelve packaged Mote images without publishing an avatar', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-silhouette-')); releases.push(() => rm(directory, { recursive: true, force: true }))
  const builtinRoot = resolve(import.meta.dirname, '../resources/avatar-series'), collection = join(builtinRoot, 'mote-silhouettes')
  const original = await Promise.all((await readdir(collection)).sort().map(async name => [name, sha(await readFile(join(collection, name)))]))
  const source = new MoteAvatarSeriesOwner({ userRoot: join(directory, 'unstarted'), builtinRoot }, controlledNativeImage)
  const control = new MoteAvatarControl(source)
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], moteAvatars: control })
  await server.start(); releases.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); releases.push(() => client.dispose())
  const catalog = await client.call('space.mote.avatar.list', {})
  const images = catalog.series.find(item => item.origin === 'builtin' && item.seriesId === 'mote-silhouettes')
  expect(images?.entries.map(entry => entry.entryId)).toEqual(expected)
  expect(images?.entries.map(entry => entry.title)).toEqual(['Retro future', 'Low poly', 'Dada', 'Polka dot', 'Ukiyo-e', 'Cyberpunk', 'Flat', 'Neoclassical', 'Vaporwave', 'Klei', 'Ink', 'Fallout 4'])
  expect(images!.entries).toHaveLength(12)
  const revisions = []
  for (const entry of images!.entries) {
    expect(entry.definition).toEqual({ kind: 'image', file: entry.entryId + '.png' })
    const input = { source: { origin: 'builtin' as const, seriesId: images!.seriesId, entryId: entry.entryId } }
    const prepared = await client.call('space.mote.avatar.preview', input)
    expect(prepared.source).toMatchObject(input.source); expect(prepared.source.revision).toMatch(/^sha256:[a-f\d]{64}$/)
    expect(prepared.payload).toMatchObject({ kind: 'image', image: { width: 256, height: 256 } })
    expect((await client.call('space.mote.avatar.preview', { ...input, expectedRevision: prepared.source.revision })).source).toEqual(prepared.source)
    revisions.push(prepared.source.revision)
  }
  expect(new Set(revisions).size).toBe(12)
  const cli = await runCompiledObjectCli(['space', 'mote', 'avatar', 'list'], objectCliEnvironment(directory))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.series.find((item: { seriesId: string }) => item.seriesId === 'mote-silhouettes')).toEqual(images)
  const input = { source: { origin: 'builtin', seriesId: 'mote-silhouettes', entryId: 'low-poly' } }
  const preview = await runCompiledObjectCli(['space', 'mote', 'avatar', 'preview', '--input', '-'], objectCliEnvironment(directory), JSON.stringify(input))
  expect(preview.code, preview.stderr).toBe(0); expect(JSON.parse(preview.stdout).result.source).toMatchObject(input.source)
  await expect(readdir(join(directory, 'unstarted'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await Promise.all((await readdir(collection)).sort().map(async name => [name, sha(await readFile(join(collection, name)))]))).toEqual(original)
}, 30000)
