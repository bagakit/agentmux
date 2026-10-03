import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { constants, mkdtemp, mkdir, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import type { ExecutionHost } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { TopicKnowledgeOwner } from '../src/main/topic-knowledge'
import { TopicSpatialOwner } from '../src/main/topic-spatial-owner'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { SpaceObjectImages } from '../src/main/space-object-images'
import { directoryIdentity } from '../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID, scratchTopicStorageRoots } from '../src/shared/scratch-topics'
import { AVATAR_INPUT_MAX_BYTES, AVATAR_OUTPUT_MAX_BYTES, type SpaceObjectImageTarget } from '../src/shared/object-avatars'
import { controlledNativeImage, imageInput, imagePng } from './fixtures/mote-identity-image'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('Node image tests must supply the controlled native decoder.') } } }))
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
const CATEGORY = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const repository = fileURLToPath(new URL('../../../', import.meta.url))
let fifoWorker: string

/** A finite parent observes actual Host Source IO; a blocked FIFO child cannot hang this suite. */
beforeAll(async () => {
  const evidence = resolve(process.env.AGENTMUX_TEST_IMAGE_EVIDENCE_DIR ?? join(repository, '.local/state/space-object-images-test'))
  await mkdir(evidence, { recursive: true })
  const require = createRequire(join(repository, 'packages/core/package.json'))
  const { build } = require('esbuild') as typeof import('../../../packages/core/node_modules/esbuild')
  const dependencyLink = join(evidence, 'node_modules')
  try { await symlink(join(repository, 'apps/desktop/node_modules'), dependencyLink) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const electron = join(evidence, 'electron.mjs')
  await writeFile(electron, 'export const nativeImage={createFromBuffer(){throw new Error("This readonly FIFO child does not decode images")}};')
  fifoWorker = join(evidence, 'fifo-worker.mjs')
  const fifoMutant = process.env.AGENTMUX_TEST_IMAGE_FIFO_MUTANT === 'omit-nonblock'
  await build({ stdin: { contents: `
    import {TopicKnowledgeOwner} from ${JSON.stringify(join(repository, 'apps/desktop/src/main/topic-knowledge.ts'))};
    import {ScratchTopics} from ${JSON.stringify(join(repository, 'apps/desktop/src/main/scratch-topics.ts'))};
    import {WorkspaceFiles} from ${JSON.stringify(join(repository, 'apps/desktop/src/main/workspace-files.ts'))};
    import {SpaceObjectImages} from ${JSON.stringify(join(repository, 'apps/desktop/src/main/space-object-images.ts'))};
    const request=JSON.parse(process.argv[2]);
    const workspace=request.workspace;
    const owner=new TopicKnowledgeOwner(new ScratchTopics(),new WorkspaceFiles(()=>({kind:'local'})),()=>workspace);
    const images=new SpaceObjectImages(target=>owner.categoryAppearanceDirectory(target.categoryId,target.objectKey));
    process.stdout.write('READY\\n');
    try { const result=request.operation==='category' ? await images.appearance(request.target) : await images.read(request.target,request.ref);process.stdout.write(JSON.stringify({status:'resolved',result})+'\\n'); }
    catch(error){process.stdout.write(JSON.stringify({status:'rejected',message:error.message})+'\\n');}
  `, resolveDir: repository }, outfile: fifoWorker, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: fifoMutant ? [{ name: 'actual-owner-fifo-regression', setup(builder) {
      builder.onLoad({ filter: /\/topic-knowledge\.ts$/ }, async args => {
        const source = await readFile(args.path, 'utf8'), anchor = 'const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)'
        if (source.split(anchor).length !== 2) throw new Error('The exact original boundedFile mutation anchor is missing.')
        const mutated = source.replace(anchor, 'const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)')
        await writeFile(join(evidence, 'fifo-mutant-source.json'), JSON.stringify({ path: args.path,
          sourceSha256: createHash('sha256').update(source).digest('hex'), mutatedSha256: createHash('sha256').update(mutated).digest('hex'), anchor }))
        return { contents: mutated, loader: 'ts', resolveDir: dirname(args.path) }
      })
    } }] : [],
    alias: { electron, '@agentmux/client-ui/mote-face': join(repository, 'packages/client-ui/src/lib/mote-face.ts') }, logLevel: 'silent' })
})
function fifoObservation(request: object): Promise<{ status: string; message?: string }> {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [fifoWorker, JSON.stringify(request)])
    let output = '', errors = '', ready = false, timedOut = false
    let deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 3000)
    child.stdout.on('data', chunk => {
      output += String(chunk)
      if (!ready && output.startsWith('READY\n')) {
        ready = true; clearTimeout(deadline)
        deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 750)
      }
    })
    child.stderr.on('data', chunk => { errors += String(chunk) })
    child.on('error', error => { clearTimeout(deadline); no(error) })
    child.on('close', code => {
      clearTimeout(deadline)
      if (!ready) { no(new Error('FIFO child did not reach production IO: ' + errors)); return }
      if (timedOut) { yes({ status: 'blocked', message: 'The owned production child was reaped after its finite IO deadline.' }); return }
      if (code !== 0) { no(new Error('FIFO child failed: ' + errors)); return }
      try { yes(JSON.parse(output.slice('READY\n'.length))) } catch (error) { no(error) }
    })
  })
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'space-object-images-'))); roots.push(root)
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: join(root, 'scratch'), kind: 'folder' as const }
  await mkdir(workspace.path)
  const scratch = new ScratchTopics(controlledNativeImage), files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost))
  const state = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const owner = new TopicKnowledgeOwner(scratch, files, () => workspace)
  const spatial = new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => owner.listTopicSnapshots(),
    categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() })
  owner.setSpatialPort(spatial)
  const { category } = await owner.call('topic.category.create', { categoryId: CATEGORY, title: '分类原名' })
  const { topic } = await owner.call('topic.create', { topicId: 'view:image-owner', title: '图片主题', categoryId: category.categoryId })
  const images = new SpaceObjectImages(async target => {
    if (target.kind === 'category') return await owner.categoryAppearanceDirectory(target.categoryId, target.objectKey)
    return { hostId: workspace.hostId, directoryPath: await owner.topicAppearanceDirectory(target.workspaceId, target.topicId, target.objectKey) }
  }, controlledNativeImage)
  const categoryTarget: SpaceObjectImageTarget = { kind: 'category', categoryId: category.categoryId, objectKey: category.spaceId }
  const topicTarget: SpaceObjectImageTarget = { kind: 'topic', workspaceId: workspace.id, topicId: topic.topicId,
    objectKey: directoryIdentity(workspace.hostId, topic.directoryPath) }
  return { root, workspace, scratch, files, state, owner, spatial, category, topic, images, categoryTarget, topicTarget }
}

