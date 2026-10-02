import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repo = resolve(mobile, '../..')
const evidence = resolve(repo, '.tmp/agentmux-private-mobile-client/mobile-shell')
await mkdir(evidence, { recursive: true })
const names = ['src/platform/native/device.ts', 'src/MobileApp.tsx', 'src/main.tsx', 'src/mobile.css',
  'vite.config.ts', 'vitest.config.ts', 'capacitor.config.ts', 'package.json',
  'ios/App/App/Info.plist', 'android/app/src/main/AndroidManifest.xml']
const hash = value => createHash('sha256').update(value).digest('hex')
const source = Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await readFile(join(mobile, name)))])))
function run(args, expectSuccess = true) {
  // pnpm 11 exec may auto-install changed workspace manifests. A verifier must never write the lockfile.
  assert.deepEqual(args.slice(0, 2), ['exec', 'vitest'])
  const result = spawnSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), ...args.slice(2)],
    { cwd: mobile, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error) throw result.error
  if (expectSuccess && result.status !== 0) throw new Error(`Actual Vitest ${args.slice(2).join(' ')} failed (${result.status})\n${output}`)
  return { code: result.status, output }
}
if (process.argv.includes('--restored-only')) {
  const receipt = JSON.parse(await readFile(join(evidence, 'shell-preparation.json'), 'utf8'))
  assert.equal(receipt.mutations.length, 6, 'Retain all six original candidate results')
  const restored = run(['exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'test/native-device.test.ts', 'test/shell-navigation.test.tsx'])
  assert.match(restored.output, /12 passed/u)
  await writeFile(join(evidence, 'shell-restored-green.log'), restored.output)
  receipt.restoredGreen = { testedAt: new Date().toISOString(), files: 2, tests: 12, exitCode: restored.code, source,
    changedSinceMutations: names.filter(name => receipt.source[name] !== source[name]) }
  await writeFile(join(evidence, 'shell-preparation.json'), JSON.stringify(receipt, null, 2))
  console.log('Actual original configuration restored: 12 GREEN; original private mutation results retained.')
  process.exit(0)
}
const green = run(['exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'test/native-device.test.ts', 'test/shell-navigation.test.tsx'])
assert.match(green.output, /12 passed/u, 'The nonempty actual OS/shell suites must run')
await writeFile(join(evidence, 'shell-behavior-green.log'), green.output)
const mutations = [
  { id: 'clipboard-no-os-receipt', file: 'src/platform/native/device.ts', test: 'test/native-device.test.ts',
    from: 'try { await ports.clipboard.write({ string: text }); return true }\n      catch (error) { reportError(error); return false }',
    to: 'return true' },
  { id: 'late-listener-leak', file: 'src/platform/native/device.ts', test: 'test/native-device.test.ts',
    from: 'if (disposed) await handle.remove(); else handles.push(handle)', to: 'if (!disposed) handles.push(handle)' },
  { id: 'native-file-facts-leak', file: 'src/platform/native/device.ts', test: 'test/native-device.test.ts',
    from: 'return { id: crypto.randomUUID(), name: file.name, mimeType: file.mimeType, size: file.size }', to: 'return file as unknown as LocalAttachment' },
  { id: 'viewport-owner-omitted', file: 'src/platform/native/device.ts', test: 'test/native-device.test.ts',
    from: "root.style.setProperty('--mobile-viewport-height', `${viewport?.height ?? window.innerHeight}px`)\n    root.style.setProperty('--mobile-viewport-top', `${viewport?.offsetTop ?? 0}px`)", to: '' },
  { id: 'navigation-resets-composer', file: 'src/MobileApp.tsx', test: 'test/shell-navigation.test.tsx',
    from: '<MobileConversationSurface client={client}', to: '<MobileConversationSurface key={workface.panel} client={client}' },
  { id: 'navigation-overwrites-unreadable-workface', file: 'src/MobileApp.tsx', test: 'test/shell-navigation.test.tsx',
    from: 'if (!canPersist || workface === initial.current?.workface) return', to: 'if (workface === initial.current?.workface) return' },
  { id: 'malformed-version-one-admitted', file: 'src/MobileApp.tsx', test: 'test/shell-navigation.test.tsx',
    from: "if (!value || Array.isArray(value) || value.version !== 1\n      || !(value.selectedSessionId === null || typeof value.selectedSessionId === 'string' && value.selectedSessionId.length > 0)\n      || typeof value.hostUrl !== 'string' || !(value.panel === 'conversation' || value.panel === 'sessions' || value.panel === 'terminal')) {",
    to: 'if (!value || value.version !== 1) {' },
  { id: 'storage-failure-claims-saved', file: 'src/MobileApp.tsx', test: 'test/shell-navigation.test.tsx',
    from: "setNotice('这台设备暂时无法保存导航位置。地址与导航仅临时采用；当前阅读和 Mac 上的原会话仍保留，原存储记录尚未覆盖。')",
    to: "setNotice('Mac 地址已保存在这台设备。连接与设备授权尚未确认，请在 Mac 上完成授权。')" },
  { id: 'unconfirmed-hero-claims-running', file: 'src/MobileApp.tsx', test: 'test/shell-navigation.test.tsx',
    from: 'Agent 与会话由 Mac 管理。</p>', to: '草稿在手边，Agent 仍在原处工作。</p>' }
]
const results = []
const reviewOnly = process.argv.includes('--review-fixes-only')
for (const mutation of reviewOnly ? mutations.slice(6) : mutations) {
  const file = join(mobile, mutation.file), text = await readFile(file, 'utf8')
  assert.equal(text.split(mutation.from).length, 2, `${mutation.id} must identify exactly one real implementation block`)
  const configPath = join(evidence, `${mutation.id}.config.mjs`)
  const config = `import base from ${JSON.stringify(join(mobile, 'vitest.config.ts'))};
export default { ...base, plugins: [{ name: 'actual-mobile-source-mutant', enforce: 'pre',
  transform(code, id) { if (id.split('?')[0] !== ${JSON.stringify(file)}) return;
    const from = ${JSON.stringify(mutation.from)}, to = ${JSON.stringify(mutation.to)};
    if (code.split(from).length !== 2) throw new Error('Source mutant block absent');
    console.info('AMX_SOURCE_MUTATION_APPLIED:${mutation.id}'); return code.replace(from, to);
  } }, ...base.plugins] };
`
  await writeFile(configPath, config)
  try {
    const red = run(['exec', 'vitest', 'run', '--config', configPath, mutation.test], false)
    assert.match(red.output, new RegExp(`AMX_SOURCE_MUTATION_APPLIED:${mutation.id}`, 'u'), 'Candidate must execute the changed Source')
    assert.notEqual(red.code, 0, `${mutation.id} must fail its actual behavior suite`)
    assert.match(red.output, /AssertionError/u, 'A dependency/collection error cannot count as mutation detection')
    await writeFile(join(evidence, `${mutation.id}-red.log`), red.output)
    results.push({ id: mutation.id, exitCode: red.code, sourceApplied: true, behaviorAssertionFailed: true })
  } finally { await rm(configPath) }
}
for (const [name, before] of Object.entries(source)) assert.equal(hash(await readFile(join(mobile, name))), before, `Actual Source changed during private mutation: ${name}`)
const restored = run(['exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'test/native-device.test.ts', 'test/shell-navigation.test.tsx'])
assert.match(restored.output, /12 passed/u)
await writeFile(join(evidence, 'shell-restored-green.log'), restored.output)
for (const [name, before] of Object.entries(source)) assert.equal(hash(await readFile(join(mobile, name))), before, `Actual Source changed during restored verification: ${name}`)
const entry = await readFile(join(mobile, 'src/main.tsx'), 'utf8'), app = await readFile(join(mobile, 'src/MobileApp.tsx'), 'utf8')
const callers = {
  createNativePlatform: entry.includes('createNativePlatform(browser)'),
  bindNativeDevice: app.includes('const binding = bindNativeDevice('),
  bindMobileViewport: app.includes('const release = bindMobileViewport('),
  pickLocalAttachment: app.includes('await pickLocalAttachment()'),
  MobileConversationSurface: app.includes('<MobileConversationSurface client={client}'),
  MobileApp: entry.includes('<MobileApp client={null}')
}
assert.equal(Object.values(callers).length, 6)
for (const [name, present] of Object.entries(callers)) assert.equal(present, true, `Missing real product caller: ${name}`)
const receiptPath = join(evidence, 'shell-preparation.json')
const receipt = reviewOnly ? JSON.parse(await readFile(receiptPath, 'utf8')) : { schema: 'agentmux.mobile-shell-preparation.v1',
  preparedAt: new Date().toISOString(), source, suites: { files: 2, tests: 12, exitCode: green.code }, mutations: results, callers,
  nativeProjects: ['ios/App/App.xcodeproj/project.pbxproj', 'android/app/build.gradle'],
  limitations: ['This receipt proves Source/OS-port behavior in private fixtures only.',
    'Native compiler, signed installation, authenticated iPhone/Android and independent visual review are not claimed.'] }
receipt.callers = callers
if (reviewOnly) receipt.reviewFixes = { verifiedAt: new Date().toISOString(), source,
  suites: { files: 2, tests: 12, exitCode: green.code }, mutations: results }
receipt.restoredGreen = { files: 2, tests: 12, exitCode: restored.code, source,
  changedSinceMutations: names.filter(name => receipt.source[name] !== source[name]) }
await writeFile(receiptPath, JSON.stringify(receipt, null, 2))
console.log(`Mobile shell preparation: 12 behavior tests restored GREEN, ${results.length} actual Source block mutants detected, 6 product callers. Full device gate remains separate.`)
