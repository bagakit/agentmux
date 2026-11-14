import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const mutations: Record<string, [string, string, string]> = {
  'recursive-native-dispatch': ['packages/core/src/public-rpc-service.ts', "if (method === 'skill.ls') return await this.callOwnedBusiness(method, params as AgentMuxRpcParams<typeof method>, original)", "if (method === 'skill.ls') return await this.call(method, params as AgentMuxRpcParams<typeof method>, original)"],
  'late-native-authority': ['packages/core/src/space-member-runtime.ts', 'const result = await originalPort.call(method, params, { ...callContext, runtimeFence })\n      await assertCurrent()', 'const result = await originalPort.call(method, params, { ...callContext, runtimeFence })'],
  'native-target-check': ['packages/core/src/space-member-codec.ts', "if (call.method === 'skill.ls') {\n    const p = rpcRecord(call.params, ['hostId', 'agentSessionId'])\n    if (p.hostId !== 'local' || p.agentSessionId !== target.agentSessionId) mismatch()", "if (call.method === 'skill.ls') {\n    const p = rpcRecord(call.params, ['hostId', 'agentSessionId'])\n    if (false) mismatch()"],
}
const mutation = process.env.AGENTMUX_NATIVE_TOOLS_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known original Native tools mutation')
export default defineConfig({ plugins: [{ name: 'actual-native-owner-mutation', enforce: 'pre', transform(original, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (!Object.values(mutations).some(([target]) => target === path)) return
  let code = original
  if (mutation) { const [target, from, to] = mutations[mutation]!; if (path === target) { assert.equal(code.split(from).length - 1, 1, 'One production mutation anchor'); code = code.replace(from, to) } }
  if (process.env.AGENTMUX_NATIVE_TOOLS_LOADED) appendFileSync(process.env.AGENTMUX_NATIVE_TOOLS_LOADED, JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation: code !== original ? mutation : null }) + '\n')
  if (code !== original) return { code, map: null }
} }], test: { include: ['packages/core/test/space-member-native-tools.test.ts'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30000 } })
