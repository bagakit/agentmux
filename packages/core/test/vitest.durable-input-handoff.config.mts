import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const connectorRequire = createRequire(resolve(root, 'packages/connectors/package.json'))
const mutations = {
  'skip-session-exclusion': { file: 'packages/core/src/agent-input-claim-lease.ts', before: 'return await store.withPromptSubmission(key.agentSessionId, async () => {', after: 'return await (async (_id: string, callback: () => Promise<T>) => await callback())(key.agentSessionId, async () => {' },
  'forge-live-lease': { file: 'packages/core/src/agent-input-claim-lease.ts', before: 'const scope = live.get(lease)', after: "const scope = live.get(lease) ?? { store: journalOwners.get(journal)!, storeScope: 'forged-source', journalId, key }" },
  'reselect-pty-carrier': { file: 'packages/core/src/client.ts', before: "const ordinaryPlan = inputControl?.handoff && inputControl.handoff.carrier.kind !== 'launch'", after: "const ordinaryPlan = false && inputControl?.handoff && inputControl.handoff.carrier.kind !== 'launch'" },
  'replace-native-correlation': { file: 'packages/core/src/prompt-submission.ts', before: "const correlation = carrier?.kind === 'native' ? carrier.plan.clientCorrelation : createNativeInputCorrelation(inputKey)", after: 'const correlation = createNativeInputCorrelation(inputKey)' },
  'author-read-under-journal': { file: 'packages/core/src/client.ts', before: 'assertTarget: async () => { assertTarget(await this.currentStoredAgentSession(key.agentSessionId)) } },', after: 'assertTarget: beforeClaim },' },
  'ignore-current-author': { file: 'packages/core/src/client.ts', before: 'try { await observePromptInput(context.controller.signal, async () => { await context.authority?.assertCurrent() }) }', after: 'try { await observePromptInput(context.controller.signal, async () => { await context.authority?.assertCurrent() }).catch(() => {}) }' }
} as const
const selected = process.env.AGENTMUX_HANDOFF_MUTATION as keyof typeof mutations | undefined
if (selected && !mutations[selected]) throw Error('Unknown original input handoff mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/durable-input-handoff'), plugins: [{ name: 'actual-handoff-owner', enforce: 'pre', resolveId(source) {
  if (source === '@larksuiteoapi/node-sdk' || source === '@discordjs/rest') return connectorRequire.resolve(source)
  if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
  if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
  if (source.startsWith('@agentmux/core/')) {
    const entry = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports['./' + source.slice('@agentmux/core/'.length)]?.import
    if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
  }
}, transform(input, id) {
  const file = relative(root, id.split('?')[0]!)
  if (!/^packages\/core\/src\/.*\.ts$/u.test(file)) return
  const mutation = selected ? mutations[selected] : undefined
  let output = input
  if (mutation?.file === file) {
    if (input.split(mutation.before).length !== 2) throw Error('Original handoff mutation boundary changed: ' + selected)
    output = input.replace(mutation.before, mutation.after)
  }
  const marker = process.env.AGENTMUX_HANDOFF_LOADED
  if (marker && ['packages/core/src/agent-input-claim-lease.ts', 'packages/core/src/agent-global-message-queue.ts', 'packages/core/src/prompt-submission.ts', 'packages/core/src/client.ts'].includes(file)) {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const row = { file, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: input === output ? null : selected }
    return { code: "import { appendFileSync as __handoffLoaded } from 'node:fs'; __handoffLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + output, map: null }
  }
  return input === output ? undefined : { code: output, map: null }
} }], test: { environment: 'node', setupFiles: [resolve(root, 'vitest.setup.ts')], globalSetup: [], fileParallelism: false, passWithNoTests: false,
  include: ['packages/core/test/durable-input-handoff.test.ts', 'packages/core/test/session-continuity-message-input.test.ts', 'packages/core/test/durable-input-handoff-crash.test.ts', 'packages/core/test/session-input-recovery.test.ts', 'packages/core/test/controlled-input-retry.test.ts', 'packages/core/test/current-terminal-prompt.test.ts'] } })
