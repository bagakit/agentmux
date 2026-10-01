import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = resolve(root, '.tmp/terminal-resume-recap')
const receiptPath = resolve(evidence, 'source-mutations.json')
const recap = 'apps/desktop/src/renderer/src/components/SessionRecap.tsx'
const pane = 'apps/desktop/src/renderer/src/components/SessionPane.tsx'
const terminal = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const recapTest = 'apps/desktop/test/session-recap.test.tsx'
const paneTest = 'apps/desktop/test/session-native-history-surface.test.tsx'
const terminalTest = 'apps/desktop/test/terminal-history-wheel.test.tsx'
const mutations = [
  { name: 'product-wire', assertionIncludes: "'Reading saved conversation…'", source: pane, test: paneTest, title: 'keeps the real pending SessionPane stage', edits: [
    { before: "                supplement={session.kind === 'agent' ? <SessionRecap session={session.control} visible={visible && !parked} /> : null}", after: '' }
  ] },
  { name: 'foreign-native', assertionIncludes: "'Recap could not be read.'", source: recap, test: recapTest, title: 'ignores a foreign timeline owner', edits: [
    { before: "        if (page.agentSessionId !== agentSessionId) throw new Error('Recap belongs to another Session.')", after: '' }
  ] },
  { name: 'late-owner', assertionIncludes: "not to contain 'OLD HOST'", source: recap, test: recapTest, title: 'binds late replies to Host', edits: [
    { before: 'return () => { current = false }', after: 'return () => { current = true }' },
    { before: 'const currentRead = read?.key === key ? read : null', after: 'const currentRead = read' }
  ] },
  { name: 'hidden-read', assertionIncludes: '"historyPage" to not be called at all', source: recap, test: recapTest, title: 'does not observe or read a hidden stage', edits: [
    { before: 'if (!visible || !identified || captured) return', after: 'if (!identified || captured) return' }
  ] },
  { name: 'resume-gate', assertionIncludes: 'expected true to be false', source: pane, test: paneTest, title: 'keeps the real pending SessionPane stage', edits: [
    { before: 'disabled={recovering} onClick={() => void recover()}', after: 'disabled={true} onClick={() => void recover()}', matches: 2 }
  ] },
  { name: 'stage-observation', assertionIncludes: '"historyPage" to be called once with arguments:', source: terminal, test: terminalTest, title: 'keeps the actual starting-agent stage', edits: [
    { before: '              key="terminal-recovery"\n', after: '', matches: 2, all: true }
  ] }
]
const sha256 = value => createHash('sha256').update(value).digest('hex')
function requireFact(condition, message) { if (!condition) throw new Error(message) }
function run(command, logPath) {
  const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', timeout: 60_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(logPath, output)
  requireFact(!result.error && result.signal === null, `Test process failed to complete: ${result.error ?? result.signal}`)
  return { exit: result.status, output, log: relative(root, logPath), log_sha256: sha256(output) }
}

mkdirSync(evidence, { recursive: true })
const receipts = []
writeFileSync(receiptPath, JSON.stringify({ schema: 'agentmux.terminal-resume-recap.source-mutations.v1', passed: false, mutations: receipts }, null, 2) + '\n')
for (const mutation of mutations) {
  const file = resolve(root, mutation.source)
  const original = readFileSync(file)
  const beforeSha = sha256(original)
  let broken = original.toString('utf8')
  for (const edit of mutation.edits) {
    const count = broken.split(edit.before).length - 1
    requireFact(count === (edit.matches ?? 1), `${mutation.name}: source anchor matches ${count}`)
    broken = edit.all ? broken.split(edit.before).join(edit.after) : broken.replace(edit.before, edit.after)
  }
  requireFact(broken !== original.toString('utf8'), `${mutation.name}: mutation is empty`)
  const command = ['pnpm', 'exec', 'vitest', 'run', mutation.test, '-t', mutation.title]
  let red
  try {
    writeFileSync(file, broken)
    red = run(command, resolve(evidence, `${mutation.name}-red.log`))
  } finally {
    writeFileSync(file, original)
  }
  const restoredSha = sha256(readFileSync(file))
  requireFact(restoredSha === beforeSha, `${mutation.name}: original bytes were not restored`)
  requireFact(red.exit !== 0 && red.output.includes('AssertionError:') && /Test Files\s+1 failed/u.test(red.output) && /Tests\s+1 failed/u.test(red.output), `${mutation.name}: missing genuine nonempty behavior assertion RED`)
  const assertion = red.output.split('\n').find(line => line.startsWith('AssertionError:'))
  requireFact(assertion?.includes(mutation.assertionIncludes) && red.output.includes(`${mutation.test}:`), `${mutation.name}: RED did not reach the intended mounted behavior assertion`)
  const green = run(command, resolve(evidence, `${mutation.name}-green.log`))
  requireFact(green.exit === 0 && /Test Files\s+1 passed/u.test(green.output) && /Tests\s+1 passed/u.test(green.output), `${mutation.name}: restored same input is not nonempty GREEN`)
  receipts.push({ name: mutation.name, assertion, source: mutation.source, source_sha256: beforeSha,
    mutated_sha256: sha256(broken), restored_sha256: restoredSha, test: mutation.test,
    test_sha256: sha256(readFileSync(resolve(root, mutation.test))), command, edits: mutation.edits,
    red_exit: red.exit, green_exit: green.exit, red_log: red.log, green_log: green.log,
    red_log_sha256: red.log_sha256, green_log_sha256: green.log_sha256 })
  writeFileSync(receiptPath, JSON.stringify({ schema: 'agentmux.terminal-resume-recap.source-mutations.v1', passed: false, mutations: receipts }, null, 2) + '\n')
  console.log(`${mutation.name}: Assertion RED -> exact restored GREEN`)
}
requireFact(receipts.length === 6, 'Mutation set is incomplete')
writeFileSync(receiptPath, JSON.stringify({ schema: 'agentmux.terminal-resume-recap.source-mutations.v1', passed: true, mutations: receipts }, null, 2) + '\n')
console.log(relative(root, receiptPath))
