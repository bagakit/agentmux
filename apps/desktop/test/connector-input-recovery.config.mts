import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.input-mailbox-consumers.config.mts'
import { createRequire } from 'node:module'
const { candidateResolve } = createRequire(import.meta.url)('../scripts/candidate-package-resolve.mjs')
const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.CONNECTOR_INPUT_MUTANT
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/connector-input-recovery'), plugins: [...base.plugins!, {
  name: 'original-input-recovery-loaded', enforce: 'pre', resolveId(id) {
    if (id === '@agentmux/host' || id.startsWith('@agentmux/host/')) return candidateResolve(root, id, { source: true })
  }, transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/(?:desktop|host)|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    let code = source
    if (mutant && path === 'apps/desktop/src/renderer/src/components/OriginalInputWaitingControl.tsx') {
      const before = 'const result = await api.sessions.rejoinInputWaiting(control, ref)'
      if (mutant !== 'disconnect-rejoin' || source.split(before).length !== 2) throw Error('Unknown or non-unique original input mutation')
      code = source.replace(before, 'const result = receipt')
    }
    if (process.env.CONNECTOR_INPUT_LOADED) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.CONNECTOR_INPUT_LOADED, JSON.stringify({ path, originalSHA256: sha(source), loadedSHA256: sha(code), ...(code === source ? {} : { mutant }) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/connector-input-recovery.test.tsx'], ...(mutant ? { testNamePattern: 'opens the original saved connector input' } : {}) } })
