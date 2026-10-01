import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), root = resolve(desktop, '../..')
const privateAccessMode = process.argv.includes('--private-access-status')
const evidence = join(root, '.tmp/agentmux-private-mobile-client', privateAccessMode ? 'device-settings-private-access' : 'desktop-device-management')
await mkdir(evidence, { recursive: true })
if (!process.argv.includes('--preparation')) throw new Error('Actual public device methods, Desktop preload/register/HostSettingsPane and real Mac dialog proof remain required. Leaf evidence cannot sign T002.')
const paths = ['src/main/device-management-ipc.ts', 'src/renderer/src/components/settings/DeviceManagementSettings.tsx',
  'test/device-management-ipc.test.ts', 'test/device-management-settings.test.tsx', 'scripts/verify-device-management-settings.mjs']
const sha = value => createHash('sha256').update(value).digest('hex')
const originals = await Promise.all(paths.map(path => readFile(join(desktop, path), 'utf8')))
const sandbox = join(evidence, 'mutation-sandbox'), temp = join(evidence, 'tmp')
await mkdir(sandbox, { recursive: true }); await mkdir(temp, { recursive: true })
const ipc = join(sandbox, 'device-management-ipc.ts'), ui = join(sandbox, 'DeviceManagementSettings.tsx'), config = join(sandbox, 'vitest.config.mts')
const react = await realpath(join(desktop, 'node_modules/react')), reactDom = await realpath(join(desktop, 'node_modules/react-dom'))
const lucide = await realpath(join(desktop, 'node_modules/lucide-react/dist/esm/lucide-react.js'))
const core = await realpath(join(desktop, 'node_modules/@agentmux/core/dist/index.js'))
const errorPresentation = join(root, 'packages/client-ui/src/lib/error-presentation.ts')
const rendererApi = join(desktop, 'src/renderer/src/lib/api.ts')
await writeFile(config, `export default { define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, esbuild: { jsx: 'automatic' }, resolve: { conditions: ['browser', 'module', 'import'], alias: [{ find: 'react', replacement: ${JSON.stringify(react)} }, { find: 'react-dom', replacement: ${JSON.stringify(reactDom)} }, { find: /^lucide-react$/, replacement: ${JSON.stringify(lucide)} }, { find: /^@agentmux\\/core$/, replacement: ${JSON.stringify(core)} }, { find: /^@agentmux\\/client-ui\\/error-presentation$/, replacement: ${JSON.stringify(errorPresentation)} }, { find: /^(?:\\.\\.\\/\\.\\.\\/lib\\/api|.*\\/src\\/renderer\\/src\\/lib\\/api)$/, replacement: ${JSON.stringify(rendererApi)} }, { find: /^(?:\\.\\/|.*\\/)(?:DeviceManagementSettings)$/, replacement: ${JSON.stringify(ui)} }, { find: /^(?:\\.\\/|.*\\/)(?:device-management-ipc)$/, replacement: ${JSON.stringify(ipc)} }] }, test: { include: ['apps/desktop/test/device-management-settings.test.tsx', 'apps/desktop/test/device-management-ipc.test.ts'], maxWorkers: 1 } }\n`)
const mutations = [
  ['untrusted-device-admin', 0, 'options.assertTrusted(channel, event)', 'void event', 'untrusted renderer'],
  ['wrong-unix-owner', 0, 'options.socketPath ?? defaultAgentMuxControlSocketPath()', ("'" + _hygiene_fixturePath("foreign/runtime/agentmux.sock") + "'"), 'only five fixed public calls'],
  ['wrong-public-method', 0, 'return await call(method, params as AgentMuxRpcParams<M>)', "return await call('device.invite', {} as AgentMuxRpcParams<'device.invite'>)", 'passes strict validation'],
  ['hidden-read', 1, 'if (active) void read(expected)', 'void read(expected)', 'reads only while active'],
  ['discard-original-list', 1, 'if (alive.current && expected === epoch.current) setReadIssue(`设备列表', 'if (alive.current && expected === epoch.current) { setList(null); }\n      if (alive.current && expected === epoch.current) setReadIssue(`设备列表', 'original device list'],
  ['wrong-confirmation-code', 1, 'confirmationCode: request.confirmationCode', "confirmationCode: '000000'", 'exact original request/code'],
  ['retain-invitation-hidden', 1, 'setInvitation(null)\n    if (active)', 'if (active)', 'short invitation only'],
  ['lost-reply-not-blocked', 1, '        setNeedsRead(true)', '        setNeedsRead(false)', 'lost mutation reply'],
  ['lost-reply-auto-retry', 1, '        setNeedsRead(true)', '        void action().catch(() => {})\n        setNeedsRead(true)', 'lost mutation reply']
]
const renderStart = originals[1].indexOf('  return <section className="settings-group">')
const publicRevocationBlock = originals[1].slice(renderStart)
if (renderStart < 0 || publicRevocationBlock.split('device.revokedAt === undefined').length !== 5) {
  throw new Error('The actual four public device revocation reads must be present.')
}
mutations.push(['optional-revocation-projection', 1, publicRevocationBlock,
  publicRevocationBlock.replaceAll('device.revokedAt === undefined', 'device.revokedAt === null'), 'reads real Authority public devices'])
