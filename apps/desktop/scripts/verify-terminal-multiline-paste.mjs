import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// Execute the exact pinned native paste-parser function, with type-only event declarations.
// This does not run Codex's composer/model or send input to an existing Agent Run.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-paste-parser-'))
const receiptPath = path.join(root, '.tmp/terminal-multiline-paste-last.json')
const codexRef = '8b9fa496bbf2c47aebd62e85a080b9a522a455b5'
const parserRef = 'efa177859fd9623d57b9fe7ae9bf491ae1ac6ec4'
const sources = [
  ['parser', 'openai-oss-forks/crossterm', 'src/event/sys/unix/parse.rs', parserRef, '98bcc0b9439661a6562175eaba94bb44c0857fbcd5dd666b8dd2c4dca88cde00'],
  ['tui', 'openai/codex', 'codex-rs/tui/Cargo.toml', codexRef, '89240b8f9298fd15022e20756d8407af8b78c8fa19d04ad46120bd9d7c62baa1'],
  ['lock', 'openai/codex', 'codex-rs/Cargo.lock', codexRef, '4fab6fe99180e2b8f305bd4b33c1b4bd825e3fa4cdef1045be750843bd3d431e'],
  ['composer', 'openai/codex', 'codex-rs/tui/src/bottom_pane/chat_composer/paste_input.rs', codexRef, 'a129a32117af4b2f330bf1848dec7dc4480b679d83f2f289e8df9c5394bdcfbf']
]
const selected = [fileURLToPath(import.meta.url), path.join(root, 'apps/desktop/scripts/probe-process.mjs'),
  ...['agent-provider.js', 'providers/index.js', 'providers/codex.js', 'providers/shared.js', 'bracketed-paste.js']
    .map(name => path.join(root, 'packages/core/dist', name))]
const digest = data => createHash('sha256').update(data).digest('hex')
const fileDigest = async file => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const manifest = async files => Object.fromEntries(await Promise.all(files.map(async file => [file, await fileDigest(file)])))
const env = { ...process.env, HOME: privateRoot, CODEX_HOME: path.join(privateRoot, 'codex-home'),
  XDG_CONFIG_HOME: path.join(privateRoot, 'config'), XDG_DATA_HOME: path.join(privateRoot, 'data'),
  XDG_CACHE_HOME: path.join(privateRoot, 'cache') }
for (const name of Object.keys(env)) if (name.startsWith('AGENTMUX_')) delete env[name]
const groups = []
const receipt = { schema: 'agentmux.terminal-multiline-paste-parser.v1', passed: false,
  proofKind: 'exact-native-parser-function', fullCliComposerExecuted: false, userRunTouched: false,
  privateRoot, eventTypesAreTypeOnlyFacade: true,
  sourceRecords: [], processRuns: [], input: null, parserResult: null,
  selectedBefore: null, selectedAfter: null, cleanup: { errors: [], remaining: null, rootRemoved: false } }

async function run(command, args, timeoutMs = 15_000, commandEnv = env) {
  const child = spawn(command, args, { cwd: privateRoot, env: commandEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  if (child.pid) groups.push(child.pid)
  const record = { command, args, pid: child.pid, exitCode: null, outputBytes: 0 }
  receipt.processRuns.push(record)
  let stdout = '', stderr = '', failure
  const timeout = setTimeout(() => {
    failure = new Error(`Private ${command} exceeded ${timeoutMs}ms`)
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') receipt.cleanup.errors.push(String(error)) } }
  }, timeoutMs)
  const collect = stream => chunk => {
    record.outputBytes += chunk.length
    if (record.outputBytes > 128 * 1024) {
      failure = new Error('Private command exceeded its output budget')
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') receipt.cleanup.errors.push(String(error)) } }
    }
    if (stream === 'out') stdout += chunk.toString(); else stderr += chunk.toString()
  }
  child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'))
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { record.exitCode = code; record.signal = signal; resolve() })
    })
    if (failure) throw failure
    assert.equal(record.exitCode, 0, stderr)
    return stdout
  } finally { clearTimeout(timeout) }
}

async function loadSource([id, repository, file, ref, expected]) {
  const url = `https://api.github.com/repos/${repository}/contents/${file}?ref=${ref}`
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentMux-private-paste-proof' },
    signal: AbortSignal.timeout(15_000) })
  assert.equal(response.status, 200, `Official source request failed: ${id}`)
  const data = await response.json()
  assert.equal(data.encoding, 'base64')
  const body = Buffer.from(data.content, 'base64')
  assert.ok(body.length > 0 && body.length < 600 * 1024)
  assert.equal(digest(body), expected)
  const blob = createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex')
  assert.equal(blob, data.sha)
  receipt.sourceRecords.push({ id, url, bytes: body.length, sha256: expected, gitBlob: blob })
  return [id, body.toString('utf8')]
}