it('saves and reads exact Category and Topic assets through original owners without changing content or graph', async () => {
  const f = await fixture(), graph = await f.state.read()
  const categoryBytes = await readFile(join(f.category.directoryPath, 'category.md')), topicBytes = await readFile(join(f.topic.directoryPath, 'topic.md'))
  const previews = await Promise.all([f.images.preview(f.categoryTarget, imageInput()), f.images.preview(f.topicTarget, imageInput())])
  expect(previews).toHaveLength(2); expect(previews[0]).toMatchObject({ width: 256, height: 256 })
  expect(await readdir(f.category.directoryPath)).not.toContain('.agentmux')
  const categoryRef = await f.images.save(f.categoryTarget, imageInput()), topicRef = await f.images.save(f.topicTarget, imageInput(imagePng(256, 256, [9, 81, 40])))
  expect(categoryRef.fileName).toBe(createHash('sha256').update(imagePng()).digest('hex') + '.png')
  expect(categoryRef).not.toEqual(topicRef)
  expect(await f.images.read(f.categoryTarget, categoryRef)).toEqual(previews[0])
  expect(await f.images.read(f.topicTarget, topicRef)).toMatchObject({ width: 256, height: 256 })
  const categoryAsset = join(f.category.directoryPath, '.agentmux/avatars', categoryRef.fileName)
  expect((await stat(categoryAsset)).mode & 0o777).toBe(0o600)
  expect(await readFile(categoryAsset)).toEqual(imagePng())
  await expect(f.images.read(f.categoryTarget, topicRef)).rejects.toThrow()
  expect(await readFile(join(f.category.directoryPath, 'category.md'))).toEqual(categoryBytes)
  expect(await readFile(join(f.topic.directoryPath, 'topic.md'))).toEqual(topicBytes)
  expect(await f.state.read()).toEqual(graph)
})