const mutationStart = originals[1].indexOf('  async function mutate(')
const mutationEnd = originals[1].indexOf('  async function invite(', mutationStart)
const mutationBlock = originals[1].slice(mutationStart, mutationEnd)
if (mutationStart < 0 || mutationEnd < 0 || mutationBlock.split('++epoch.current').length !== 5) {
  throw new Error('The actual mutation admission fence must be present.')
}
mutations.push(['mutation-admission-read-fence', 1, mutationBlock,
  mutationBlock.replaceAll('++epoch.current', 'epoch.current'), 'keeps an unconfirmed mutation blocked'])
mutations.push(['hidden-pending-reply-lost', 1, mutationBlock,
  mutationBlock.replace('    ++epoch.current', '    const expected = ++epoch.current')
    .replace('if (alive.current) {', 'if (alive.current && expected === epoch.current) {'), 'keeps an unknown reply fenced across hiding'])
if (privateAccessMode) {
  const copyStart = originals[1].indexOf('function quotePosix(')
  const copyEnd = originals[1].indexOf('function PrivateAccessDetails(', copyStart)
  const quoteBlock = originals[1].slice(copyStart, copyEnd)
  if (copyStart < 0 || copyEnd < 0 || !quoteBlock.includes('replaceAll')) throw new Error('Actual POSIX quote block is required.')
  mutations.push(
    ['private-access-mounted-consumer', 1, '{list && <PrivateAccessDetails access={list.privateAccess} unconfirmed={accessReadUnconfirmed} onCopy={copyAccess} />}', 'null', 'private access presents actual origin'],
    ['private-access-unconfirmed-read', 1, 'setAccessReadUnconfirmed(true)', 'setAccessReadUnconfirmed(false)', 'private access retains last known origin'],
    ['private-access-literal-argv', 1, quoteBlock, `function quotePosix(value: string): string { return "'" + value + "'" }\n\n`, 'private access copies a strictly quoted template'],
    ['private-access-origin-copy', 1, "onCopy(access.origin, 'HTTPS 地址')", "onCopy('https://127.0.0.1:443', 'HTTPS 地址')", 'private access presents actual origin'],
    ['private-access-pre-mutation-read-fence', 1, mutationBlock, mutationBlock.replaceAll('++epoch.current', 'epoch.current'), 'private access keeps mutation unknown fenced']
  )
}
const selectedAt = process.argv.indexOf('--mutation-only')
const selected = selectedAt === -1 ? null : process.argv[selectedAt + 1]
if (selectedAt !== -1 && (!selected || !mutations.some(row => row[0] === selected))) throw new Error('An actual named Source mutation is required.')
function run(name, pattern) {
  const output = join(evidence, `${name}.json`)
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    '--reporter=json', '--outputFile', output, ...(pattern ? ['-t', pattern] : [])],
  { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: temp } })
  return { exit: result.status, output, log: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}
