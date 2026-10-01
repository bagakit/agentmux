import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const { assertPackageIdentity, canonicalInstallPath, readPackageIdentity } = await import(
  pathToFileURL(join(repositoryRoot, 'apps/desktop/scripts/package-identity.mjs')))
const exec = promisify(execFile)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))
const within = (path, root) => { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/')) }
async function readReceipt(reference) {
  assert.ok(reference?.path && reference.sha256, 'A hashed evidence reference is required.')
  const bytes = await readFile(reference.path)
  assert.equal(digest(bytes), reference.sha256, 'Evidence receipt changed.')
  return JSON.parse(bytes)
}
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

// Public Core status owns the observation. A Native running summary alone does
// not prove semantic recovery, readiness, acknowledged input, or healthy lanes.
export function classifyPreservedSessions(before, current, observations) {
  assert.ok(before.length > 0, 'Original Session baseline is empty.')
  assert.equal(new Set(before.map(row => row.agentSessionId)).size, before.length, 'Baseline Session identity is ambiguous.')
  assert.equal(new Set(current.map(row => row.agentSessionId)).size, current.length, 'Current Session identity is ambiguous.')
  const now = new Map(current.map(row => [row.agentSessionId, row]))
  const facts = new Map(observations.map(row => [row.agentSessionId, row]))
  return before.map(original => {
    const restored = now.get(original.agentSessionId)
    assert.ok(restored, 'An original AgentSession is missing from the durable store.')
    for (const field of ['kind', 'providerId', 'executorId', 'hostId', 'workspacePath', 'createdAt']) {
      assert.ok(equal(restored[field], original[field]), `Original Session ${field} changed.`)
    }
    assert.ok(equal(restored.nativeHandle, original.nativeHandle), 'Original native resume handle changed or disappeared.')
    const changedRun = !equal(restored.run, original.run)
    if (changedRun) assert.ok(restored.retiredRuns.some(run => equal(run, original.run)), 'New Run lost its complete original Session lineage.')
    const observation = facts.get(original.agentSessionId)
    const status = observation?.status
    if (status) {
      assert.equal(status.session.agentSessionId, original.agentSessionId)
      assert.ok(equal(status.session.nativeHandle, original.nativeHandle), 'Observed Core native handle differs from the preserved Session.')
      assert.ok(equal(status.session.run, restored.run) && status.run.runId === restored.run.runId, 'Observed Core status refers to another Run.')
    }
    const missing = observation?.unavailable?.some(issue => issue.code === 'CTXMUX_run_not_found')
    return { agentSessionId: original.agentSessionId, run: restored.run, previousRun: original.run,
      nativeHandleRetained: Boolean(original.nativeHandle),
      recovery: status ? (changedRun ? 'new-run-observed' : 'observed') : (!changedRun && missing ? 'deferred-on-demand' : 'unavailable'),
      runtimeState: status?.run.state ?? 'not_observed', semanticStatus: observation?.session?.semanticStatus ?? 'not_observed',
      unavailable: observation?.unavailable ?? [], inputConfirmation: 'not_observed', orderedOutput: 'not_observed' }
  })
}

export function assertServingIdentity({ published, installed, gui, manifest, native }) {
  assertPackageIdentity(installed, published)
  assertPackageIdentity(gui.main.package, installed)
  assert.equal(gui.workbench.loading, false, 'Actual workbench is still loading.')
  assert.equal(native.protocol, manifest.product.protocol, 'Serving SDK protocol differs from the released artifact.')
  assert.equal(native.runtime.protocolGeneration, manifest.product.protocol, 'Serving Runtime protocol differs from the released artifact.')
  const local = gui.main.runtimes.find(row => row.hostId === 'local')?.identity
  assert.ok(local, 'Actual GUI has no observed local Runtime identity.')
  assert.equal(local.protocolVersion, native.runtime.protocolGeneration)
  assert.equal(local.instanceId, native.runtime.daemonInstanceId)
  assert.equal(local.buildIdentity, native.runtime.buildId)
}

export function assertColdStateIsolation(state, expectedDirectory, archive, originalRoots, archivedLock) {
  assert.equal(state.directory, expectedDirectory, 'Serving OS state lock is not in the installed Core state directory.')
  assert.equal(resolve(originalRoots.runtime), expectedDirectory, 'Cold startup changed the original stable state address.')
  for (const root of Object.values(archive.roots)) {
    assert.ok(!within(state.directory, root) && !within(root, state.directory), 'Serving state overlaps archived data.')
  }
  assert.ok(state.device !== archivedLock.device || state.inode !== archivedLock.inode, 'New Runtime is still using the archived state lock entity.')
}

async function inventoryRoot(root, name) {
  const rows = []
  async function walk(path, entry) {
    const info = await lstat(path)
    const row = { root: name, path: entry, type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file', mode: info.mode & 0o7777 }
    if (info.isSymbolicLink()) row.target = await readlink(path)
    else if (info.isDirectory()) {
      rows.push(row)
      for (const child of (await readdir(path)).sort()) await walk(join(path, child), entry === '.' ? child : `${entry}/${child}`)
      return
    } else {
      assert.ok(info.isFile(), 'Archive contains an unsupported file type.')
      row.bytes = info.size; row.sha256 = await hashFile(path)
    }
    rows.push(row)
  }
  await walk(root, '.')
  return rows
}

async function assertWriterObservation(reference, roots) {
  const observed = await readReceipt(reference)
  assert.ok(Number.isFinite(Date.parse(observed.observedAt)), 'Writer observation has no timestamp.')
  assert.ok(equal(observed.sourceRoots, roots), 'Writer observation covers different original roots.')
  for (const root of Object.values(roots)) {
    const command = observed.commands.find(row => row.executable === '/usr/sbin/lsof' && equal(row.args, ['-n', '-P', '+D', root, '-Fpcuftn']))
    assert.ok(command, 'Original root has no actual scoped OS writer observation.')
    const stdout = await readFile(command.stdout.path, 'utf8'), stderr = await readFile(command.stderr.path, 'utf8')
    assert.equal(digest(stdout), command.stdout.sha256); assert.equal(digest(stderr), command.stderr.sha256)
    assert.ok(command.exitCode === 0 || (command.exitCode === 1 && stdout === '' && stderr === ''), 'Writer observation command did not complete.')
    let pid, fd, processName
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) { pid = Number(line.slice(1)); fd = undefined; processName = undefined }
      else if (line.startsWith('c')) processName = line.slice(1)
      else if (line.startsWith('f')) fd = line.slice(1)
      else if (line.startsWith('n')) {
        assert.ok(Number.isSafeInteger(pid) && pid > 0 && processName && fd, 'OS file observation is malformed.')
        assert.ok(!within(line.slice(1), root) || (!/^\d+[wu]/.test(fd) && !['ctxmuxd', 'AgentMux'].includes(processName)), 'Original archive source still has an active writer or owner.')
      }
    }
  }
  const ps = observed.commands.find(row => row.executable === '/bin/ps' && equal(row.args, ['-axo', 'pid=,uid=,lstart=,command=']))
  assert.ok(ps && ps.exitCode === 0, 'Writer observation has no completed process identity snapshot.')
  const psBytes = await readFile(ps.stdout.path)
  assert.equal(digest(psBytes), ps.stdout.sha256)
  assert.ok(psBytes.length > 0, 'Process identity snapshot is empty.')
  return observed
}

