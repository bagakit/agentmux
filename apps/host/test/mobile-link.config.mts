import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
const coreRoot = process.env.AGENTMUX_TEST_CORE_ROOT ?? resolve(root, 'packages/core')
const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const aliases = Object.entries(exports).flatMap(([key, value]) => {
  const entry = (value as { import?: string }).import
  return entry ? [{ find: key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2), replacement: process.env.AGENTMUX_TEST_CORE_ROOT ? resolve(coreRoot, entry) : resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts')) }] : []
}).sort((a, b) => b.find.length - a.find.length)
export default defineConfig({ plugins: [{ name: 'mobile-link-original-host-mutation', enforce: 'pre', transform(source, id) {
  const report = process.env.AGENTMUX_CURRENT_PHONE_LINK_LOADED, file = id.split('?')[0]!
  if (process.env.AGENTMUX_MOBILE_LINK_MUTANT === 'frozen-interfaces' && file === resolve(root, 'apps/host/src/host.ts')) {
    const before = 'offerUrl = async address => {\n          const interfaces = networkInterfaces()', after = 'const interfaces = networkInterfaces()\n        offerUrl = async address => {'
    if (source.split(before).length !== 2) throw Error('One actual interface freeze anchor required')
    source = source.replace(before, after)
  }
  if (report && [resolve(root, 'apps/host/src/host.ts'), resolve(root, 'packages/core/src/device-administration.ts'), resolve(root, 'apps/host/test/mobile-link.test.ts')].includes(file)) {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = { file: file.slice(root.length + 1), originalSHA256: sha(readFileSync(file, 'utf8')), loadedSHA256: sha(source),
      mutation: process.env.AGENTMUX_MOBILE_LINK_MUTANT === 'frozen-interfaces' && file === resolve(root, 'apps/host/src/host.ts') ? 'frozen-interfaces' : null }
    source = `import {appendFileSync as __currentPhoneLoaded} from 'node:fs';__currentPhoneLoaded(${JSON.stringify(report)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
  if (process.env.AGENTMUX_MOBILE_LINK_MUTANT !== 'connected-gate') return source
  if (process.env.AGENTMUX_MOBILE_LINK_MUTANT !== 'connected-gate' || id.split('?')[0] !== resolve(root, 'apps/host/src/host.ts')) return null
  const before = 'if (!offerUrl) throw new AgentMuxError(mobileState.message', after = "if (!offerUrl || mobileState.state !== 'connected') throw new AgentMuxError(mobileState.message"
  if (source.split(before).length !== 2) throw new Error('Original Host mutation did not match exactly once')
  appendFileSync(process.env.AGENTMUX_MOBILE_LINK_HITS!, 'connected-gate\n')
  return source.replace(before, after)
} }], resolve: { alias: aliases }, test: { include: ['apps/host/test/mobile-link.test.ts'],
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000 } })
