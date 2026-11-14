import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'native-payload-actual-source-mutation', enforce: 'pre',
  resolveId(specifier) { if (specifier === '@agentmux/providers/cursor/provider') return resolve(root, 'packages/providers/src/cursor/provider.ts') },
  transform(code, id) {
  const mutation = process.env.AGENTMUX_CURSOR_PAYLOAD_MUTATION
  if (!mutation) return
  const anchors: Record<string, [string, string, string]> = {
    'legacy-single-phase': ['packages/providers/src/cursor/provider.ts', "? { kind: 'payload-then-submit' as const, payload, payloadText, submit: '\\u001b[13u', minimumSubmitDelayMs: 35 }", "? { kind: 'single-phase', data: `${payload}\\u001b[13u` }"],
    'drop-original-env': ['packages/core/src/client.ts', 'providerExecutionEnvironment: async session => (await this.sessionExecutorOptions<AgentSessionHistoryPageOptions>(this.requireAgentSession(session.agentSessionId), {}, session.agentSessionId)).env,', 'providerExecutionEnvironment: async () => undefined,'],
    'unqualified-writer': ['packages/core/src/providers/cursor-payload-protocol.ts', "createHash('sha256').update(data).digest('hex') !== hash", 'false'],
    'drop-manual-terminal-plan': ['packages/core/src/client.ts', "admissionIntent.kind === 'manual-actor' ? { currentTerminal: true } :", "admissionIntent.kind === 'manual-actor' ? undefined :"],
    'client-ignores-payload-plan': ['packages/client-ui/src/lib/input-receipt-projection.ts', '? [plan.payload, plan.payloadText, plan.submit, plan.minimumSubmitDelayMs] : undefined', '? undefined : undefined'],
    'client-ignores-payload-source': ['packages/client-ui/src/lib/input-receipt-projection.ts', 'phases.payloadConsumption?.sourceId, phases.payloadConsumption?.baselineId', 'undefined, undefined'],
    'drop-owned-run-invocation': ['packages/core/src/client.ts', 'this.kernel.originalInvocation(run)', '{ program: run.program, args: run.args }'],
    'skip-native-consumption': ['packages/core/src/prompt-submission.ts', 'await this.confirmPayloadConsumption(session, submissionId, submission, plan, nativeContext, renderSignal)', 'await Promise.resolve()'],
    'old-content-qualifies': ['packages/core/src/providers/cursor-payload-consumption.ts', 'id > Number(original.baselineId) && body === text', 'body === text'],
    'wrong-source-qualifies': ['packages/core/src/providers/cursor-payload-consumption.ts', 'path, handle.sessionId, String(db.dev), String(db.ino), String(directory.dev), String(directory.ino)', "path, handle.sessionId, 'unqualified', 'unqualified', String(directory.dev), String(directory.ino)"],
    'skip-native-interval': ['packages/providers/src/cursor/provider.ts', 'minimumSubmitDelayMs: 35', 'minimumSubmitDelayMs: 0']
  }
  const anchor = anchors[mutation]; if (!anchor) throw new Error('Unknown native payload source mutation')
  const path = relative(root, id.split('?')[0]!)
  if (path !== anchor[0]) return
  if (code.split(anchor[1]).length !== 2) throw new Error('Native payload mutation needs exactly one production anchor')
  const changed = code.replace(anchor[1], anchor[2])
  if (process.env.AGENTMUX_CURSOR_PAYLOAD_LOADED) appendFileSync(process.env.AGENTMUX_CURSOR_PAYLOAD_LOADED,
    JSON.stringify({ mutation, path, originalSHA256: createHash('sha256').update(code).digest('hex'), loadedSHA256: createHash('sha256').update(changed).digest('hex') }) + '\n')
  return { code: changed, map: null }
} }], test: { ...source.test, environment: 'node', fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 20000,
  include: ['packages/core/test/cursor-payload-consumption.test.ts', 'packages/core/test/cursor-payload-protocol.test.ts', 'packages/core/test/providers/cursor.test.ts', 'packages/core/test/current-terminal-prompt.test.ts', 'packages/core/test/hosted-value-roundtrip.test.ts', 'packages/core/test/provider-render-plan-coupling.test.ts', 'packages/client-ui/test/input-receipt-identity.test.tsx'] } })