export async function verifyArchive(archive, baseline) {
  const original = await readReceipt(archive.originalInventory)
  const names = Object.keys(archive.roots).sort()
  for (const required of ['runtime', 'client', 'userData']) assert.ok(names.includes(required), `Complete ${required} archive is absent.`)
  assert.ok(equal(names, Object.keys(original.sourceRoots).sort()), 'Archive does not cover every original root.')
  const before = await assertWriterObservation(original.writerBefore, original.sourceRoots)
  const after = await assertWriterObservation(original.writerAfter, original.sourceRoots)
  assert.ok(Date.parse(before.observedAt) <= Date.parse(original.startedAt) &&
    Date.parse(original.startedAt) <= Date.parse(original.completedAt) && Date.parse(original.completedAt) <= Date.parse(after.observedAt), 'Fresh OS observations do not fence the complete original inventory.')
  const actual = (await Promise.all(names.map(name => inventoryRoot(archive.roots[name], name)))).flat()
  const order = rows => [...rows].sort((a, b) => `${a.root}/${a.path}`.localeCompare(`${b.root}/${b.path}`))
  assert.ok(original.files.length > 0 && new Set(original.files.map(row => `${row.root}/${row.path}`)).size === original.files.length, 'Original inventory is empty or ambiguous.')
  assert.ok(equal(order(actual), order(original.files)), 'Complete archive differs from the full original inventory.')
  assert.ok(actual.some(row => row.root === 'runtime' && row.path === 'state.sqlite3' && row.type === 'file'), 'Original Runtime database is missing.')
  assert.ok(actual.some(row => row.root === 'runtime' && row.path === 'state.sqlite3-wal' && row.type === 'file'), 'Original Runtime WAL is missing.')
  assert.ok(actual.some(row => row.root === 'runtime' && row.path.startsWith('terminal-checkpoints/') && row.type === 'file'), 'Original terminal checkpoints are missing.')
  assert.ok(actual.some(row => row.root === 'userData' && row.path === 'agent-sessions.json' && row.sha256 === baseline.agentSessions.originalSha256), 'Original Session store differs from the independently checked baseline.')
  for (const file of baseline.source.installedFiles) {
    assert.ok(actual.some(row => row.root === 'client' && row.path === `Contents/Resources/app/${file.path}` && row.sha256 === file.sha256 && row.bytes === file.bytes), 'Original client bytes are not completely preserved.')
  }
  for (const file of baseline.safety.originalFileChecks) {
    const source = archive.baselineSources[file.sourceIdentity]
    assert.ok(source && names.includes(source.root), 'An independently checked original storage source has no archive binding.')
    const path = source.prefix ? `${source.prefix}/${file.path}` : file.path
    assert.ok(actual.some(row => row.root === source.root && row.path === path && row.sha256 === file.expectedSha256), 'Original local storage or historical backup differs from its checked baseline.')
  }
  return { sourceRoots: original.sourceRoots, files: actual.length, originalInventorySha256: archive.originalInventory.sha256 }
}

