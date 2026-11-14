import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './relay-carrier.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const trace = process.env.HOSTED_EXACT_LOADED
const leaf = 'packages/core/src/hosted-client.ts'
export const variants = {
  'wait-catalog': { file: 'packages/core/src/relay-hosted.ts', pattern: 'returns exact control while',
    changes: [['waitForReady: options.waitForReady', 'waitForReady: true']] },
  'revoke-control': { file: leaf, pattern: 'failed encrypted directory',
    changes: [["sessionObservationState = state; sessionObservationIssue = diagnostic", "sessionObservationState = state; sessionObservationIssue = diagnostic; if (state === 'unavailable') emit({ type: 'connection-state', state: 'lost', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: Date.now() } })"]] },
  'false-empty': { file: leaf, pattern: 'returns exact control while',
    changes: [['agentSessions: () => structuredClone(requireBootstrap().sessions)', 'agentSessions: () => structuredClone(bootstrap?.sessions ?? [])']] },
  'late-owner': { file: leaf, pattern: 'released old reply',
    changes: [["if (disposed || controller.signal.aborted || epoch !== controlEpoch) throw", 'if (disposed) throw'],
      ['if (controlOwner === previous) acceptOwner(discovered)', 'acceptOwner(discovered)']] },
  'old-catalog-body': { file: leaf, pattern: 'old initial Session body',
    changes: [[' || admittedControlEpoch !== undefined && admittedControlEpoch !== controlEpoch', '']] }
} as const
const mutation = process.env.HOSTED_EXACT_MUTATION as keyof typeof variants | undefined
if (mutation && !Object.hasOwn(variants, mutation)) throw Error('Unknown exact Hosted mutation')
const owners = new Set(['packages/core/src/hosted-client.ts', 'packages/core/src/relay-hosted.ts',
  'packages/core/src/space-session-owner.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/client-event-publisher.ts', 'packages/core/src/hosted.ts',
  'packages/core/test/hosted-exact-first-read.test.ts', 'packages/core/test/helpers/relay-carrier-owner.ts'])
export default defineConfig({ ...base,
  cacheDir: resolve(root, '.tmp/hosted-exact-first-read/cache'),
  plugins: [...base.plugins!, { name: 'evaluated-hosted-exact-owner', enforce: 'pre', transform(code, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file) || !trace) return
    const original = code, selected = mutation ? variants[mutation] : undefined
    if (selected?.file === file) for (const [from, to] of selected.changes) {
      if (code.split(from).length !== 2) throw Error('Exact Hosted mutation must match once: ' + mutation)
      code = code.replace(from, to)
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = { file, originalSHA256: hash(original), loadedSHA256: hash(code), mutation: code === original ? null : mutation }
    appendFileSync(trace, JSON.stringify({ phase: 'transformed', ...row }) + '\n')
    return code + `\nimport {appendFileSync as __exactLoaded} from 'node:fs'; __exactLoaded(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...row }) + '\n')});\n`
  } }],
  test: { ...base.test, include: process.env.HOSTED_EXACT_RELATED ? [
      'packages/core/test/hosted-control-availability.test.ts', 'packages/core/test/hosted-metadata-opening.test.ts',
      'packages/core/test/hosted-session-scope.test.ts', 'packages/core/test/space-sessions.test.ts',
      'packages/core/test/relay-host-identity.test.ts'
    ] : ['packages/core/test/hosted-exact-first-read.test.ts'],
    ...(mutation ? { testNamePattern: variants[mutation].pattern } : {}),
    environmentMatchGlobs: [], passWithNoTests: false, testTimeout: 20_000, hookTimeout: 20_000 }
})
