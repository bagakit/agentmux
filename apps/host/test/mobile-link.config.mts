import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
const root = resolve(import.meta.dirname, '../../..')
const coreRoot = process.env.AGENTMUX_TEST_CORE_ROOT ?? resolve(root, 'packages/core')
const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const aliases = Object.entries(exports).flatMap(([key, value]) => {
  const entry = (value as { import?: string }).import
  return entry ? [{ find: key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2), replacement: resolve(coreRoot, entry) }] : []
}).sort((a, b) => b.find.length - a.find.length)
export default defineConfig({ plugins: [{ name: 'mobile-link-original-host-mutation', enforce: 'pre', transform(source, id) {
  if (process.env.AGENTMUX_MOBILE_LINK_MUTANT !== 'connected-gate' || id.split('?')[0] !== resolve(root, 'apps/host/src/host.ts')) return null
  const before = 'if (!offerUrl) throw new AgentMuxError(mobileState.message', after = "if (!offerUrl || mobileState.state !== 'connected') throw new AgentMuxError(mobileState.message"
  if (source.split(before).length !== 2) throw new Error('Original Host mutation did not match exactly once')
  appendFileSync(process.env.AGENTMUX_MOBILE_LINK_HITS!, 'connected-gate\n')
  return source.replace(before, after)
} }], resolve: { alias: aliases }, test: { include: ['apps/host/test/mobile-link.test.ts'],
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000 } })
