import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repo = resolve(mobile, '../..')
const evidence = join(repo, '.tmp/agentmux-private-mobile-client/device-workface')
await mkdir(evidence, { recursive: true })
const names = ['src/recovery/device-workface.ts', 'src/recovery/MobileRecoveryPanel.tsx',
  'src/recovery/recovery.css', 'src/conversation/local-drafts.ts', 'src/MobileApp.tsx',
  'test/device-workface.test.tsx']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const source = Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await readFile(join(mobile, name)))])))
function run(config = 'vitest.config.ts') {
  const result = spawnSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'),
    'run', '--maxWorkers=1', '--config', config, 'test/device-workface.test.tsx'],
  { cwd: mobile, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const green = run()
await writeFile(join(evidence, 'behavior-green.log'), green.output)
assert.equal(green.code, 0, green.output)
assert.match(green.output, /14 passed/u, 'The actual fourteen behavior cases must collect and execute')
const mutants = [
  { id: 'conversation-erases-navigation', file: 'src/recovery/device-workface.ts',
    from: 'this.refresh(); this.update({ ...this.value, conversation: parseDraftRecord(conversation) })',
    to: 'this.refresh(); this.update({ ...emptyDeviceWorkface(), conversation: parseDraftRecord(conversation) })' },
  { id: 'failed-import-adopts-memory', file: 'src/recovery/device-workface.ts',
    from: 'this.storage().setItem(DEVICE_WORKFACE_KEY, bytes)\n    this.value = parsed; this.lastRaw = bytes; this.issue = null; this.temporary = false',
    to: 'this.value = parsed\n    this.storage().setItem(DEVICE_WORKFACE_KEY, bytes)\n    this.lastRaw = bytes; this.issue = null; this.temporary = false' },
  { id: 'host-identity-guard-removed', file: 'src/recovery/device-workface.ts',
    from: "    if (this.value.host && (this.value.host.origin !== host.origin || this.value.host.hostId !== host.hostId)) {\n      throw new DeviceHostMismatchError('当前 Mac 与已保全工作面的原 Host 身份不同。原会话、草稿和未确认输入仍保留；请接回原 Mac，或明确建立另一份设备工作面。')\n    }",
    to: '' },
  { id: 'workface-validation-bypassed', file: 'src/recovery/device-workface.ts',
    from: "  const v = record(value, ['version', 'selectedSessionId', 'hostUrl', 'panel', 'host', 'conversation'])\n  if (v.version !== 1 || !(v.selectedSessionId === null || id(v.selectedSessionId))\n    || !(v.hostUrl === '' || origin(v.hostUrl))\n    || !(v.panel === 'conversation' || v.panel === 'sessions' || v.panel === 'terminal')) throw invalid()\n  if (v.host !== null) {\n    const host = record(v.host, ['origin', 'hostId'])\n    if (!origin(host.origin) || !id(host.hostId)) throw invalid()\n  }\n  parseDraftRecord(v.conversation)\n  return structuredClone(value) as DeviceWorkface",
    to: '  return structuredClone(value) as DeviceWorkface' },
  { id: 'cold-original-input-loses-unknown-guard', file: 'src/conversation/local-drafts.ts',
    from: "const intent = item as PromptAttempt, status = intent.phase === 'sending' ? 'unknown' : intent.phase\n        attempts.set(key, { operationId: intent.operationId, runId: intent.runId, draft: intent.draft, phase: status, message: restoredMessage(status) })",
    to: "const intent = item as PromptAttempt, status = intent.phase === 'sending' ? 'rejected' : intent.phase\n        attempts.set(key, { operationId: intent.operationId, runId: intent.runId, draft: intent.draft, phase: status, message: restoredMessage(status) })" },
  { id: 'temporary-workface-overwritten-on-read-recovery', file: 'src/recovery/device-workface.ts',
    from: "      if (this.temporary) {\n        this.issue = '设备存储已可读取或原记录已变化；当前临时工作面仍保留，尚未覆盖原字节。请先导出需要保留的内容，再明确采用当前工作面或导入备份。'\n        return\n      }", to: '' },
  { id: 'unavailable-getter-owner-forgotten', file: 'src/recovery/device-workface.ts',
    from: '    const owner = new DeviceWorkfaceStore(storage)\n    getterStores.set(storage, owner)\n    return owner',
    to: '    return new DeviceWorkfaceStore(storage)' },
  { id: 'unreadable-app-navigation-not-staged', file: 'src/MobileApp.tsx',
    from: 'if (workface === initial.current?.workface) return',
    to: 'if (!canPersist || workface === initial.current?.workface) return' },
  { id: 'memory-reader-discards-valid-unknown-guard', file: 'src/conversation/local-drafts.ts',
    from: "    if (snapshot.issue) {\n      state.canSave = false\n      state.notice = '本机草稿存储暂时无法读取，原记录尚未覆盖。当前草稿和未确认输入仍保留，可继续编辑和复制；请恢复设备存储后明确保存当前工作面。'\n    }",
    to: '    if (snapshot.issue) throw new Error(snapshot.issue)' },
  { id: 'actual-app-recovery-caller-removed', file: 'src/MobileApp.tsx',
    from: '<MobileRecoveryPanel {...(native ? { exportFile: exportNativeWorkfaceFile } : {})} />', to: '' }
]
const results = []
if (process.argv.includes('--mutation')) for (const mutant of mutants) {
  const file = join(mobile, mutant.file), bytes = await readFile(file, 'utf8')
  assert.equal(bytes.split(mutant.from).length, 2, `${mutant.id}: exactly one complete implementation block is required`)
  const config = join(evidence, `${mutant.id}.config.mjs`)
  await writeFile(config, `import base from ${JSON.stringify(join(mobile, 'vitest.config.ts'))};
export default { ...base, plugins: [{name:'workface-source-block-mutant',enforce:'pre',
 transform(code,id) { if(id.split('?')[0]!==${JSON.stringify(file)})return;
 const from=${JSON.stringify(mutant.from)};
 if(code.split(from).length!==2)throw new Error('Source block absent');
 console.info('AMX_SOURCE_MUTATION_APPLIED:${mutant.id}');return code.replace(from,${JSON.stringify(mutant.to)});
 }},...base.plugins]};\n`)
  try {
    const red = run(config)
    await writeFile(join(evidence, `${mutant.id}-red.log`), red.output)
    assert.match(red.output, new RegExp(`AMX_SOURCE_MUTATION_APPLIED:${mutant.id}`, 'u'))
    assert.notEqual(red.code, 0, `${mutant.id}: mutated product behavior must fail`)
    assert.match(red.output, /AssertionError/u, 'Dependency/collection failure is not a detected behavior mutation')
    results.push({ id: mutant.id, code: red.code, completeSourceBlockApplied: true, assertionFailed: true })
  } finally { await rm(config, { force: true }) }
}
const restored = run()
await writeFile(join(evidence, 'restored-green.log'), restored.output)
assert.equal(restored.code, 0, restored.output); assert.match(restored.output, /14 passed/u)
for (const [name, before] of Object.entries(source)) assert.equal(hash(await readFile(join(mobile, name))), before, `Source changed: ${name}`)
const app = await readFile(join(mobile, 'src/MobileApp.tsx'), 'utf8')
const drafts = await readFile(join(mobile, 'src/conversation/local-drafts.ts'), 'utf8')
const recovery = await readFile(join(mobile, 'src/recovery/MobileRecoveryPanel.tsx'), 'utf8')
const callers = { navigation: app.includes('getDeviceWorkface().updateNavigation(workface)'),
  conversation: drafts.includes('owner.updateConversation(record)'),
  exportBackup: recovery.includes('getDeviceWorkface().exportBackup()'),
  importBackup: recovery.includes('getDeviceWorkface().replaceBackup(candidate)'),
  actualDialog: app.includes('<MobileRecoveryPanel {...(native ? { exportFile: exportNativeWorkfaceFile } : {})} />') }
assert.equal(Object.keys(callers).length, 5)
for (const [name, found] of Object.entries(callers)) assert.equal(found, true, `Definition-external product caller absent: ${name}`)
await writeFile(join(evidence, 'proof.json'), JSON.stringify({ schema: 'agentmux.mobile-workface-proof.v1',
  verifiedAt: new Date().toISOString(), source, behaviors: 14, mutations: results,
  callers, restored: { code: restored.code, behaviors: 14 },
  limitations: ['Source-bound browser behavior; native compiler, real OS file picker, device restart/reinstall and original Host recovery are not claimed.'] }, null, 2)+'\n')
console.log(`Device workface: 14 behavior cases GREEN, ${results.length} complete Source block mutants detected, 5 definition-external product callers.`)
