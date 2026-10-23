/* Native protocol qualification; this does not start a Host or qualify its Node engine. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const options = Object.fromEntries(process.argv.slice(2).map(value => { const at = value.indexOf('='); return [value.slice(2, at), value.slice(at + 1)] }))
const helper = resolve(options.helper), identity = await import(pathToFileURL(resolve(options.identity)).href)
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), revision = bytes => `sha256:${hash(bytes)}`
const scope = await realpath(await mkdtemp(join(options.scratch ?? tmpdir(), 'native-protocol-'))); await chmod(scope, 0o700)
const cases = [], calls = []
async function execute(args, cwd, input = '') {
  const child = spawn(helper, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
  child.stdin.on('error', () => {}); child.stdin.end(input)
  const exit = await new Promise((accept, reject) => { child.on('error', reject); child.on('close', (code, signal) => accept({ code, signal })) })
  const result = { ...exit, stdout, stderr }
  calls.push({ mode: args[0], action: args[0] === '--workspace-file' ? args[1] : undefined, ...exit, stdoutBytes: Buffer.byteLength(stdout), stderr })
  return result
}
const file = (root, action, name, opts = {}) => execute(['--workspace-file', action, root, name, opts.expected ?? 'null', opts.exclusive ? '1' : '0', '1', opts.fault ?? '', String(opts.offset ?? 0), String(opts.maxBytes ?? 0), String(opts.maxFileBytes ?? 0), opts.readRevision ?? 'null'], root, opts.input)
async function test(name, action) {
  if (options.case && options.case !== name) return
  const root = join(scope, name); await mkdir(root, { mode: 0o700 }); const evidence = {}
  try { await action(root, evidence); cases.push({ name, passed: true, evidence }) }
  catch (error) { cases.push({ name, passed: false, error: { name: error.name, code: error.code, message: error.message }, evidence }) }
}
async function mote(root) {
  const topicId = 'view:native-original', directory = join(root, 'topic--view--native-original'); await mkdir(directory)
  return { directory, context: { topicId, original: directory, roots: { scratch: [root], topics: [], motes: [] } },
    current: join(directory, identity.SCRATCH_DIRECTORY_IDENTITY_PATH), pending: join(directory, identity.SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH) }
}
async function exists(path) { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function retain(h, options = {}) { return identity.retainDirectoryIdentity(h.directory, h.context, { helperPath: helper, ...options }) }
try {
  await test('ordinary-io', async (root, evidence) => {
    const bytes = 'Original MOTE.md\n中文🙂\n', created = await file(root, 'write', 'MOTE.md', { exclusive: true, input: bytes })
    assert.equal(created.code, 0); const receipt = JSON.parse(created.stdout)
    assert.equal(receipt.status, 'written'); assert.equal(receipt.revision, revision(bytes)); assert.ok(BigInt(receipt.fileWitness.inode) > 0n)
    assert.equal((await file(root, 'read', 'MOTE.md')).stdout, bytes)
    const range = JSON.parse((await file(root, 'read-bytes', 'MOTE.md', { offset: 3, maxBytes: 7, maxFileBytes: 16 * 1024 * 1024, readRevision: receipt.revision })).stdout)
    assert.deepEqual(Buffer.from(range.data, 'base64'), Buffer.from(bytes).subarray(3, 10)); assert.equal(range.revision, receipt.revision)
    assert.equal(range.nextOffset, 10); assert.equal(range.readCost.payloadBytes, Buffer.byteLength(bytes))
    const changed = await file(root, 'write', 'MOTE.md', { expected: receipt.revision, input: 'Edited\n' }); assert.equal(JSON.parse(changed.stdout).status, 'written')
    const stale = await file(root, 'write', 'MOTE.md', { expected: receipt.revision, input: 'stale' }); assert.equal(JSON.parse(stale.stdout).status, 'conflict')
    assert.equal((await file(root, 'read', 'MOTE.md')).stdout, 'Edited\n')
    evidence.created = receipt; evidence.range = range; evidence.stale = JSON.parse(stale.stdout)
  })
  await test('write-receipt-unknown', async (root, evidence) => {
    await writeFile(join(root, 'MOTE.md'), 'before')
    const result = await file(root, 'write', 'MOTE.md', { expected: revision('before'), input: 'after', fault: 'receipt' })
    assert.notEqual(result.code, 0); const error = JSON.parse(result.stderr.split('\n').find(line => line.startsWith('AGENTMUX_WORKSPACE_ERROR:')).slice('AGENTMUX_WORKSPACE_ERROR:'.length))
    assert.equal(error.writeOutcomeUnknown, true); assert.equal(await readFile(join(root, 'MOTE.md'), 'utf8'), 'after'); evidence.error = error
  })
  await test('exclusive-competitor', async (root, evidence) => {
    const result = await file(root, 'write', 'MOTE.md', { exclusive: true, input: 'mine', fault: 'occupy' })
    assert.equal(JSON.parse(result.stdout).status, 'conflict'); assert.equal(await readFile(join(root, 'MOTE.md'), 'utf8'), 'competing bytes'); evidence.receipt = JSON.parse(result.stdout)
  })
  await test('exact-file-boundaries', async (root, evidence) => {
    await writeFile(join(root, 'original'), 'kept'); await symlink('original', join(root, 'link')); await mkdir(join(root, 'directory'))
    for (const name of ['link', 'directory', '../original']) assert.notEqual((await file(root, 'read', name)).code, 0)
    assert.equal(await readFile(join(root, 'original'), 'utf8'), 'kept')
    if (process.platform === 'linux') {
      for (const action of ['create', 'delete', 'delete-exact', 'list', 'reveal']) {
        const result = await file(root, action, 'original'); assert.notEqual(result.code, 0); assert.match(result.stderr, /WORKSPACE_FILE_UNSUPPORTED_OPERATION/)
        assert.doesNotMatch(result.stderr, /AGENTMUX_WORKSPACE_READY/)
      }
      const info = await lstat(root); assert.notEqual((await execute([root, String(info.dev), String(info.ino), 'original', 'moved'], root)).code, 0)
      assert.equal(await readFile(join(root, 'original'), 'utf8'), 'kept')
    }
    evidence.originalHash = hash(await readFile(join(root, 'original')))
  })
  await test('identity-confirmed', async (root, evidence) => {
    const h = await mote(root)
    try {
      let observed, failure
      try { observed = await retain(h) } catch (error) { failure = error; evidence.failureCode = error.code }
      assert.ifError(failure); assert.equal(observed.needsUpgrade, false)
      const current = JSON.parse(await readFile(h.current, 'utf8')); assert.deepEqual(current, identity.directoryIdentityRecord(h.context))
      assert.equal(await exists(h.pending), false); evidence.current = current
      const reopened = await identity.inspectDirectoryIdentity(h.directory, h.context); assert.equal(reopened.needsUpgrade, false); assert.equal(reopened.identityDirectoryPath, h.directory)
    } finally { evidence.pendingExists = await exists(h.pending); if (evidence.pendingExists) evidence.pendingBytes = await readFile(h.pending, 'utf8') }
  })
  await test('identity-no-replace', async (root, evidence) => {
    const h = await mote(root), foreign = 'foreign current identity\n'
    let failure
    try { await retain(h, { beforeCommit: async () => { evidence.originalPendingBytes = await readFile(h.pending, 'utf8'); await writeFile(h.current, foreign) } }) } catch (error) { failure = error }
    evidence.failureCode = failure?.code; evidence.currentBytes = await readFile(h.current, 'utf8'); evidence.pendingExists = await exists(h.pending)
    if (evidence.pendingExists) evidence.pendingBytes = await readFile(h.pending, 'utf8')
    assert.ok(evidence.originalPendingBytes.includes(h.context.topicId)); assert.equal(evidence.currentBytes, foreign); assert.equal(evidence.pendingExists, true); assert.ok(failure)
  })
  for (const fault of ['publicationSyncFault', 'afterReplace']) await test(`identity-unknown-${fault}`, async (root, evidence) => {
    const h = await mote(root); let failure
    try { await retain(h, fault === 'afterReplace' ? { afterReplace: () => { throw new Error('lost original ACK') } } : { publicationSyncFault: true }) } catch (error) { failure = error }
    assert.equal(failure?.code, 'DIRECTORY_IDENTITY_WRITE_UNKNOWN'); evidence.pendingBytes = await readFile(h.pending, 'utf8'); assert.ok(evidence.pendingBytes.includes(h.context.topicId))
    const before = await identity.inspectDirectoryIdentity(h.directory, h.context); assert.equal(before.needsUpgrade, true)
    const retried = await retain(h); assert.equal(retried.needsUpgrade, false); assert.equal(await exists(h.pending), false)
    evidence.failureCode = failure.code; evidence.current = JSON.parse(await readFile(h.current, 'utf8'))
  })
  if (process.platform === 'darwin') await test('darwin-original-move-alias', async (root, evidence) => {
    await mkdir(join(root, 'source')); const rootInfo = await lstat(root), original = await lstat(join(root, 'source'))
    const moved = await execute([root, String(rootInfo.dev), String(rootInfo.ino), 'source', 'destination'], root)
    assert.equal(moved.code, 0); assert.equal((await lstat(join(root, 'destination'))).ino, original.ino)
    await mkdir(join(root, 'source')); const occupied = await execute([root, String(rootInfo.dev), String(rootInfo.ino), 'source', 'destination'], root)
    assert.notEqual(occupied.code, 0); assert.equal((await lstat(join(root, 'destination'))).ino, original.ino)
    await mkdir(join(root, 'from')); await mkdir(join(root, 'to')); await mkdir(join(root, 'from', 'original'))
    const object = await lstat(join(root, 'from', 'original'))
    const alias = await execute(['--alias-swap', root, String(rootInfo.dev), String(rootInfo.ino), 'from/original', 'to/original', String(object.dev), String(object.ino)], root)
    assert.equal(alias.code, 0); assert.equal((await lstat(join(root, 'to', 'original'))).ino, object.ino)
    assert.equal(await readlink(join(root, 'from', 'original')), '../to/original')
    evidence.movedInode = original.ino; evidence.aliasObjectInode = object.ino; evidence.occupiedCode = occupied.code
  })
  const report = { schema: 'agentmux.native-file-consumer.v1', platform: process.platform, arch: process.arch, node: process.version, helperSha256: hash(await readFile(helper)), identitySha256: hash(await readFile(options.identity)), cases, calls }
  assert.ok(cases.length > 0)
  if (options.report) await writeFile(options.report, JSON.stringify(report, null, 2) + '\n')
  else process.stdout.write(JSON.stringify(report) + '\n')
  process.exitCode = cases.every(item => item.passed) ? 0 : 1
} finally { await rm(scope, { recursive: true, force: true }) }
