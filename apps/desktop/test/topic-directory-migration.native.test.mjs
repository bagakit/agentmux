import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { before, test } from 'node:test'
import { migrateTopicDirectories } from '../scripts/migrate-topic-directories.mjs'
import { directoryIdentityRecord } from '../src/main/scratch-directory-identity.mjs'

const repository = resolve(import.meta.dirname, '../../..')
let artifacts, helper
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const entityName = identity => `topic--launcher--${identity}`
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.error}`)
  return result.stdout
}
const inode = info => `${info.dev}:${info.ino}:${BigInt(info.mode) & 0o170000n}`
const metadataName = '.agentmux/directory-identity.json'

before(async () => {
  assert.equal(process.platform, 'darwin', 'This proof requires a real macOS alias-exchange implementation.')
  await mkdir(join(repository, '.tmp'), { recursive: true })
  artifacts = await mkdtemp(join(repository, '.tmp/topic-directory-native-'))
  helper = join(artifacts, 'workspace-move')
  run('xcrun', ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', join(repository, 'apps/desktop/native/workspace-move.c'), '-o', helper])
  const files = ['apps/desktop/native/workspace-move.c', 'apps/desktop/scripts/migrate-topic-directories.mjs', 'apps/desktop/test/topic-directory-migration.native.test.mjs', 'apps/desktop/src/main/scratch-directory-identity.mjs']
  await writeFile(join(artifacts, 'source-inputs.json'), JSON.stringify({ files: Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(repository, file)))]))), helperSha256: hash(await readFile(helper)) }, null, 2))
})

async function homeFixture(label) {
  const home = join(artifacts, label)
  await mkdir(join(home, '.agentmux/scratch'), { recursive: true })
  return home
}

async function entity(home, id, mote = false) {
  const path = join(home, '.agentmux/scratch', entityName(id))
  for (const directory of ['.agentmux/avatars', '.agents', 'refs', 'outcome']) await mkdir(join(path, directory), { recursive: true })
  for (const file of ['topic.md', '.agentmux/topic-wiki.md', '.agentmux/topic-wiki.json', '.agents/probe.identity.md', 'refs/ref.txt', 'outcome/result.txt', '.hidden', 'ordinary.txt']) await writeFile(join(path, file), `isolated ${file}\n`)
  await writeFile(join(path, '.agentmux/avatars/fixture.png'), 'isolated avatar bytes')
  if (mote) await writeFile(join(path, 'SOUL.md'), 'isolated soul\n')
  await symlink('refs/ref.txt', join(path, 'local-reference'))
  return path
}

async function inventory(path) {
  const rows = { '.': inode(await lstat(path, { bigint: true })) }
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const p = join(directory, name), info = await lstat(p, { bigint: true })
      const relative = p.slice(path.length + 1)
      rows[relative] = { inode: inode(info), ...(info.isFile() ? { sha256: hash(await readFile(p)) } : info.isSymbolicLink() ? { link: await readlink(p) } : {}) }
      if (info.isDirectory()) await walk(p)
    }
  }
  await walk(path)
  return rows
}

function withoutIdentity(rows) {
  const copy = { ...rows }
  delete copy[metadataName]
  return copy
}

async function aliasArgs(home, source, destination) {
  const root = join(home, '.agentmux')
  const rootInfo = await stat(root, { bigint: true }), sourceInfo = await lstat(source, { bigint: true })
  return ['--alias-swap', root, String(rootInfo.dev), String(rootInfo.ino), 'scratch/' + source.split('/').at(-1), destination, String(sourceInfo.dev), String(sourceInfo.ino)]
}

const workerSource = `
import { statSync, lstatSync, readFileSync } from 'node:fs';
const [old, mode] = process.argv.slice(1), initial = statSync('.');
const result = {pid:process.pid, mode, samples:0, original:0, alias:0, errors:[], cwd:[]};
const tick = () => {try {const cwd=statSync('.'), path=mode==='relative'?'.':old, actual=statSync(path);
 if(cwd.dev!==initial.dev||cwd.ino!==initial.ino||actual.dev!==initial.dev||actual.ino!==initial.ino)throw new Error('cwd inode changed');
 if(readFileSync(path+'/SOUL.md','utf8')!=='isolated soul\\n')throw new Error('source bytes changed');
 result.samples++;result[lstatSync(old).isSymbolicLink()?'alias':'original']++;if(!result.cwd.includes(process.cwd()))result.cwd.push(process.cwd());
 }catch(error){result.errors.push({code:error.code,message:error.message})}};
