import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = resolve(root, '.tmp/session-loading-recovery-quality')
const receiptPath = resolve(evidence, 'source-mutations.json')
const loading = 'apps/desktop/src/renderer/src/components/FullPageLoadingSurface.tsx'
const pane = 'apps/desktop/src/renderer/src/components/SessionPane.tsx'
const connecting = 'apps/desktop/src/renderer/src/components/SessionConnectingSurface.tsx'
const recap = 'apps/desktop/src/renderer/src/components/SessionRecap.tsx'
const paneTest = 'apps/desktop/test/session-native-history-surface.test.tsx'
const connectingTest = 'apps/desktop/test/session-connecting-surface.test.tsx'
const recapTest = 'apps/desktop/test/session-recap.test.tsx'
const mutations = [
  { name: 'stage-action', assertionIncludes: 'Resume', source: pane, test: paneTest,
    title: 'keeps a retained exited Session on one state with one original Resume action', edits: [
      { before: '                actions={!historyOpen ? agentRecoveryAction : null}\n', after: '' }
    ] },
  { name: 'action-before-long-detail', assertionIncludes: 'to be truthy', source: loading, test: paneTest,
    title: 'keeps the real pending SessionPane stage and Resume independent of a hanging recap, including resume in progress', edits: [
      { before: '        {actions ? <div className="full-page-loading__actions">{actions}</div> : null}\n        {children == null && detail ? <p className="full-page-loading__detail">{detail}</p> : null}',
        after: '        {children == null && detail ? <p className="full-page-loading__detail">{detail}</p> : null}\n        {actions ? <div className="full-page-loading__actions">{actions}</div> : null}' }
    ] },
  { name: 'duplicate-exit-overlay', assertionIncludes: 'to be null', source: pane, test: paneTest,
    title: 'keeps a retained exited Session on one state with one original Resume action', edits: [
      { before: '(disconnected || missing || exited) && !pendingAgentRestore', after: '(disconnected || missing || exited)' }
    ] },
  { name: 'unknown-main-facts', assertionIncludes: 'Core did not report why', source: pane, test: paneTest,
    title: 'keeps unconfirmed recovery facts and the original retry owner visible outside diagnostics', edits: [
      { before: 'detail={continuityNotice?.reason ?? (session.status.state', after: 'detail={(session.status.state' }
    ] },
  { name: 'connecting-single-heading', assertionIncludes: 'Starting your agent', source: connecting, test: connectingTest,
    title: 'lets the shared stage own one heading and renders only meaningful connection content', edits: [
      { before: 'supplement={<div className="session-connecting__body">', after: 'supplement={<div className="session-connecting__body"><h2>{title}</h2>' }
    ] },
  { name: 'complete-prompt-copy', assertionIncludes: 'writeClipboardText', source: connecting, test: connectingTest,
    title: 'copies the entire submitted prompt through the shared clipboard outlet and reports local failure then retry success', edits: [
      { before: 'copyTextToClipboard(prompt,', after: 'copyTextToClipboard(prompt.trim(),' }
    ] },
  { name: 'accessible-recap-source', assertionIncludes: 'Last reply source:', source: recap, test: recapTest,
    title: 'renders the exact captured excerpt and source before reading native history, preserving the helper selection', edits: [
      { before: '<summary aria-label={`${recap.source === \'Last assistant message\' ? \'Last reply\' : \'Last request\'} source: ${recap.source} · ${recap.origin === \'timeline\' ? \'Captured conversation\' : \'Native conversation\'}`}>', after: '<summary>' }
    ] }
]
const sha256 = value => createHash('sha256').update(value).digest('hex')
function requireFact(condition, message) { if (!condition) throw new Error(message) }
function run(command, logPath) {
  const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, FORCE_COLOR: '0' } })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(logPath, output)
  requireFact(!result.error && result.signal === null, `Test process failed to complete: ${result.error ?? result.signal}`)
  return { exit: result.status, output, log: relative(root, logPath), log_sha256: sha256(output) }
}

mkdirSync(evidence, { recursive: true })
const receipts = []
writeFileSync(receiptPath, JSON.stringify({ schema: 'agentmux.session-loading-recovery-quality.source-mutations.v1', passed: false, mutations: receipts }, null, 2) + '\n')
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
  writeFileSync(receiptPath, JSON.stringify({ schema: 'agentmux.session-loading-recovery-quality.source-mutations.v1', passed: false, mutations: receipts }, null, 2) + '\n')
  console.log(`${mutation.name}: Assertion RED -> exact restored GREEN`)
}
requireFact(receipts.length === 7, 'Mutation set is incomplete')
writeFileSync(receiptPath, JSON.stringify({ schema: 'agentmux.session-loading-recovery-quality.source-mutations.v1', passed: true, mutations: receipts }, null, 2) + '\n')
console.log(relative(root, receiptPath))
