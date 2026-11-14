import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import source from '../../../apps/desktop/test/vitest.mote-context.config.mts'
const mutations: Record<string, [string, string, string]> = {
  'recursive-native-dispatch': ['packages/core/src/public-rpc-service.ts', "if (method === 'skill.ls' || isAgentProgressMethod(method) || method === 'file.upload' || method === 'file.upload.inspect' || (SPACE_MEMBER_NATIVE_MAIL_CALLS as readonly string[]).includes(method)) return await this.callOwnedBusiness", "if (method === 'skill.ls' || isAgentProgressMethod(method) || method === 'file.upload' || method === 'file.upload.inspect' || (SPACE_MEMBER_NATIVE_MAIL_CALLS as readonly string[]).includes(method)) return await this.call"],
  'late-native-authority': ['packages/core/src/space-member-runtime.ts', 'if (!isSpaceMemberNativeWrite(method)) await assertCurrent()', 'if (false) await assertCurrent()'],
  'native-target-check': ['packages/core/src/space-member-codec.ts', "if (call.method === 'skill.ls') {\n    const p = rpcRecord(call.params, ['hostId', 'agentSessionId'])\n    if (p.hostId !== 'local' || p.agentSessionId !== target.agentSessionId) mismatch()", "if (call.method === 'skill.ls') {\n    const p = rpcRecord(call.params, ['hostId', 'agentSessionId'])\n    if (false) mismatch()"],
  'conversation-progress-write': ['packages/core/src/space-member-codec.ts', "if (call.method !== 'agent.progress.list' && (!('kind' in target) || target.kind !== 'session'))", 'if (false)'],
  'session-progress-run-gate': ['packages/core/src/space-member-codec.ts', 'if (isAgentProgressMethod(call.method)) {', "if (isAgentProgressMethod(call.method)) { if (!('expectedRun' in target)) throw new AgentMuxError('An optional Run observation incorrectly gates a durable Session arrangement', 'STALE_AGENT_SESSION_BINDING')"],
  'inspect-current-run-gate': ['packages/core/src/space-member-runtime.ts', 'if ((SPACE_MEMBER_NATIVE_CALLS as readonly string[]).includes(input.call.method)) {', "if ((SPACE_MEMBER_NATIVE_CALLS as readonly string[]).includes(input.call.method) && input.call.method !== 'file.upload.inspect') {"],
  'forward-source-fence': ['packages/core/src/space-member-runtime.ts', "return { ...author, ...(fence ? { runtimeFence: fence as import('./hosted-client-contract.js').AgentMuxRuntimeFence } : {}) }", 'return current'],
}
const mutation = process.env.AGENTMUX_NATIVE_TOOLS_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known original Native tools mutation')
export default defineConfig({ resolve: source.resolve, plugins: [{ name: 'actual-native-owner-mutation', enforce: 'pre', transform(original, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (!Object.values(mutations).some(([target]) => target === path)) return
  let code = original
  if (mutation) { const [target, from, to] = mutations[mutation]!; if (path === target) { assert.equal(code.split(from).length - 1, 1, 'One production mutation anchor'); code = code.replace(from, to) } }
  if (process.env.AGENTMUX_NATIVE_TOOLS_LOADED) appendFileSync(process.env.AGENTMUX_NATIVE_TOOLS_LOADED, JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation: code !== original ? mutation : null }) + '\n')
  if (code !== original) return { code, map: null }
} }], test: { include: ['packages/core/test/space-member-native-tools.test.ts', 'packages/core/test/space-member-native-progress.test.ts', 'packages/core/test/space-member-native-image.test.ts'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30000 } })
