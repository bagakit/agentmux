import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, 'docs/reviews/evidence/launcher-resume-2026-10-04')
mkdirSync(output, { recursive: true })
const test = 'apps/desktop/test/launcher-resume-picker.test.tsx'
const component = 'apps/desktop/src/renderer/src/components/LauncherResumePicker.tsx'
const helper = 'apps/desktop/src/renderer/src/lib/launcher-resume.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const mutations = [
  { name: 'ignore-project-ownership', file: helper, from: "if (scope === 'project' && !row.inProject) return false", to: 'if (false) return false' },
  { name: 'resume-first-global-candidate', file: component, from: 'const id = row.candidate.agentSessionId', to: 'const id = candidates[0]?.agentSessionId ?? row.candidate.agentSessionId' },
  { name: 'omit-catalogue-projection', file: store, from: "projected = recoveryCandidateSession(candidate, { kind: 'pending', detail: 'Checking this saved Session for attachment or native resume.' })", to: 'return' },
  { name: 'omit-original-session-view', file: store, from: 'if (!hasAttachedSessionView(get().tabs, sessionId)) get().selectSession(sessionId)', to: '// Mutation: omit the real candidate view owner.' },
  { name: 'unbounded-selected-recap-page', file: component, from: '{ limit: 6 }', to: '{ limit: 30 }' },
  { name: 'accept-other-session-recap', file: component, from: "if (page.agentSessionId !== selectedSessionId) throw new Error('Conversation read returned another Session identity.')", to: '// Mutation: accept a foreign page.' },
  { name: 'apply-late-recap-after-selection-leaves', file: component, from: 'if (!current || owner !== requestOwner.current) return', to: 'if (false) return', all: true },
  { name: 'retry-obsolete-run-instead-of-refreshing-current', file: component, from: "if (current?.status.continuityConflict === 'session-run-changed') await before.refreshSession(id)", to: '// Mutation: retry the obsolete Run.' },
  { name: 'subscribe-to-all-timelines-while-closed', file: component, from: 'const [open, setOpen] = useState(false)', to: 'const [open, setOpen] = useState(false)\n  useAppStore(state => state.timelines)' },
  { name: 'rebuild-all-candidates-for-unrelated-output', file: component,
    from: 'const [facts, setFacts] = useState(EMPTY_FACTS)',
    to: 'const [facts, setFacts] = useState(EMPTY_FACTS)\n  const unrelatedTimelineDependency = useAppStore(state => open ? state.timelines : EMPTY_FACTS.timelines)',
    secondFrom: '[open, candidates, config, workspace, facts, reads]', secondTo: '[open, candidates, config, workspace, facts, reads, unrelatedTimelineDependency]' }
]
function run(name) {
  let status = 0, log = ''
  try { log = execFileSync(resolve(root, 'node_modules/.bin/vitest'), ['run', test, '--maxWorkers=1'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }) }
  catch (error) { status = error.status ?? -1; log = `${error.stdout ?? ''}\n${error.stderr ?? ''}` }
  writeFileSync(resolve(output, `${name}.log`), log)
  return { name, status, assertionFailure: /AssertionError|Tests\s+\d+ failed/.test(log), log: `docs/reviews/evidence/launcher-resume-2026-10-04/${name}.log` }
}
const receipts = [run('baseline')]
if (receipts[0].status !== 0) throw new Error('Baseline must be green before mutation.')
for (const mutation of mutations) {
  const file = resolve(root, mutation.file), before = readFileSync(file, 'utf8')
  if (!before.includes(mutation.from)) throw new Error(`Mutation target missing: ${mutation.name}`)
  let changed = mutation.all ? before.replaceAll(mutation.from, mutation.to) : before.replace(mutation.from, mutation.to)
  if (mutation.secondFrom) {
    if (!changed.includes(mutation.secondFrom)) throw new Error(`Second mutation target missing: ${mutation.name}`)
    changed = changed.replace(mutation.secondFrom, mutation.secondTo)
  }
  try {
    writeFileSync(file, changed)
    const receipt = run(mutation.name); receipts.push(receipt)
    if (receipt.status === 0 || !receipt.assertionFailure) throw new Error(`Mutation must fail an actual assertion: ${mutation.name}`)
  } finally { writeFileSync(file, before) }
}
receipts.push(run('restored'))
if (receipts.at(-1).status !== 0) throw new Error('Restored source must be green.')
writeFileSync(resolve(output, 'mutation-receipt.json'), JSON.stringify({ schema: 'agentmux.launcher-resume-mutation.v1', test, receipts }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ baseline: 'green', mutations: mutations.length, allMutations: 'assertion-red', restored: 'green', receipt: `${output}/mutation-receipt.json` }) + '\n')
