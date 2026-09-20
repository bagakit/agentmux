import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// Native-only slice of T-013. Production listeners, client state and user Runs
// are never selected. Active health projection / installed recovery remain a
// separate Root-held acceptance boundary; this is not the complete Task gate.
const exec = promisify(execFile)
const base = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const native = resolve(process.env.CTXMUX_NATIVE_OUTPUT_SOURCE ?? join(base, '.worktrees/ctxmux-native-output-owner'))
const out = join(base, '.tmp/native-output-owner-qualification')
await mkdir(out, { recursive: true })
const privateRoot = await mkdtemp(join(out, 'copy-'))
const source = join(privateRoot, 'source')
await mkdir(source)
const files = ['Cargo.toml', 'Cargo.lock', 'crates/ctxmux-daemon/src/lib.rs',
  'crates/ctxmux-daemon/src/native_runtime.rs', 'crates/ctxmux-daemon/src/terminal_checkpoint.rs',
  'crates/ctxmux-daemon/tests/native_output_owner_isolation.rs', 'docs/architecture.md', 'docs/protocol.md',
  'third_party/vt100/src/grid.rs', 'third_party/vt100/src/row.rs', 'third_party/vt100/src/screen.rs',
  'crates/ctxmux-daemon/tests/native_terminal_checkpoint_codec.rs']
const sha = value => createHash('sha256').update(value).digest('hex')
const capture = async () => Object.fromEntries(await Promise.all(files.map(async name => [name, sha(await readFile(join(native, name)))])))
const before = await capture()
const runnerBefore = sha(await readFile(fileURLToPath(import.meta.url)))
for (const name of ['Cargo.toml', 'Cargo.lock', 'crates', 'third_party', 'fixtures', 'reliability-gc-contract.json']) await cp(join(native, name), join(source, name), { recursive: true })
const libPath = join(source, 'crates/ctxmux-daemon/src/lib.rs')
const terminalPath = join(source, 'crates/ctxmux-daemon/src/terminal_checkpoint.rs')
const ownerPath = join(source, 'crates/ctxmux-daemon/src/native_runtime.rs')
const originals = new Map(await Promise.all([libPath, terminalPath, ownerPath].map(async path => [path, await readFile(path, 'utf8')])))
const replace = (value, anchor, replacement) => {
  assert.equal(value.split(anchor).length, 2, `source anchor must occur once: ${anchor}`)
  return value.replace(anchor, replacement)
}
const faultSource = mode => {
  let value = originals.get(terminalPath)
  if (mode === 'process') value = replace(value, 'self.parser.process(data);',
    'self.parser.process(data); if self.size().cols == 13 && data.contains(&b\'!\') { panic!("private process derivation fault"); }')
  if (mode === 'resize') value = replace(value, 'self.parser.set_size(size.rows, size.cols);',
    'self.parser.set_size(size.rows, size.cols); if size.cols == 13 { panic!("private resize derivation fault"); }')
  if (mode === 'export') value = replace(value, 'self.cut(id, latest);',
    'if self.size().cols == 13 { panic!("private export derivation fault"); } self.cut(id, latest);')
  if (mode === 'retention') value = replace(value,
    'pub(crate) fn retention_cut(&mut self, id: RunId, first: u64, latest: u64) -> bool {',
    'pub(crate) fn retention_cut(&mut self, id: RunId, first: u64, latest: u64) -> bool { if self.size().cols == 13 { panic!("private retention derivation fault"); }')
  return value
}
const results = []
const environment = { ...process.env, CARGO_TARGET_DIR: join(privateRoot, 'target') }
// The Rust fixture explicitly owns both socket and state roots. No AgentMux
// default consumer runs, and no Runtime override is used to infer durable state.
for (const key of ['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_AGENT_SESSION_STORE',
  'CTXMUX_OUTPUT_PROOF_DAEMON', 'CTXMUX_OUTPUT_PROOF_FAULT']) delete environment[key]
