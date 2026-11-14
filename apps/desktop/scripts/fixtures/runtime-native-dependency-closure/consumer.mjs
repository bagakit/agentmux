import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const [kind, root, work] = process.argv.slice(2), require = createRequire(join(root, 'package.json'))
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const inside = async path => {
  const physical = await realpath(path), offset = relative(await realpath(root), physical)
  assert.ok(offset !== '..' && !offset.startsWith('..' + sep), 'The isolated consumer must not resolve development dependencies')
  return physical
}
if (kind === 'react') {
  const React = require('react'), server = require('react-dom/server')
  const domReact = createRequire(require.resolve('react-dom'))('react')
  function Counter() { const [value] = React.useState(23); return React.createElement('span', null, String(value)) }
  let rendered
  try { rendered = server.renderToStaticMarkup(React.createElement(Counter)) }
  catch (error) { assert.fail(`Actual React hooks and react-dom/server must share the original dispatcher: ${error.stack}`) }
  assert.equal(rendered, '<span>23</span>')
  assert.strictEqual(React, domReact, 'Root React and react-dom peer must be the same module object')
  await inside(require.resolve('react')); await inside(createRequire(require.resolve('react-dom')).resolve('react'))
  process.stdout.write(JSON.stringify({ kind, independent: true, rendered, originalPeerObjectShared: true }) + '\n')
} else if (kind === 'graph' || kind === 'same-peer' || kind.startsWith('cycle')) {
  const value = require(root)
  assert.deepEqual(value, { ordinary: 7, optional: 11, rootPeer: 17,
    first: { ordinary: 7, peer: 1, rootPeer: { value: 17 } }, second: { ordinary: 7, peer: 2, rootPeer: { value: 17 } },
    ...(kind.startsWith('cycle') ? { cycle: { marker: 'a', b: { marker: 'b', a: 'a' } } } : {}) }, 'Original installed peer contexts and ordinary/optional dependencies must survive')
  if (kind.startsWith('cycle')) {
    const entry = require.resolve(kind === 'cycle-alias' ? 'cycle-entry' : 'cycle-a')
    const dependency = createRequire(entry).resolve('cycle-b'), backEdge = createRequire(dependency).resolve('cycle-a')
    assert.equal(await inside(backEdge), await inside(entry), 'The peer back-edge must reach the same copied original object')
  }
  assert.strictEqual(value.first.rootPeer, require('root-peer'), 'A shared physical peer must retain its original module object')
  assert.strictEqual(value.second.rootPeer, require('root-peer'), 'Both installed peer contexts must retain the shared peer object')
  for (const name of ['ordinary', 'present-optional', 'root-peer', 'first', 'second', '@agentmux/capsule']) await inside(require.resolve(name))
  assert.equal(await readFile(join(root, 'node_modules/ordinary/installed-runtime.txt'), 'utf8'), 'installed files remain runtime files')
  await assert.rejects(readFile(join(root, 'node_modules/@agentmux/capsule/private-source.txt')), { code: 'ENOENT' })
  const foreign = JSON.parse(await readFile(join(root, 'node_modules/foreign-installed-optional/package.json'), 'utf8'))
  assert.notEqual(foreign.os[0], process.platform, 'An installed optional from another target must also be preserved as installed')
  process.stdout.write(JSON.stringify({ kind, independent: true, value, ...(kind.startsWith('cycle') ? { originalCycleObjectReused: true } : {}), foreignOptionalPreserved: true,
    foreignOptionalExecuted: false }) + '\n')
} else {
  const resolved = await inside(require.resolve('koffi')), koffi = require('koffi')
  const library = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6')
  assert.equal(library.func('int getpid()')(), process.pid, 'The copied native binary must execute')
  const native = Object.keys(require.cache).filter(path => path.endsWith('.node') && path.includes('koffi'))
  assert.ok(native.length > 0, 'The actual copied Koffi Node-API binary must load')
  for (const path of native) await inside(path)
  const directory = await import(pathToFileURL(join(root, 'dist/directory-write.js')).href)
  const clone = await import(pathToFileURL(join(root, 'dist/native-file-clone.js')).href)
  await mkdir(work, { recursive: true })
  const physical = await realpath(work), identity = await stat(physical, { bigint: true })
  const parent = await directory.openDirectoryWriteParent(physical, { realpath: physical,
    dev: identity.dev.toString(), ino: identity.ino.toString() })
  let source
  try {
    await directory.writeDirectoryFile(parent, 'original.jsonl', '{"original":true}\n', 0o600)
    assert.equal(await directory.readDirectoryFile(parent, 'original.jsonl'), '{"original":true}\n')
    await directory.syncDirectoryWriteParent(parent)
    const destination = join(work, 'snapshot'); await mkdir(destination)
    source = await open(join(work, 'original.jsonl'), 'r')
    const result = await clone.cloneNativeFile(source, destination, 'source.jsonl', new AbortController().signal)
    assert.equal(result.origin.ino, (await source.stat({ bigint: true })).ino)
    assert.equal(await readFile(join(destination, 'source.jsonl'), 'utf8'), '{"original":true}\n')
    process.stdout.write(JSON.stringify({ kind, platform: process.platform, arch: process.arch,
      independent: true, koffi: resolved, native: await Promise.all(native.map(async path => ({ path, sha256: await hash(path) }))),
      coreModules: Object.fromEntries(await Promise.all(['directory-write', 'native-file-clone', 'errors'].map(async name =>
        [name, await hash(join(root, 'dist', name + '.js'))]))),
      directoryWriteAcknowledged: true, originalFdCloneAcknowledged: true }) + '\n')
  } finally { await source?.close(); await parent.handle.close() }
}
