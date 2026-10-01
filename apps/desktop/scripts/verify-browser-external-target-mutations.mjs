import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = join(root, '.tmp/browser-external-target', ("mutations-" + (globalThis.crypto.randomUUID()) + ""))
await mkdir(output, { recursive: true })
const worker = 'apps/desktop/browser-extension/service-worker.js'
const bridge = 'apps/desktop/src/main/browser-external-bridge.ts'
const target = 'apps/desktop/src/main/browser-external-target.ts'
const protocol = 'apps/desktop/browser-extension/protocol.js'
// Mutate the actual authority/result blocks, including every redundant gate in a
// block where applicable. An Assertion failure, not startup or timeout, is required.
const blocks = [
  { name: 'attach-preparation-authority', path: worker, edits: [["current(true)\n        if (this.attachOwners.get(grant.tabId) !== lease || lease.cancelled || !grant.attached) throw new Error('The original operation stopped during debugger preparation.')\n        const tree", 'const tree']] },
  { name: 'popup-authority', path: worker, edits: [["if (sender.tab || sender.url !== this.api.runtime.getURL('popup.html')) return false", 'if (false) return false']] },
  { name: 'selected-tab', path: worker, edits: [["if (selected?.id !== message.tabId) throw new Error", 'if (false) throw new Error']] },
  { name: 'transport-not-consent', path: bridge, edits: [['if (!row && !explicit) return null', 'if (false) return null']] },
  { name: 'bounded-methods', path: protocol, edits: [["typeof method !== 'string' || !methods.has(method)", "typeof method !== 'string'"]] },
  { name: 'child-session-ownership', path: worker, edits: [["if (message.sessionId && !grant.frames.has(message.sessionId)) throw new Error", 'if (false) throw new Error']] },
  { name: 'revoke-before-action', path: worker, edits: [
    ['this.grants.get(message.tabId) !== grant || ', ''],
    ['lease?.grant !== grant || lease.cancelled || lease.generation', 'lease?.grant !== grant || lease.generation'],
    ["!grant.attached || !isTabScopedCommand(message.method, message.params)", '!isTabScopedCommand(message.method, message.params)']
  ] },
  { name: 'queued-document-epoch', path: worker, edits: [["(!allowNavigation && message.navigationId !== grant.navigationId)", 'false']] },
  { name: 'cancel-inflight-attach', path: worker, edits: [["if (lease.cancelled) throw new Error", 'if (false) throw new Error']] },
  { name: 'operation-detach-ownership', path: worker, edits: [["if (lease && (lease.grant !== grant || lease.generation !== generation || lease.operationId !== message.operationId || lease.callerId !== message.callerId)) throw new Error", 'if (false) throw new Error']] },
  { name: 'response-original-tuple', path: bridge, edits: [["if (message.operationId !== pending.owner.operationId || message.callerId !== pending.owner.callerId ||\n      message.sessionId !== pending.sessionId) return", 'if (false) return']] },
  { name: 'error-document-epoch', path: bridge, edits: [["const documentChanged = row.navigationId !== pending.navigationId || message.navigationId !== pending.navigationId", 'const documentChanged = false']] },
  { name: 'child-result-epoch', path: target, edits: [["if (sessionId && this.frames.get(sessionId) !== frame) throw new ExternalBrowserRequestFailure", 'if (false) throw new ExternalBrowserRequestFailure']] },
  { name: 'child-error-epoch', path: target, edits: [["const failure = sessionId && this.frames.get(sessionId) !== frame &&", 'const failure = false &&']] },
  { name: 'descendant-removal', path: target, edits: [["for (const [child, parent] of this.parents) if (parent && removed.has(parent)) removed.add(child)", 'for (const [child, parent] of this.parents) void parent']] },
  { name: 'main-document-event', path: target, edits: [["if (event.mainDocumentNavigation) {", "if (event.mainDocumentNavigation || event.method === 'Page.navigatedWithinDocument') {"]] },
  { name: 'discovery-failure-is-not-death', path: target, edits: [["catch (error) { this.missing = `Shared-tab frame discovery", "catch (error) { this.gone = 'Frame discovery stopped the page'; this.missing = `Shared-tab frame discovery"]] },
  { name: 'restart-disconnected-projection', path: bridge, edits: [["status: row.status === 'ready' ? 'disconnected' : row.status", 'status: row.status']] },
  { name: 'revoked-grant-stays-revoked', path: bridge, edits: [["if (row && ['revoked', 'closed'].includes(row.status)) return null", 'if (false) return null']] },
  { name: 'browser-instance-pinning', path: bridge, edits: [["pairing.extensionId !== extensionId || pairing.instanceId !== hello.data.instanceId", 'pairing.extensionId !== extensionId']] }
]
const selected = process.argv.find(value => value.startsWith('--blocks='))?.slice('--blocks='.length).split(',')
const chosenBlocks = selected ? blocks.filter(block => selected.includes(block.name)) : blocks
if (!chosenBlocks.length || (selected && chosenBlocks.length !== selected.length)) throw new Error('Unknown or empty mutation block selection.')
const originals = new Map()
for (const block of chosenBlocks) if (!originals.has(block.path)) originals.set(block.path, await readFile(join(root, block.path), 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.browser-external-source-mutations.v1', sourceOnly: true,
  nativePassed: false, files: [...originals].map(([path, bytes]) => ({ path, sha256: sha(bytes) })),
  command: ['pnpm', 'exec', 'vitest', 'run', '--config', 'apps/desktop/scripts/fixtures/browser-external-target/vitest.owning.config.mts',
    'apps/desktop/test/browser-external-target.test.ts', '--maxWorkers=1'],
  environment: { PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false' }, attempts: [], passed: false }
const run = name => {
  const result = spawnSync(receipt.command[0], receipt.command.slice(1), { cwd: root, encoding: 'utf8', timeout: 40_000,
    env: { ...process.env, ...receipt.environment }, maxBuffer: 2 * 1024 * 1024 })
  return { result, text: `${result.stdout ?? ''}${result.stderr ?? ''}`, name }
}
const baseline = run('baseline')
await writeFile(join(output, 'baseline.log'), baseline.text)
if (baseline.result.status !== 0) throw new Error(`Source baseline failed; retained ${output}`)
for (const block of chosenBlocks) {
  const path = join(root, block.path)
  const original = originals.get(block.path)
  if (await readFile(path, 'utf8') !== original) throw new Error(`Source changed outside this mutation: ${block.path}`)
  let mutant = original
  for (const [before, after] of block.edits) {
    if (mutant.split(before).length !== 2) throw new Error(`Mutation anchor is not unique: ${block.name}`)
    mutant = mutant.replace(before, after)
  }
  let attempt
  await writeFile(path, mutant)
  try {
    const red = run(block.name)
    await writeFile(join(output, `${block.name}.red.log`), red.text)
    attempt = { name: block.name, path: block.path, mutantSha256: sha(mutant), exit: red.result.status,
      assertionRed: red.result.status !== null && red.result.status !== 0 && /AssertionError/.test(red.text), restoredGreen: false }
  } finally {
    if (await readFile(path, 'utf8') !== mutant) throw new Error(`Concurrent Source change retained; refused overwrite: ${block.path}`)
    await writeFile(path, original)
  }
  const restored = run(`${block.name}.restore`)
  await writeFile(join(output, `${block.name}.restore.log`), restored.text)
  attempt.restoredGreen = restored.result.status === 0
  receipt.attempts.push(attempt)
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
  if (!attempt.assertionRed || !attempt.restoredGreen) throw new Error(`Mutation not proved: ${block.name}; retained ${output}`)
  process.stdout.write(`${block.name}: Assertion RED -> restored GREEN\n`)
}
for (const [path, bytes] of originals) if (await readFile(join(root, path), 'utf8') !== bytes) throw new Error(`Final Source drift: ${path}`)
receipt.passed = true
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
process.stdout.write(`${output}\n`)
