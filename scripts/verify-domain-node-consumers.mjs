import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const desktop = resolve(root, 'apps/desktop')
const asUrl = path => pathToFileURL(path).href
const digest = value => createHash('sha256').update(value).digest('hex')
const resolvePackage = name => import.meta.resolve(name, asUrl(join(desktop, 'package.json')))

async function exerciseHost(mutation) {
  const noteWriter = resolvePackage('@agentmux/host/note-file-writer')
  const themeObserver = resolvePackage('@agentmux/host/theme-observation')
  const resolved = new Map()
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const expectedThemeMutation = mutation === 'rendered-theme' && context.parentURL === themeObserver && specifier === '@agentmux/client-ui/theme/model'
    const actual = expectedThemeMutation ? '@agentmux/client-ui/theme' : specifier
    const result = next(actual, context)
    resolved.set(result.url, actual)
    return result
  } })
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-domain-node-')))
  try {
    const consume = specifier => import(resolvePackage(specifier))
    const { themeObservation } = await import(themeObserver)
    const appearance = { themeId: 'graphite', appAppearance: 'light', terminalTheme: 'graphite' }
    const theme = await themeObservation({
      inspect: async capture => capture({ appearance }),
      subscribe() { return () => {} }
    }).subscribe(() => {}, () => {}, new AbortController().signal)
    assert.equal(theme.initial.values.themeId, appearance.themeId)
    assert.equal(theme.initial.values.appAppearance, appearance.appAppearance)
    assert.ok(theme.initial.values.terminalPalette)
    theme.dispose()

    const { createHostMoteAvatarRead } = await consume('@agentmux/host/mote-avatar-read')
    const { ScratchTopics } = await consume('@agentmux/host/mote-resources')
    const { directoryIdentity, SCRATCH_WORKSPACE_ID } = await consume('@agentmux/host/mote-model')
    const { DEFAULT_MOTE_FACE } = await consume('@agentmux/core/mote-face')
    const avatarWorkspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(temporary, 'topics') }
    await mkdir(avatarWorkspace.path)
    const topic = await new ScratchTopics().ensureMote(avatarWorkspace, 'view:review')
    const target = { workspaceId: avatarWorkspace.id, topicId: topic.id, objectKey: directoryIdentity('local', topic.identityDirectoryPath) }
    const configurationPath = join(temporary, 'client-config.json')
    await writeFile(configurationPath, JSON.stringify({ workspaces: [avatarWorkspace], appearance: { spaceObjectIcons: { [target.objectKey]: DEFAULT_MOTE_FACE } } }))
    const avatarReader = createHostMoteAvatarRead({ configurationPath })
    const artwork = await avatarReader.read(target)
    const png = artwork.image
    assert.equal(png?.width, 256)
    assert.equal(png?.height, 256)
    assert.match(png.dataUrl, /^data:image\/png;base64,/u)
    assert.deepEqual(await avatarReader.read(target), artwork)

    const { NoteFileWriter } = await import(noteWriter)
    const { OrdinaryWorkspaceFiles } = await consume('@agentmux/host/ordinary-files')
    const { AgentMuxNotebookStore } = await consume('@agentmux/core/notebook-store')
    const { newNoteDocument, serializeNoteDocument, readNoteDocument } = await consume('@agentmux/client-ui/note/note-document')
    const metadata = new AgentMuxNotebookStore(join(temporary, 'notebooks.root.json'))
    const writer = new NoteFileWriter(new OrdinaryWorkspaceFiles(), undefined, metadata)
    const workspace = { id: 'journal', hostId: 'local', path: temporary, name: 'Journal', kind: 'folder' }
    const path = 'findings.note.md'
    const person = { kind: 'user', id: 'editor' }
    const agent = { kind: 'agent', id: 'reviewer' }
    const initial = newNoteDocument('First finding', 'original-note', 'first')
    initial.content.content.push({ type: 'paragraph', attrs: { blockId: 'second' }, content: [{ type: 'text', text: 'Second finding' }] })
    const original = await writer.write(workspace, { path, content: serializeNoteDocument(initial), expectedRevision: null }, { actor: person })
    assert.equal(original.status, 'written', JSON.stringify(original))
    const base = await readFile(join(temporary, path), 'utf8')
    const edit = (operationId, before, after, actor) => writer.write(workspace, {
      path, content: base.replace(before, after), expectedRevision: original.revision, baseContent: base, operationId
    }, { actor })
    assert.equal((await edit('first-edit', 'First finding', 'Verified first finding', person)).status, 'written')
    assert.equal((await edit('second-edit', 'Second finding', 'Verified second finding', agent)).status, 'written')
    const result = await writer.read(workspace, path)
    assert.equal(result.status, 'read')
    assert.equal(result.document.revision, 'sha256:' + digest(result.document.content))
    assert.match(result.document.content, /Verified first finding/u)
    assert.match(result.document.content, /Verified second finding/u)
    assert.equal(readNoteDocument(result.document.content).note.noteId, initial.noteId)
    assert.equal(result.document.noteProvenance.blocks.second.created.actor.id, person.id)
    assert.equal(result.document.noteProvenance.blocks.second.lastEdited.actor.id, agent.id)

    assert.equal(typeof window, 'undefined')
    assert.equal(typeof document, 'undefined')
    const modules = [...resolved.keys()].filter(url => url.startsWith('file:')).map(fileURLToPath)
    for (const name of ['theme/model.js', 'note-content-schema.js', 'react-dom/server.node.js'])
      assert.ok(modules.some(file => file.endsWith('/' + name)), 'Expected legitimate Node module ' + name)
    assert.ok(modules.some(file => /\/@tiptap\/core\/dist\//u.test(file)), 'The original Tiptap schema is evaluated in Node')
    const forbidden = modules.filter(file => /\/(?:theme\/runtime\.js|client-ui\/dist\/(?:index|platform)\.js|note-editor-extensions\.js|@xterm\/|@tiptap\/react\/|react-dom\/client\.js|apps\/(?:desktop|mobile)\/src\/)/u.test(file))
    assert.deepEqual(forbidden.map(file => relative(root, file)), [], 'Node paths loaded a browser or an unrelated editor module')
    for (const file of [
      'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx',
      'apps/mobile/src/MobileApp.tsx',
      'apps/mobile/src/conversation/MobileConversationSurface.tsx'
    ]) {
      const source = await readFile(join(root, file), 'utf8')
      assert.match(source, /import\s*\{[^}]*ClientUiProvider[^}]*\}\s*from '@agentmux\/client-ui\/platform'/u)
    }
    console.log(JSON.stringify({ passed: true, theme: theme.initial.values.themeId, avatar: artwork.revision,
      note: result.document.revision, editedBlocks: ['first', 'second'], nodeFiles: modules.length }))
  } finally {
    hooks.deregister()
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--node') {
  await exerciseHost(process.argv[3])
} else {
  const run = variant => spawnSync(process.execPath, ['--experimental-import-meta-resolve', fileURLToPath(import.meta.url), '--node', ...(variant ? [variant] : [])],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 60_000 })
  const normal = run()
  assert.equal(normal.status, 0, normal.stderr)
  const mutation = run('rendered-theme')
  assert.equal(mutation.status, 1, mutation.stderr)
  assert.match(mutation.stderr, /Node paths loaded a browser or an unrelated editor module/u)
  assert.match(mutation.stderr, /theme\/runtime\.js/u)
  const restore = run()
  assert.equal(restore.status, 0, restore.stderr)
  const directory = join(root, '.tmp/domain-node-consumers')
  await mkdir(directory, { recursive: true })
  const inputs = Object.fromEntries(await Promise.all([
    'apps/host/dist/theme-observation.js', 'apps/host/dist/note-file-writer.js', 'apps/host/dist/mote-avatar-read.js',
    'packages/client-ui/dist/theme/model.js', 'packages/client-ui/dist/note/note-content-schema.js'
  ].map(async file => [file, digest(await readFile(join(root, file)))])))
  const receipt = { inputs, normal: JSON.parse(normal.stdout), mutation: 'rendered-theme', restored: JSON.parse(restore.stdout) }
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
}