const testName = 'two_runs_two_clients_keep_ordered_output_input_and_ctrl_c_after_one_derivation_failure'
const reset = async () => { for (const [path, value] of originals) await writeFile(path, value) }
async function run(name, mode = 'none', options = {}) {
  const args = ['test', '--offline', '-p', 'ctxmux-daemon']
  if (options.unit) args.push('--lib', options.unit === 'retention' ?
    'retention_failure_does_not_restore_a_previously_dirty_checkpoint' : 'finished_owner_is_not_reported_running_even_while_command_receiver_exists')
  else args.push('--test', 'native_output_owner_isolation', mode === 'owner_stopped' ? 'stopped_owner_public_start_is_rejected_before_child_launch' : testName)
  args.push('--', '--nocapture')
  if (!options.unit) args.push('--exact')
  if (mode === 'owner_stopped' || options.unit === 'retention') args.push('--ignored')
  let stdout = '', stderr = '', code = 0
  try { ({ stdout, stderr } = await exec('cargo', args, { cwd: source, env: { ...environment, CTXMUX_OUTPUT_PROOF_FAULT: mode }, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })) }
  catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; code = error.code; assert.equal(typeof code, 'number', `tool/timeout is not a source RED: ${error}`) }
  const log = stdout + stderr
  await writeFile(join(out, name + '.log'), log)
  const cleanup = stdout.split('\n').filter(line => line.startsWith('PRIVATE_OUTPUT_OWNER_CLEANUP ')).map(line => JSON.parse(line.slice('PRIVATE_OUTPUT_OWNER_CLEANUP '.length)))
  const records = stdout.split('\n').filter(line => /^PRIVATE_OUTPUT_OWNER_(RECEIPT|START_RECEIPT) /.test(line)).map(line => JSON.parse(line.slice(line.indexOf(' ') + 1)))
  if (!options.unit) {
    assert.equal(cleanup.length, 1, 'fixture must finish exact private cleanup even on a source RED')
    assert.deepEqual(cleanup[0].remaining, []); assert.deepEqual(cleanup[0].productionControls, [])
  }
  if (options.red) {
    assert.notEqual(code, 0, 'source mutant must be RED')
    assert.match(log, /test result: FAILED/); assert.doesNotMatch(log, /could not compile|error\[E\d+\]/, 'compile failure is not behavioral RED')
  } else {
    assert.equal(code, 0, log)
    assert.match(log, /test result: ok\. 1 passed/)
    if (!options.unit) { assert.equal(records.length, 1); assert.deepEqual(cleanup[0].exactPrivateChildTerm, []) }
  }
  const inputs = Object.fromEntries(await Promise.all([...originals.keys()].map(async path => [path.slice(source.length + 1), sha(await readFile(path))])))
  const binaryPath = join(privateRoot, 'target/debug/ctxmuxd')
  const binarySha256 = options.unit ? null : sha(await readFile(binaryPath))
  const record = { name, mode, expectation: options.red ? 'RED' : 'GREEN', code, logSha256: sha(log), inputs, binarySha256, records, cleanup }
  results.push(record)
  console.log(JSON.stringify({ name, code, expectation: record.expectation, cleanup: cleanup.map(value => value.remaining) }))
}
let failure
try {
  await run('shipping-control')
  for (const mode of ['process', 'resize', 'export']) {
    await reset(); await writeFile(terminalPath, faultSource(mode)); await run(mode + '-fault-control', mode)
  }
  await reset(); await writeFile(terminalPath, faultSource('process').replace(
    'std::panic::catch_unwind(std::panic::AssertUnwindSafe(derive)).ok()', 'Some(derive())'))
  assert.notEqual(await readFile(terminalPath, 'utf8'), faultSource('process'))
  await run('guard-source-mutant', 'process', { red: true })
  await reset(); await writeFile(terminalPath, faultSource('process')); await run('guard-restored-control', 'process')
  await writeFile(libPath, replace(originals.get(libPath),
    'self.terminal = None;\n            self.terminal_absence = TerminalCheckpointUnavailableReason::InvalidCheckpoint;',
    'self.terminal_absence = TerminalCheckpointUnavailableReason::InvalidCheckpoint;'))
  await run('discard-model-source-mutant', 'process', { red: true })
  await reset(); await writeFile(terminalPath, faultSource('process')); await run('discard-model-restored-control', 'process')
  await writeFile(libPath, replace(originals.get(libPath), 'self.chunks.push_back(chunk.clone());', '// source mutant: original range omitted'))
  await run('original-bytes-source-mutant', 'process', { red: true })
  await reset(); await writeFile(terminalPath, faultSource('process')); await run('original-bytes-restored-control', 'process')
  await reset(); await run('finished-owner-control', 'none', { unit: true })
  await writeFile(ownerPath, replace(originals.get(ownerPath), 'if matches!(&*state, OwnerState::Running { thread, .. } if thread.is_finished()) {',
    'if false && matches!(&*state, OwnerState::Running { thread, .. } if thread.is_finished()) {'))
  await run('finished-owner-source-mutant', 'none', { unit: true, red: true })
  await reset(); await run('finished-owner-restored-control', 'none', { unit: true })
  await writeFile(terminalPath, faultSource('retention'))
  await run('retention-dirty-control', 'retention', { unit: 'retention' })
  await writeFile(libPath, replace(originals.get(libPath),
    'if self\n            .derive_terminal(|terminal| terminal.retention_cut(id, first, latest))\n            .unwrap_or(false)\n        {\n            self.checkpoint_dirty = true;\n        }',
    'self.checkpoint_dirty |= self.derive_terminal(|terminal| terminal.retention_cut(id, first, latest)).unwrap_or(false);'))
  // Rust's compound assignment evaluates the RHS before reading the place.
  // This is an equivalent GREEN, not an additional behavioral source RED.
  await run('retention-dirty-equivalent-control', 'retention', { unit: 'retention' })
  await writeFile(libPath, originals.get(libPath))
  await run('retention-dirty-restored-control', 'retention', { unit: 'retention' })
  await reset()
  const stopped = replace(originals.get(ownerPath), '.spawn(move || {\n                owner_main(',
    '.spawn(move || {\n                let mut private_owner_stops = true;\n                if std::mem::take(&mut private_owner_stops) { return; }\n                owner_main(')
  await writeFile(ownerPath, stopped); await run('public-start-stopped-owner-control', 'owner_stopped')
  await writeFile(libPath, replace(originals.get(libPath),
    'config.native_runs.ensure_running()\n            .map_err(|message| ProtocolError::new(ErrorCode::BackendUnavailable, message))?;',
    '// source mutant: missing before-PTY owner admission'))
  await run('before-child-start-source-mutant', 'owner_stopped', { red: true })
  await writeFile(libPath, originals.get(libPath)); await run('before-child-start-restored-control', 'owner_stopped')
  await reset(); await run('final-shipping-control')
} catch (error) { failure = error.stack ?? String(error) }
finally {
  await reset()
  const after = await capture()
  if (JSON.stringify(before) !== JSON.stringify(after)) failure ??= 'Original candidate inputs changed during independent proof'
  const runnerAfter = sha(await readFile(fileURLToPath(import.meta.url)))
  if (runnerBefore !== runnerAfter) failure ??= 'Proof runner changed during execution'
  const receipt = { schema: 'agentmux.native-output-owner-isolation.v1', passed: !failure,
    nativeSourceRoot: native, privateSourceRoot: source, runnerBefore, runnerAfter, inputsBefore: before, inputsAfter: after, results,
    productionControls: [], failure: failure ?? null,
    limitations: ['Source-copy adversarial derivation faults are not attribution of the lost production trigger.',
      'No active health wire was added; stopped-owner fact is returned at existing lifecycle requests.',
      'No production recovery, installation, original live-PTY retention, Provider semantics or Main workbench restart is claimed.'] }
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, results: results.length, failure: receipt.failure }))
  if (!receipt.passed) process.exitCode = 1
}
