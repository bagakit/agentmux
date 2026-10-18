import { defineConfig } from 'vitest/config'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const changes: Record<string, [string, string, string]> = {
  'initial-opportunity-omitted': ['client.ts', "if (evidence?.state === 'idle') return { session, inputByte: run.acceptedInputBytes, nativeIdle: evidence }", "if (evidence?.state === 'idle') return { session, inputByte: run.acceptedInputBytes }"],
  'native-opportunity-not-rechecked': ['prompt-submission.ts', "if (current.semanticStatus?.state === 'working' || evidence?.state !== 'idle' ||\n          evidence.sourceId !== expected.sourceId || evidence.id !== expected.id)", 'if (false)'],
  'final-native-opportunity-not-rechecked': ['prompt-submission.ts', 'await prepared.assertCurrent()\n          await assertNativeIdle()', 'await prepared.assertCurrent()'],
  'unknown-activity-denies-idle': ['client.ts', "session.semanticStatus?.state === 'working' || session.currentActivity?.state === 'active'", "session.semanticStatus?.state === 'working' || session.currentActivity && session.currentActivity.state !== 'idle'"],
  'final-input-fence-omitted': ['prompt-submission.ts', 'if (control?.idleOnly && currentRun.acceptedInputBytes !== control.idleOnly.inputByte)', 'if (false)'],
  'failed-claim-becomes-opportunity': ['agent-message-notifications.ts', 'const opportunity = JSON.stringify([condition.expectedRun, idle, position])', 'const opportunity = JSON.stringify([condition.expectedRun, idle, condition.afterSubmissionId, position])']
}
export default defineConfig({ root, plugins: [{ name: 'a2a-initial-idle-source', enforce: 'pre', resolveId(id) {
  const match = id.match(/^@agentmux\/([^/]+)(.*)$/u)
  if (!match) return
  const directory = resolve(root, 'packages', match[1]!)
  const manifestPath = resolve(directory, 'package.json'), manifest = readFileSync(manifestPath, 'utf8')
  if (process.env.AGENTMUX_INITIAL_IDLE_LOADED) {
    const sha256 = createHash('sha256').update(manifest).digest('hex')
    appendFileSync(process.env.AGENTMUX_INITIAL_IDLE_LOADED, JSON.stringify({ path: relative(root, manifestPath), originalSHA256: sha256, sha256 }) + '\n')
  }
  const entry = JSON.parse(manifest).exports?.[match[2] ? '.' + match[2] : '.']?.import
  if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
}, transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!path.startsWith('packages/') || path.includes('/node_modules/') || !path.endsWith('.ts')) return
  const mutation = process.env.AGENTMUX_INITIAL_IDLE_MUTATION
  if (mutation && !changes[mutation]) throw new Error('Unknown initial-idle source mutation')
  const change = mutation && changes[mutation]
  let code = source
  if (change && path === 'packages/core/src/' + change[0]) {
    if (source.split(change[1]).length !== 2) throw new Error('Initial-idle mutation anchor must occur exactly once: ' + mutation)
    code = source.replace(change[1], change[2])
  }
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  if (process.env.AGENTMUX_INITIAL_IDLE_LOADED) appendFileSync(process.env.AGENTMUX_INITIAL_IDLE_LOADED,
    JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), ...(source === code ? {} : { mutation }) }) + '\n')
  if (code !== source) return { code, map: null }
} }], test: { include: ['packages/core/test/a2a-initial-idle.test.ts', 'packages/core/test/a2a-idle-input.test.ts',
  'packages/core/test/restored-prompt-predecessor.test.ts',
  'packages/core/test/native-turn-activity.test.ts', 'packages/core/test/codex-idle-queue.test.ts'],
  globalSetup: [], maxWorkers: 1, testTimeout: 25_000, hookTimeout: 15_000, passWithNoTests: false } })