export function verifyOriginalWorkface(baseline, gui, projection) {
  const canonical = baseline.workbench.sources.find(source => source.authority === 'current_canonical')
  assert.ok(canonical && typeof canonical.parser.fileOriginKeyPresent === 'boolean', 'Original canonical Workbench authority is unknown.')
  if (!canonical.parser.fileOriginKeyPresent) return { status: 'preexisting-unavailable', canonicalKeyPresent: false,
    historicalBackups: baseline.workbench.sources.filter(source => source.authority === 'named_historical_backup').map(source => ({
      label: source.label, groups: source.savedRecord.groups, tabs: source.savedRecord.tabs,
      regions: source.savedRecord.regions, drafts: source.savedRecord.drafts, rawTextSha256: source.savedRecord.rawTextSha256 })) }
  assert.ok(projection, 'Original Workbench projection is missing.')
  for (const field of ['activeWorkspaceId', 'mainSurface', 'focus', 'layouts']) assert.ok(equal(gui.workbench[field], projection[field]), `Original Workbench ${field} changed.`)
  const present = new Map(gui.workbench.tabs.map(tab => [tab.id, tab]))
  assert.equal(present.size, projection.tabs.length, 'Original Tab inventory changed.')
  for (const tab of projection.tabs) {
    const now = present.get(tab.id); assert.ok(now, 'Original Tab is missing.')
    for (const field of ['workspaceId', 'topicId', 'titleRegionId', 'name', 'layout']) assert.ok(equal(now[field], tab[field]), `Original Tab ${field} changed.`)
    assert.equal(now.regions.length, tab.regions.length, 'Original Region inventory changed.')
    for (const region of tab.regions) {
      const current = now.regions.find(row => row.regionId === region.regionId)
      assert.ok(current, 'Original Region is missing.')
      for (const [field, value] of Object.entries(region)) if (!['control', 'phase', 'processState', 'navigationId', 'loading', 'error'].includes(field)) assert.ok(equal(current[field], value), `Original Region ${field} changed.`)
      if (region.control && current.control) {
        assert.equal(current.control.kind, region.control.kind)
        assert.equal(current.control.hostId, region.control.hostId)
        if (region.control.kind === 'agent') assert.equal(current.control.agentSessionId, region.control.agentSessionId)
        else assert.ok(equal(current.control.run, region.control.run), 'Original Terminal Run changed.')
      }
    }
  }
  return { status: 'original-projection-observed', canonicalKeyPresent: true, tabs: present.size }
}

