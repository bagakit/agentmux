import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'
const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.AGENTMUX_HEADER_STATUS_MUTANT
const mutations = {
  'resume-retarget': { path: 'apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx', before: 'resumeBinding={opened?.identity === identity ? undefined : props.resumeBinding}', after: 'resumeBinding={props.resumeBinding}' },
  'close-reads': { path: 'apps/desktop/src/renderer/src/lib/use-connector-group-diagnosis.ts', before: 'const readKey = JSON.stringify([bindings.map(groupTarget), hostingTarget, version, request, syncEnabled])', after: 'const readKey = JSON.stringify([identity, version, request, syncEnabled])' },

  'access-as-source': { path: 'apps/desktop/src/renderer/src/lib/connector-group-status.ts', before: "const accessUnconfirmed = out?.observation?.reason === 'access-unconfirmed'", after: 'const accessUnconfirmed = false' },
  'policy-only': { path: 'apps/desktop/src/renderer/src/lib/connector-group-status.ts', before: 'const report = snapshot?.report', after: 'const report = snapshot?.report ? { ...snapshot.report, outgoing: { value: null, issue: null }, incoming: { value: null, issue: null } } : undefined' },
  'accept-late-source': { path: 'apps/desktop/src/renderer/src/lib/use-connector-group-diagnosis.ts', before: 'if (!accepts()) return', after: 'if (false) return' }
} as const
if (mutant && !(mutant in mutations)) throw Error('Unknown header status mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/header-status'),
  resolve: { alias: [{ find: /^@agentmux\/connectors$/, replacement: resolve(root, 'packages/connectors/src/index.ts') }] },
  plugins: [{ name: 'loaded-header-status', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!), before = code
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/connectors/src/')) return
    const selected = mutant ? mutations[mutant as keyof typeof mutations] : null
    if (selected?.path === path) { if (code.split(selected.before).length !== 2) throw Error('Header status mutation anchor changed'); code = code.replace(selected.before, selected.after) }
    if (process.env.AGENTMUX_HEADER_STATUS_LOADED && /\.tsx?$/.test(path)) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.AGENTMUX_HEADER_STATUS_LOADED, JSON.stringify({ path, originalSHA256: sha(before), loadedSHA256: sha(code), mutation: code === before ? null : mutant }) + '\n')
    }
    return code === before ? undefined : { code, map: null }
  } }], test: { ...original.test, fileParallelism: false, passWithNoTests: false, include: ['apps/desktop/test/connector-header-status.test.tsx'] }
})