try {
  await fs.mkdir(env.CODEX_HOME, { mode: 0o700 })
  receipt.selectedBefore = await manifest(selected)
  receipt.cliVersion = (await run('codex', ['--version'])).trim()
  assert.equal(receipt.cliVersion, 'codex-cli 0.159.2', 'This proof is bound to Codex 0.159.2')
  // Resolve the installed compiler through rustup's read-only query, preserving its toolchain home.
  const rustc = (await run('rustup', ['which', 'rustc'], 15_000, {
    ...env, RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(os.homedir(), '.rustup')
  })).trim()
  assert.ok(path.isAbsolute(rustc))
  receipt.compiler = { path: rustc, sha256: await fileDigest(rustc) }
  receipt.rustVersion = (await run(rustc, ['--version'])).trim()
  const native = Object.fromEntries(await Promise.all(sources.map(loadSource)))
  assert.match(native.tui, /crossterm = \{ workspace = true, features = \["bracketed-paste", "event-stream"\] \}/)
  const lockBlocks = native.lock.split('[[package]]').filter(block => /^\s*name = "crossterm"\s*$/m.test(block))
  assert.equal(lockBlocks.length, 1)
  assert.ok(lockBlocks[0].includes(parserRef))
  const marker = '#[cfg(feature = "bracketed-paste")]\npub(crate) fn parse_csi_bracketed_paste('
  const start = native.parser.indexOf(marker)
  assert.ok(start >= 0 && native.parser.indexOf(marker, start + 1) === -1)
  const end = native.parser.indexOf('\n}\n\npub(crate) fn parse_utf8_char', start)
  assert.ok(end > start)
  const parser = native.parser.slice(start, end + 2)
  assert.ok(parser.includes('Event::Paste(paste)') && parser.length > 300)
  receipt.parserFunctionSha256 = digest(parser)
  const { AgentProviderRegistry } = await import(pathToFileURL(path.join(root, 'packages/core/dist/agent-provider.js')).href)
  const text = '  first\r\n第二 line\n  '
  const plan = new AgentProviderRegistry().get('codex').planPromptInput(text)
  assert.equal(plan.kind, 'render-then-submit')
  assert.equal(plan.payload, `\x1b[200~${text}\x1b[201~`)
  assert.equal(plan.submit, '\r')
  await fs.writeFile(path.join(privateRoot, 'payload.bin'), plan.payload)
  await fs.writeFile(path.join(privateRoot, 'text.bin'), text)
  receipt.input = { textBytes: Buffer.byteLength(text), textSha256: digest(text),
    payloadBytes: Buffer.byteLength(plan.payload), payloadSha256: digest(plan.payload),
    submitWasNotIncluded: true }
  const rust = String.raw`use std::{fs, io};
#[derive(Debug, PartialEq)] enum Event { Paste(String) }
#[derive(Debug, PartialEq)] enum InternalEvent { Event(Event) }
${parser}
fn main() {
 let payload = fs::read("payload.bin").unwrap();
 let text = fs::read_to_string("text.bin").unwrap();
 assert_eq!(parse_csi_bracketed_paste(&payload[..payload.len()-1]).unwrap(), None);
 assert_eq!(parse_csi_bracketed_paste(&payload[..6]).unwrap(), None);
 let parsed = parse_csi_bracketed_paste(&payload).unwrap();
 let Some(InternalEvent::Event(Event::Paste(returned))) = parsed else { panic!("Expected one real Paste event") };
 assert_eq!(returned, text);
 assert_eq!(parse_csi_bracketed_paste(b"\x1b[200~\x1b[201~").unwrap(), Some(InternalEvent::Event(Event::Paste(String::new()))));
 println!(r#"{{"cases":4,"completeFrameEvents":1,"contentBytes":{},"lineBreaks":{}}}"#, returned.len(), returned.matches('\n').count());
}
`
  await fs.writeFile(path.join(privateRoot, 'exact-parser.rs'), rust)
  receipt.harnessSha256 = digest(rust)
  await run(rustc, ['--edition=2021', '--cfg', 'feature="bracketed-paste"', '-C', 'debuginfo=0',
    '-C', 'opt-level=1', 'exact-parser.rs', '-o', 'exact-parser'])
  receipt.parserResult = JSON.parse(await run(path.join(privateRoot, 'exact-parser'), []))
  assert.deepEqual(receipt.parserResult, { cases: 4, completeFrameEvents: 1,
    contentBytes: Buffer.byteLength(text), lineBreaks: 2 })
  // This is source evidence for the downstream composer, not executed composer behavior.
  assert.ok(native.composer.includes('pub fn handle_paste(&mut self, pasted: String) -> bool'))
  assert.ok(native.composer.includes('self.apply_paste(pasted)'))
  assert.ok(native.composer.includes('pasted.replace("\\r\\n", "\\n").replace(\'\\r\', "\\n")'))
  receipt.selectedAfter = await manifest(selected)
  assert.deepEqual(receipt.selectedAfter, receipt.selectedBefore)
  receipt.passed = true
} catch (error) {
  receipt.failure = String(error?.stack ?? error)
} finally {
  for (const group of groups) {
    try { await stopProbeProcesses(group, privateRoot) } catch (error) { receipt.cleanup.errors.push(String(error)) }
  }
  try {
    receipt.cleanup.remaining = await listProbeProcesses(process.pid + 1_000_000_000, privateRoot)
    if (receipt.cleanup.remaining.length === 0) {
      await fs.rm(privateRoot, { recursive: true })
      receipt.cleanup.rootRemoved = true
    }
  } catch (error) { receipt.cleanup.errors.push(String(error)) }
  if (receipt.cleanup.errors.length || !receipt.cleanup.rootRemoved || receipt.cleanup.remaining?.length !== 0) receipt.passed = false
  await fs.mkdir(path.dirname(receiptPath), { recursive: true })
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
}
console.log(JSON.stringify({ passed: receipt.passed, proofKind: receipt.proofKind,
  fullCliComposerExecuted: false, parserResult: receipt.parserResult, cleanup: receipt.cleanup, failure: receipt.failure }))
if (!receipt.passed) process.exitCode = 1