it('rejects malformed Category UUID traversal, swapped original keys, forged kind and arbitrary paths', async () => {
  const f = await fixture(), categoryId = 'escape/../../../escaped-category'
  const escaped = join(scratchTopicStorageRoots(f.workspace.path).topics, 'category--' + categoryId)
  await mkdir(escaped, { recursive: true }); await writeFile(join(escaped, 'category.md'), '# Outside owned evidence\n')
  const traversal = { kind: 'category', categoryId, objectKey: directoryIdentity('local', escaped) } as const
  await expect(f.images.appearance(traversal)).rejects.toThrow()
  await expect(f.images.save(traversal, imageInput())).rejects.toThrow()
  expect(await readdir(escaped)).toEqual(['category.md'])
  await expect(f.images.save({ ...f.categoryTarget, objectKey: f.topicTarget.objectKey }, imageInput())).rejects.toThrow()
  await expect(f.images.read({ ...f.topicTarget, objectKey: f.categoryTarget.objectKey }, { kind: 'image', fileName: 'a'.repeat(64) + '.png' })).rejects.toThrow()
  await expect(f.images.preview({ ...f.topicTarget, path: f.category.directoryPath } as never, imageInput())).rejects.toThrow('exact')
  await expect(f.images.appearance({ ...f.categoryTarget, kind: 'mote' } as never)).rejects.toThrow('exact')
})

it('keeps original image identities across Category rename and real Topic classification transfer', async () => {
  const f = await fixture(), ref = await f.images.save(f.topicTarget, imageInput())
  const categoryRef = await f.images.save(f.categoryTarget, imageInput())
  const renamed = await f.owner.call('topic.category.rename', { categoryId: f.category.categoryId, title: '分类新名', expectedRevision: f.category.revision! })
  expect(renamed.category.spaceId).toBe(f.categoryTarget.objectKey)
  const next = await f.owner.call('topic.category.create', { categoryId: SECOND, title: '新归属' })
  const revision = (await f.state.read())!.revision
  const moved = await f.owner.call('topic.move', { topicId: f.topic.topicId, categoryId: next.category.categoryId, expectedRevision: revision })
  expect(moved.topic.zoneId).toBe(f.topic.zoneId); expect(moved.topic.directoryPath).toBe(f.topic.directoryPath)
  expect(await f.images.read(f.topicTarget, ref)).toMatchObject({ width: 256, height: 256 })
  expect(await f.images.read(f.categoryTarget, categoryRef)).toMatchObject({ width: 256, height: 256 })
  expect(await readdir(next.category.directoryPath)).toEqual(['category.md'])
})

it('refuses actual Mote and retained Core Mote identity even when SOUL metadata is missing', async () => {
  const f = await fixture(), mote = await f.scratch.ensureMote(f.workspace, 'view:image-mote')
  const target: SpaceObjectImageTarget = { kind: 'topic', workspaceId: f.workspace.id, topicId: mote.id,
    objectKey: directoryIdentity('local', mote.identityDirectoryPath!) }
  await expect(f.images.preview(target, imageInput())).rejects.toThrow('Mote')
  await expect(f.images.save(target, imageInput())).rejects.toThrow('Mote')
  const original = (await f.state.read())!, graph = structuredClone(original.graph)
  graph.resources['zone:' + f.topic.zoneId] = { ...graph.resources['zone:' + f.topic.zoneId] as object, contentKind: 'mote' }
  await f.state.commit({ expectedRevision: original.revision, graph })
  await expect(f.images.save(f.topicTarget, imageInput())).rejects.toMatchObject({ code: 'TOPIC_TARGET_IS_MOTE' })
  expect(await readdir(join(f.topic.directoryPath, '.agentmux'))).not.toContain('avatars')
  expect((await f.state.read())!.graph).toEqual(graph)
})

it('bounds image payloads and crops before creating assets, preserving the original object', async () => {
  const f = await fixture()
  for (const target of [f.categoryTarget, f.topicTarget]) {
    await expect(f.images.preview(target, imageInput(Buffer.alloc(AVATAR_INPUT_MAX_BYTES + 1)))).rejects.toThrow()
    await expect(f.images.preview(target, imageInput(imagePng(4097, 1)))).rejects.toThrow('4096')
    await expect(f.images.save(target, imageInput(imagePng(128, 128)))).rejects.toThrow('256')
    await expect(f.images.save(target, { mimeType: 'image/webp', dataUrl: 'data:image/webp;base64,AAAA' } as never)).rejects.toThrow()
    await expect(f.images.save(target, { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(Math.ceil(AVATAR_OUTPUT_MAX_BYTES / 3) * 4 + 100) })).rejects.toThrow('bounded')
  }
  expect(await readdir(f.category.directoryPath)).not.toContain('.agentmux')
  expect(await readdir(join(f.topic.directoryPath, '.agentmux'))).not.toContain('avatars')
})