export async function verifyServing(input, root = repositoryRoot) {
  assert.equal(input.sdkPath, undefined, 'An arbitrary SDK path cannot qualify an installed Runtime.')
  const { observeUiClient, observeInstalledRuntimeOwner } = await import(pathToFileURL(join(root, 'apps/desktop/scripts/package-runtime-upgrade.mjs')))
  const appPath = canonicalInstallPath(homedir())
  const core = join(appPath, 'Contents/Resources/app/node_modules/@agentmux/core')
  const vendor = join(core, 'vendor/ctxmux', `${process.platform}-${process.arch}`)
  const manifestBytes = await readFile(join(vendor, 'manifest.json')), manifest = JSON.parse(manifestBytes)
  assert.equal(digest(manifestBytes), input.candidate.manifestSha256)
  assert.equal(manifest.source.commit, input.candidate.sourceCommit)
  assert.equal(manifest.source.tree, input.candidate.sourceTree)
  for (const artifact of [...manifest.binaries, manifest.sdk.archive]) {
    assert.ok(artifact.path && !artifact.path.startsWith('/') && !artifact.path.split('/').includes('..'), 'Installed artifact path is invalid.')
    const path = join(vendor, artifact.path), info = await lstat(path)
    assert.ok(info.isFile()); assert.equal(await hashFile(path), artifact.sha256)
    assert.equal(info.size, artifact.bytes)
    assert.equal((info.mode & 0o777).toString(8).padStart(4, '0'), artifact.mode)
  }
  const tree = await exec('git', ['rev-parse', `${input.published.sourceCommit}^{tree}`], { cwd: root })
  assert.equal(tree.stdout.trim(), input.published.sourceTree)
  const parents = await exec('git', ['show', '-s', '--format=%P', input.published.sourceCommit], { cwd: root })
  assert.equal(parents.stdout.trim(), input.publication.parent, 'Published change does not have its single expected parent.')
  const baseline = await readReceipt(input.baseline.summary)
  assert.equal(baseline.schema, 'agentmux.readonly-original-durable-baseline.v1')
  for (const evidence of Object.values(baseline.evidence)) {
    assert.equal(await hashFile(join(dirname(input.baseline.summary.path), evidence.path)), evidence.sha256, 'Independently reviewed baseline evidence changed.')
  }
  const archive = await verifyArchive(input.archive, baseline)
  const installed = await readPackageIdentity(appPath), gui = await observeUiClient(appPath)
  const owner = await observeInstalledRuntimeOwner(appPath)
  const paths = await import(pathToFileURL(join(core, 'dist/runtime-paths.js')))
  const expectedState = await realpath(paths.defaultCtxmuxStateDirectory())
  const oldLock = await lstat(join(input.archive.roots.runtime, 'state.lock'), { bigint: true })
  assertColdStateIsolation({ ...owner.state, directory: await realpath(owner.state.directory) }, expectedState,
    input.archive, archive.sourceRoots, { device: oldLock.dev.toString(), inode: oldLock.ino.toString() })
  assert.equal(owner.socketPath, paths.defaultCtxmuxSocketPath())
  assert.equal(owner.manifestSha256, input.candidate.manifestSha256)
  assert.equal(owner.sourceCommit, input.candidate.sourceCommit); assert.equal(owner.sourceTree, input.candidate.sourceTree)
  const temporary = await mkdtemp(join(root, '.tmp/ctxmux-serving-sdk-'))
  try {
    await exec('/usr/bin/tar', ['-xzf', join(vendor, manifest.sdk.archive.path), '-C', temporary], { timeout: 10000, maxBuffer: 1024 * 1024 })
    const sdkPath = join(temporary, 'package/dist/index.js')
    const inspection = await exec(process.execPath, [join(root, 'apps/desktop/scripts/package-runtime-upgrade.mjs'), '--inspect',
      sdkPath, owner.socketPath, join(core, 'dist/index.js')], { timeout: 15000, maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    const native = JSON.parse(inspection.stdout)
    assertServingIdentity({ published: input.published, installed, gui, manifest, native })
    assert.ok(typeof input.archive.oldRuntimeId === 'string' && input.archive.oldRuntimeId.length > 0, 'Original Runtime identity is missing.')
    assert.notEqual(native.runtime.runtimeId, input.archive.oldRuntimeId, 'A cold Runtime is being presented as the archived Runtime.')
    const release = JSON.parse(await readFile(join(appPath, 'Contents/Resources/app/out/renderer/release.json'), 'utf8'))
    assert.ok(equal(gui.main.renderer.identity, release.identity), 'Loaded Renderer differs from the installed release.')
    assert.equal(gui.main.storage.localStorage, 'present', 'The serving workbench storage owner is unavailable.')
    const before = JSON.parse(await readFile(join(input.archive.roots.userData, 'agent-sessions.json'), 'utf8'))
    const current = JSON.parse(await readFile(join(gui.main.storage.userData, 'agent-sessions.json'), 'utf8'))
    const { connectAgentMuxRpc } = await import(pathToFileURL(join(core, 'dist/index.js')))
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(dirname(owner.socketPath), 'control.sock') } })
    const observations = []
    try {
      for (const original of before.sessions) {
        let fact
        try {
          fact = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: original.agentSessionId } })
        } catch (error) {
          observations.push({ agentSessionId: original.agentSessionId, status: null, unavailable: [{ code: error.code ?? 'OBSERVATION_UNAVAILABLE', message: error.message }] })
          continue
        }
        assert.equal(fact.session.agentSessionId, original.agentSessionId)
        observations.push({ agentSessionId: original.agentSessionId, ...fact })
      }
    } finally { await rpc.dispose() }
    const sessions = classifyPreservedSessions(before.sessions, current.sessions, observations)
    let projection
    if (input.baseline.projection) {
      const canonical = baseline.workbench.sources.find(row => row.authority === 'current_canonical')
      assert.equal(input.baseline.projection.sha256, canonical.savedRecord?.rawTextSha256, 'Original projection is not the checked canonical record.')
      const record = await readReceipt(input.baseline.projection)
      projection = { activeWorkspaceId: record.state.activeWorkspaceId, mainSurface: record.state.mainSurface,
        focus: record.state.agentFocus, layouts: record.state.restoredWorkbench.layouts,
        tabs: Object.values(record.state.restoredWorkbench.tabs).map(tab => ({ ...tab, regions: Object.values(tab.regions) })) }
    }
    return { schema: 'agentmux.ctxmux-latest-serving.v1', passed: true, readOnly: true,
      published: input.published, installed, loaded: { mainPid: gui.main.pid, renderer: gui.main.renderer },
      runtime: { ...native.runtime, owner }, archivedRuntime: { runtimeId: input.archive.oldRuntimeId,
        roots: input.archive.roots, files: archive.files, originalInventorySha256: archive.originalInventorySha256, verified: true },
      baseline: { summarySha256: input.baseline.summary.sha256 }, originalWorkface: verifyOriginalWorkface(baseline, gui, projection),
      observedTabs: gui.workbench.tabs.length, sessions, inputConfirmation: 'not_observed', orderedOutput: 'not_observed',
      output: native.running.some(run => run.outputBytes > 0) ? 'metadata-only' : 'not_observed',
      limitations: ['Delivery does not claim every deferred Agent has executed native resume.',
        'A new Run observation does not prove semantic health or an input/output round trip.',
        'Archived Runtime history remains archived; a new cold Runtime does not restore old ordered bytes.',
        'Historical Workbench backups are preserved and are not promoted to the current canonical workface.'] }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2] ?? join(repositoryRoot, '.tmp/ctxmux-latest-serving-input.json')
  const outputPath = process.argv[3] ?? join(repositoryRoot, '.tmp/ctxmux-latest-serving-result.json')
  let result
  try { result = await verifyServing(JSON.parse(await readFile(inputPath, 'utf8'))) }
  catch (error) { result = { schema: 'agentmux.ctxmux-latest-serving.v1', passed: false, readOnly: true, error: error.stack ?? error.message } }
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify({ passed: result.passed, receipt: outputPath, sessions: result.sessions?.length, error: result.error }) + '\n')
  if (!result.passed) process.exitCode = 1
}