const expectedGreen = privateAccessMode ? 5 : 17
const baselinePattern = privateAccessMode ? 'Mac private access facts' : undefined
async function inspect(name, result, red = false) {
  await writeFile(join(evidence, `${name}.log`), result.log)
  const value = JSON.parse(await readFile(result.output, 'utf8'))
  const failed = value.testResults.flatMap(row => row.assertionResults.filter(test => test.status === 'failed'))
  if (red ? result.exit === 0 || failed.length !== 1 || !failed[0].failureMessages.some(message => message.includes('AssertionError'))
    : result.exit !== 0 || value.numPassedTests !== expectedGreen || failed.length) throw new Error(`Actual nonempty ${red ? 'AssertionRED' : `${expectedGreen} GREEN`} absent: ${name}`)
  return { name, exit: result.exit, passed: value.numPassedTests, assertionFailures: failed.length }
}
try {
  await writeFile(ipc, originals[0]); await writeFile(ui, originals[1])
  const baseline = await inspect('baseline', run('baseline', baselinePattern)), results = []
  if (process.argv.includes('--mutation') || selected !== null) for (const [name, index, target, replacement, pattern] of mutations.filter(row => (selected === null || row[0] === selected) && (!privateAccessMode || row[0].startsWith('private-access-')))) {
    if (originals[index].split(target).length !== 2) throw new Error(`Missing or ambiguous original Source mutation: ${name}`)
    await writeFile(index === 0 ? ipc : ui, originals[index].replace(target, replacement))
    results.push(await inspect(name, run(name, pattern), true))
    await writeFile(index === 0 ? ipc : ui, originals[index])
  }
  const restored = await inspect('restored', run('restored', baselinePattern))
  for (let index = 0; index < paths.length; index++) if (sha(await readFile(join(desktop, paths[index]))) !== sha(originals[index])) throw new Error(`Owned Source changed: ${paths[index]}`)
  const consumers = ['src/main/ipc.ts', 'src/preload/index.ts', 'src/renderer/src/components/settings/HostSettingsPane.tsx']
  const callerSources = await Promise.all(consumers.map(path => readFile(join(desktop, path), 'utf8')))
  const actualCallersReady = callerSources[0].includes('registerDeviceManagementIpc(') && callerSources[1].includes('deviceManagement:')
    && callerSources[2].includes('<DeviceManagementSettings')
  if (privateAccessMode && !actualCallersReady) throw new Error('Original registered/preload/HostSettingsPane callers must be nonempty.')
  const proof = { schema: 'agentmux.desktop-device-management-preparation.v1', at: new Date().toISOString(),
    ownedSource: Object.fromEntries(paths.map((path, index) => ['apps/desktop/' + path, sha(originals[index])]).filter(([path]) => !privateAccessMode || !path.includes('device-management-ipc'))), baseline,
    sourceAssertionMutations: results, restored,
    publicCoreEntry: { path: core, sha256: sha(await readFile(core)) },
    actualRootCallerSources: consumers.map((path, index) => ({ path: 'apps/desktop/' + path, sha256: sha(callerSources[index]) })),
    actualCallersReady, publicDeviceMethodsJoined: false, desktopTypedBuildVerified: false,
    actualMacDialogVerified: false, independentPngReview: false, fullT002Passed: false, taskDone: false,
    scope: privateAccessMode ? '5 scoped actual mounted private-access cases; real POSIX shell receives harmless fixture argv, not the certificate helper. Public ls collaborator is controlled; type/Host/OS/phone/visual join remain unproven.' : 'Real mounted settings + registered leaf; only public call collaborator and IPC registration are controlled, not actual Mac confirmation' }
  const proofName = selected === 'optional-revocation-projection' ? 'preparation-optional-revocation.json'
    : selected ? `preparation-${selected}.json` : 'preparation.json'
  await writeFile(join(evidence, proofName), JSON.stringify(proof, null, 2) + '\n')
  process.stdout.write(`Desktop device leaves: ${expectedGreen} actual ${privateAccessMode ? 'private-access mounted' : 'mounted/IPC'} cases GREEN, ${results.length} Source AssertionRED, ${expectedGreen} restored. Real public/root callers/native/visual gates remain distinct.\n`)
} finally { await rm(sandbox, { recursive: true, force: true }); await rm(temp, { recursive: true, force: true }) }