it('preserves corrupt assets and outside aliases; explicit repair permits the same immutable save again', async () => {
  const f = await fixture(), ref = await f.images.save(f.categoryTarget, imageInput())
  const assets = join(f.category.directoryPath, '.agentmux/avatars'), asset = join(assets, ref.fileName)
  const damaged = imagePng(256, 256, [191, 0, 0]); await writeFile(asset, damaged)
  await expect(f.images.read(f.categoryTarget, ref)).rejects.toThrow('reference')
  await expect(f.images.save(f.categoryTarget, imageInput())).rejects.toThrow('reference')
  expect(await readFile(asset)).toEqual(damaged)
  await rm(asset); await expect(f.images.save(f.categoryTarget, imageInput())).resolves.toEqual(ref)
  const outside = join(f.root, 'outside-assets'); await mkdir(outside)
  await rename(assets, assets + '-retained'); await symlink(outside, assets)
  await expect(f.images.save(f.categoryTarget, imageInput())).rejects.toThrow('directory')
  await expect(f.images.read(f.categoryTarget, ref)).rejects.toThrow('directory')
  expect(await readdir(outside)).toEqual([])
  expect(await readFile(join(assets + '-retained', ref.fileName))).toEqual(imagePng())
  await rm(assets); await rename(assets + '-retained', assets)
  await expect(f.images.save(f.categoryTarget, imageInput())).resolves.toEqual(ref)
})

it('retains completed assets when directory sync fails and retries the same original save', async () => {
  const f = await fixture(), before = await readFile(join(f.category.directoryPath, 'category.md'))
  const probe = await open(f.category.directoryPath, constants.O_RDONLY), prototype = Object.getPrototypeOf(probe) as FileHandle
  const originalSync = prototype.sync
  await probe.close()
  let failOnce = true
  vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
    if (failOnce && (await this.stat()).isDirectory()) { failOnce = false; throw Object.assign(new Error('Controlled directory sync failure'), { code: 'EIO' }) }
    await originalSync.call(this)
  })
  await expect(f.images.save(f.categoryTarget, imageInput())).rejects.toThrow('directory sync failure')
  const fileName = createHash('sha256').update(imagePng()).digest('hex') + '.png'
  const asset = join(f.category.directoryPath, '.agentmux/avatars', fileName)
  expect(failOnce).toBe(false); expect(await readFile(asset)).toEqual(imagePng())
  await expect(f.images.save(f.categoryTarget, imageInput())).resolves.toEqual({ kind: 'image', fileName })
  expect(await readFile(join(f.category.directoryPath, 'category.md'))).toEqual(before)
})

it('recognizes each original local directory and ignores escaped candidates and over-limit image bytes', async () => {
  const f = await fixture(), categoryPng = imagePng(32, 32), topicPng = imagePng(64, 64, [99, 18, 41])
  await writeFile(join(f.category.directoryPath, 'icon.png'), categoryPng); await writeFile(join(f.topic.directoryPath, 'icon.png'), topicPng)
  expect(await f.images.appearance(f.categoryTarget)).toEqual({ local: true, icon: 'data:image/png;base64,' + categoryPng.toString('base64') })
  expect(await f.images.appearance(f.topicTarget)).toEqual({ local: true, icon: 'data:image/png;base64,' + topicPng.toString('base64') })
  await rm(join(f.category.directoryPath, 'icon.png')); await symlink(join(f.topic.directoryPath, 'icon.png'), join(f.category.directoryPath, 'icon.png'))
  expect(await f.images.appearance(f.categoryTarget)).toEqual({ local: true, icon: null })
  await rm(join(f.category.directoryPath, 'icon.png')); await writeFile(join(f.category.directoryPath, 'icon.png'), Buffer.concat([categoryPng, Buffer.alloc(256 * 1024 + 1)]))
  expect(await f.images.appearance(f.categoryTarget)).toEqual({ local: true, icon: null })
})

it.each(['category', 'asset'] as const)('rejects a %s FIFO promptly through actual production IO and preserves its bytes', async operation => {
  const f = await fixture(), ref = await f.images.save(f.categoryTarget, imageInput())
  const path = operation === 'category' ? join(f.category.directoryPath, 'category.md') : join(f.category.directoryPath, '.agentmux/avatars', ref.fileName)
  const retained = path + '.retained'; await rename(path, retained)
  await promisify(execFile)('/usr/bin/mkfifo', [path])
  const before = await stat(path), result = await fifoObservation({ operation, workspace: f.workspace, target: f.categoryTarget, ref })
  expect(result.status, result.message).toBe('rejected')
  const after = await stat(path); expect(after.isFIFO()).toBe(true); expect(after.ino).toBe(before.ino)
  expect(await readFile(retained)).toEqual(operation === 'category' ? Buffer.from('# 分类原名\n') : imagePng())
})