const timer=setInterval(tick,1);tick();process.stdout.write('ready\\n');
process.stdin.once('data',()=>{clearInterval(timer);tick();process.stdout.write(JSON.stringify(result)+'\\n');process.exit(0)});
`

test('actual helper and script retain cwd, every asset inode, dirty Git and durable identity across restart', async () => {
  const home = await homeFixture('live-cwd'), old = await entity(home, 'live', true)
  run('git', ['init', '-q', old])
  await writeFile(join(old, 'tracked.md'), 'initial\n')
  run('git', ['-C', old, 'add', 'tracked.md'])
  run('git', ['-C', old, '-c', 'user.name=Migration Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'test: seed directory fixture'])
  await writeFile(join(old, 'tracked.md'), 'dirty\n')
  await writeFile(join(old, 'staged.md'), 'staged\n')
  run('git', ['-C', old, 'add', 'staged.md'])
  const git = path => run('git', ['--no-optional-locks', '-C', path, 'status', '--porcelain=v1', '--untracked-files=all'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
  const oldGit = git(old), oldIndex = hash(await readFile(join(old, '.git/index')))
  const before = await inventory(old)
  const workers = ['relative', 'absolute-old'].map(mode => spawn(process.execPath, ['--input-type=module', '-e', workerSource, old, mode], { cwd: old, stdio: ['pipe', 'pipe', 'pipe'] }))
  const outputs = workers.map(() => '')
  await Promise.all(workers.map((child, index) => new Promise((resolveReady, reject) => {
    child.stdout.on('data', bytes => { outputs[index] += bytes; if (outputs[index].startsWith('ready\n')) resolveReady() })
    child.once('error', reject)
    child.once('exit', value => { if (!outputs[index].startsWith('ready\n')) reject(new Error(`worker exit ${value}`)) })
  })))
  let receipt, results
  try {
    await wait(100)
    receipt = await migrateTopicDirectories({ home, execute: true, helperPath: helper })
    await wait(100)
  } finally {
    await Promise.all(workers.map(async child => { const closed = once(child, 'close'); child.stdin.end('stop'); await closed }))
    results = outputs.map(output => JSON.parse(output.split('\n').at(-2)))
  }
  assert.equal(receipt.success, true, JSON.stringify(receipt))
  assert.equal(receipt.objects[0].state, 'migrated')
  const canonical = join(home, '.agentmux/motes', entityName('live'))
  assert.equal(await readlink(old), '../motes/' + entityName('live'))
  assert.equal(inode(await stat(old, { bigint: true })), before['.'])
  assert.deepEqual(withoutIdentity(await inventory(canonical)), before)
  assert.equal(git(canonical).replace('?? ' + metadataName + '\n', ''), oldGit)
  assert.equal(hash(await readFile(join(canonical, '.git/index'))), oldIndex)
  const savedIdentity = JSON.parse(await readFile(join(canonical, metadataName), 'utf8'))
  assert.deepEqual(savedIdentity, directoryIdentityRecord(old))
  assert.equal(JSON.stringify(savedIdentity).includes(home), false)
  for (const result of results) {
    assert.deepEqual(result.errors, [])
    assert.ok(result.samples > 20 && result.original > 0 && result.alias > 0, JSON.stringify(result))
  }
  const second = JSON.parse(run(process.execPath, [join(repository, 'apps/desktop/scripts/migrate-topic-directories.mjs'), '--execute', '--home', home, '--helper-path', helper]))
  assert.equal(second.success, true)
  assert.equal(second.objects[0].state, 'already-migrated')
  assert.deepEqual(await inventory(canonical), { ...before, [metadataName]: (await inventory(canonical))[metadataName] })
  await writeFile(join(artifacts, 'live-cwd-receipt.json'), JSON.stringify({ receipt, second, before, after: await inventory(canonical), workers: results, oldIndex, savedIdentity }, null, 2))
})

test('dry-run is read-only; primary, regular SOUL and archived entities classify correctly; loose files stay', async () => {
  const home = await homeFixture('classification')
  const topic = await entity(home, 'plain'), primary = await entity(home, 'leader'), custom = await entity(home, 'custom', true), archived = await entity(home, 'archived', true)
  await writeFile(join(archived, '.agentmux/mote-state.json'), '{"archived":true,"version":"fixture"}\n')
  await writeFile(join(home, '.agentmux/scratch/loose.md'), 'loose fixture stays\n')
  const before = await inventory(join(home, '.agentmux'))
  const dry = await migrateTopicDirectories({ home })
  assert.equal(dry.success, true)
  assert.equal(dry.objects.length, 4)
  assert.deepEqual(dry.objects.map(x => [x.id, x.kind]).sort(), [['launcher:archived', 'mote'], ['launcher:custom', 'mote'], ['launcher:leader', 'mote'], ['launcher:plain', 'topic']])
  assert.deepEqual(await inventory(join(home, '.agentmux')), before)
  const moved = await migrateTopicDirectories({ home, execute: true, helperPath: helper })
  assert.equal(moved.success, true, JSON.stringify(moved))
  for (const path of [primary, custom, archived]) assert.equal(await readlink(path), '../motes/' + path.split('/').at(-1))
  assert.equal(await readlink(topic), '../topics/' + entityName('plain'))
  assert.equal(await readFile(join(home, '.agentmux/scratch/loose.md'), 'utf8'), 'loose fixture stays\n')
})

test('an explicitly selected home alias preserves its original logical identity and confirms physical IO', async () => {
  const actualHome = await homeFixture('aliased-home-real')
  await entity(actualHome, 'home-alias', true)
  const home = join(artifacts, 'home-alias')
  await symlink('aliased-home-real', home)
  const original = join(home, '.agentmux/scratch', entityName('home-alias'))
  const report = await migrateTopicDirectories({ home, execute: true, helperPath: helper })
  assert.equal(report.success, true, JSON.stringify(report))
  assert.equal(report.objects[0].state, 'migrated')
  assert.deepEqual(JSON.parse(await readFile(join(actualHome, '.agentmux/motes', entityName('home-alias'), metadataName), 'utf8')), directoryIdentityRecord(original))
  const second = await migrateTopicDirectories({ home, execute: true, helperPath: helper })
  assert.equal(second.success, true)
  assert.equal(second.objects[0].state, 'already-migrated')
})

test('existing target content and conflicting durable identity are never overwritten', async () => {
  const home = await homeFixture('conflicts'), old = await entity(home, 'conflict', true)
  const target = join(home, '.agentmux/motes', entityName('conflict'))
  await mkdir(target, { recursive: true }); await writeFile(join(target, 'keep.txt'), 'existing target\n')
  const before = await inventory(join(home, '.agentmux'))
  const report = await migrateTopicDirectories({ home, execute: true, helperPath: helper })
  assert.equal(report.success, false)
  assert.equal(report.objects[0].issue.code, 'DIRECTORY_MIGRATION_TARGET_EXISTS')
  assert.deepEqual(await inventory(join(home, '.agentmux')), before)
  const direct = spawnSync(helper, await aliasArgs(home, old, 'motes/' + entityName('conflict')), { encoding: 'utf8' })
  assert.notEqual(direct.status, 0); assert.match(direct.stderr, /verify-alias-destination-absent/)
  assert.deepEqual(await inventory(join(home, '.agentmux')), before)
  const corrupt = await entity(home, 'wrong-identity', true)
  await writeFile(join(corrupt, metadataName), JSON.stringify({ version: 1, identityDirectoryPath: join(home, '.agentmux/scratch', entityName('somebody-else')) }))
  const corruptBefore = await inventory(corrupt)
  const again = await migrateTopicDirectories({ home, execute: true, helperPath: helper })
  assert.equal(again.objects.find(x => x.id === 'launcher:wrong-identity').issue.code, 'DIRECTORY_IDENTITY_INVALID')
  assert.deepEqual(await inventory(corrupt), corruptBefore)
})

test('unknown SOUL and arbitrary aliases cannot acquire migration permission', async () => {
  const home = await homeFixture('unknown'), unknown = await entity(home, 'unknown')
  await symlink('ordinary.txt', join(unknown, 'SOUL.md'))
  const arbitrary = join(home, '.agentmux/scratch', entityName('arbitrary'))
  await symlink('../../outside', arbitrary)
  const before = await inventory(join(home, '.agentmux'))
  const report = await migrateTopicDirectories({ home, execute: true, helperPath: helper })
  assert.equal(report.success, false)
  assert.equal(report.objects.find(x => x.id === 'launcher:unknown').state, 'unknown')
  assert.equal(report.objects.find(x => x.id === 'launcher:arbitrary').issue.code, 'DIRECTORY_MIGRATION_ALIAS_INVALID')
  assert.deepEqual(await inventory(join(home, '.agentmux')), before)
})

test('strict identity schema accepts its two fields and rejects extra fields or oversized records without moving', async () => {
  const validHome = await homeFixture('valid-existing-identity'), valid = await entity(validHome, 'valid-record', true)
  await writeFile(join(valid, metadataName), JSON.stringify({ version: 1, identityDirectoryPath: valid }) + '\n')
  const validBefore = await inventory(valid)
  const accepted = await migrateTopicDirectories({ home: validHome, execute: true, helperPath: helper })
  assert.equal(accepted.success, true)
  const validAfter = await inventory(join(validHome, '.agentmux/motes', entityName('valid-record')))
  assert.deepEqual(withoutIdentity(validAfter), withoutIdentity(validBefore))
  assert.deepEqual(JSON.parse(await readFile(join(validHome, '.agentmux/motes', entityName('valid-record'), metadataName), 'utf8')), directoryIdentityRecord(valid))
  for (const shape of ['extra-field', 'oversized']) {
    const home = await homeFixture('invalid-' + shape), old = await entity(home, 'invalid-record', true)
    let record = JSON.stringify({ version: 1, identityDirectoryPath: old, ...(shape === 'extra-field' ? { extra: 'unexpected' } : {}) })
    if (shape === 'oversized') record += ' '.repeat(4097 - Buffer.byteLength(record))
    await writeFile(join(old, metadataName), record)
    const before = await inventory(join(home, '.agentmux'))
    const refused = await migrateTopicDirectories({ home, execute: true, helperPath: helper })
    assert.equal(refused.success, false, shape)
    assert.equal(refused.objects[0].issue.code, 'DIRECTORY_IDENTITY_INVALID', shape)
    assert.equal((await lstat(old)).isDirectory(), true, shape)
    assert.deepEqual(await inventory(join(home, '.agentmux')), before, shape)
  }
})

test('native action refuses source identity drift and symlinked canonical parent before stage', async () => {
  const home = await homeFixture('native-guards'), old = await entity(home, 'guard', true)
  await mkdir(join(home, '.agentmux/motes'))
  const args = await aliasArgs(home, old, 'motes/' + entityName('guard'))
  args[7] = String(BigInt(args[7]) + 1n)
  const before = await inventory(join(home, '.agentmux'))
  const stale = spawnSync(helper, args, { encoding: 'utf8' })
  assert.notEqual(stale.status, 0); assert.match(stale.stderr, /verify-alias-source/)
  assert.deepEqual(await inventory(join(home, '.agentmux')), before)
  await rename(join(home, '.agentmux/motes'), join(home, '.agentmux/keep-motes'))
  await symlink('keep-motes', join(home, '.agentmux/motes'))
  const aliasedBefore = await inventory(join(home, '.agentmux'))
  const aliased = spawnSync(helper, await aliasArgs(home, old, 'motes/' + entityName('guard')), { encoding: 'utf8' })
  assert.notEqual(aliased.status, 0); assert.match(aliased.stderr, /open-alias-destination-parent/)
  assert.deepEqual(await inventory(join(home, '.agentmux')), aliasedBefore)
})

test('interruption after exclusive stage preserves source and unknown stage without blind resume', async () => {
  const home = await homeFixture('stage-interruption'), old = await entity(home, 'interrupted', true)
  await mkdir(join(home, '.agentmux/motes'))
  const args = [...await aliasArgs(home, old, 'motes/' + entityName('interrupted')), '--before-commit-barrier']
  const before = await inventory(old)
  const child = spawn(helper, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  await once(child.stdio[3], 'data')
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed
  assert.deepEqual(await inventory(old), before)
  const stage = join(home, '.agentmux/motes', entityName('interrupted'))
  assert.equal((await lstat(stage)).isSymbolicLink(), true)
  assert.equal(await readlink(stage), '../motes/' + entityName('interrupted'))
  const untouched = await inventory(join(home, '.agentmux'))
  const retry = await migrateTopicDirectories({ home, execute: true, helperPath: helper })
  assert.equal(retry.success, false)
  assert.equal(retry.objects[0].issue.code, 'DIRECTORY_MIGRATION_TARGET_EXISTS')
  assert.deepEqual(await inventory(join(home, '.agentmux')), untouched)
})

test('lost helper receipt after swap resumes only the exact alias and saved original identity', async () => {
  const home = await homeFixture('committed-interruption'), old = await entity(home, 'committed', true)
  await mkdir(join(home, '.agentmux/motes'))
  const identityHandle = await open(join(old, metadataName), 'wx', 0o600)
  try { await identityHandle.writeFile(JSON.stringify({ version: 1, identityDirectoryPath: old }) + '\n'); await identityHandle.sync() }
  finally { await identityHandle.close() }
  const before = await inventory(old)
  const child = spawn(helper, [...await aliasArgs(home, old, 'motes/' + entityName('committed')), '--after-commit-barrier'], { stdio: ['ignore', 'ignore', 'pipe', 'ignore', 'ignore', 'pipe', 'pipe'] })
  await once(child.stdio[5], 'data')
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed
  const canonical = join(home, '.agentmux/motes', entityName('committed'))
  assert.deepEqual(await inventory(canonical), before)
  const resumed = await migrateTopicDirectories({ home, execute: true, helperPath: helper })
  assert.equal(resumed.success, true)
  assert.equal(resumed.objects[0].state, 'already-migrated')
  assert.deepEqual(withoutIdentity(await inventory(canonical)), withoutIdentity(before))
  assert.deepEqual(JSON.parse(await readFile(join(canonical, metadataName), 'utf8')), directoryIdentityRecord(old))
  await writeFile(join(canonical, metadataName), JSON.stringify({ version: 1, identityDirectoryPath: canonical }))
  const invalidBefore = await inventory(canonical)
  const refused = await migrateTopicDirectories({ home, execute: true, helperPath: helper })
  assert.equal(refused.success, false)
  assert.equal(refused.objects[0].issue.code, 'DIRECTORY_IDENTITY_INVALID')
  assert.deepEqual(await inventory(canonical), invalidBefore)
})

test('old no-replace action still moves an absent target and refuses an occupied target', async () => {
  const home = await homeFixture('old-action'), root = join(home, '.agentmux'), info = await stat(root, { bigint: true })
  await writeFile(join(root, 'source.txt'), 'old action\n')
  const args = [root, String(info.dev), String(info.ino), 'source.txt', 'destination.txt']
  run(helper, args)
  assert.equal(await readFile(join(root, 'destination.txt'), 'utf8'), 'old action\n')
  await writeFile(join(root, 'source.txt'), 'second original\n')
  const before = await inventory(root)
  const conflict = spawnSync(helper, args, { encoding: 'utf8' })
  assert.notEqual(conflict.status, 0)
  assert.deepEqual(await inventory(root), before)
})
