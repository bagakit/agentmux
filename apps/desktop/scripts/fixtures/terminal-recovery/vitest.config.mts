import base from '../../../../../packages/core/test/hook-postcommit-observation.vitest.config.mts'
import { resolve, relative } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../../../..')
const host = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8'))
const hostAliases = Object.entries(host.exports).map(([key, value]) => ({ find: '@agentmux/host' + key.slice(1), replacement: resolve(root, 'apps/host', (value as { import: string }).import.replace('./dist/', './src/').replace(/\.js$/u, '.ts')) }))
const ui = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8'))
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const uiAliases = Object.entries(ui.exports).map(([key, value]) => {
  const target = typeof value === 'string' ? value : (value as { browser?: string; import: string }).browser ?? (value as { import: string }).import
  return { find: new RegExp('^' + ('@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))).split('*').map(escape).join('(.*)') + '$'), replacement: resolve(root, 'packages/client-ui', target.replace('*', '$1')) }
}).sort((a, b) => b.find.source.length - a.find.source.length)
const changes: Record<string, [string, string, string]> = {
  'replay-unknown': ['packages/core/src/terminal-recovery-owner.ts', "if (intent.phase !== 'not_applied' && input.action !== 'continue') return this.result(intent)", "if (intent.phase !== 'not_applied' && input.action !== 'continue') { intent = (await update(attempt, current => { current.phase = 'prepared'; return true })).current; }"],
  'forget-durable-intent': ['packages/core/src/terminal-recovery-owner.ts', "current.phase = 'dispatched'; return true", "current.phase = 'prepared'; return true"],
  'follow-replacement-attempt': ['packages/core/src/terminal-recovery-owner.ts', 'current.prepared.createOperationId === attempt.createOperationId && change(current)', 'change(current)'],
  'follow-retirement-successor': ['packages/core/src/terminal-recovery-owner.ts', 'if (!admitted.changed) return this.result(intent)\n        const retirement = await this.port.retire(attempt, retirementRuntime!)', 'if (!admitted.changed) { /* Mutant follows the successor after losing admission. */ }\n        const retirement = await this.port.retire(intent.prepared, runtime)'],
  'resurrect-retired-attempt': ['packages/core/src/terminal-recovery-owner.ts', "if (!['dispatched', 'retained'].includes(current.phase)) return false", '/* Mutant accepts a pre-fence retained reply. */'],
  'ignore-original-cwd': ['packages/core/src/client.ts', 'run.workspacePath !== request.workspacePath', 'false'],
  'desktop-new-terminal': ['apps/desktop/src/main/runtime-controller.ts', 'await client.recoverTerminal({', 'await client.createTerminal({'],
  'stop-late-view': ['apps/desktop/src/renderer/src/store.ts', '// A late view result ends only observation; it never authorizes Stop.', '// A late view result ends only observation; it never authorizes Stop.\n      await api.sessions.stop(session.control)'],
  'unchecked-hosted-result': ['packages/core/src/hosted-client.ts', "if (method === 'recoverTerminal') return parseTerminalRecoveryResult(decoded, parseTerminalRecoveryInput(wireArgs[0]))", "if (method === 'recoverTerminal') return decoded"],
  'automatic-continuation': ['apps/desktop/src/renderer/src/components/SessionPane.tsx', "void recover('startup')", 'void recover()']
}
const mutation = process.env.AGENTMUX_TERMINAL_RECOVERY_MUTATION
if (mutation && !changes[mutation]) throw Error('Unknown terminal recovery mutation')
export default { ...base, root, resolve: { alias: [{ find: '@agentmux/identity/runtime-source', replacement: resolve(root, 'packages/identity/dist/runtime-source.js') }, ...hostAliases, ...uiAliases, ...base.resolve.alias] }, plugins: [{ name: 'terminal-recovery-candidate', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!/^(packages|apps)\//u.test(path)) return
    let code = source
    if (mutation && path === changes[mutation]![0]) {
      const [, from, to] = changes[mutation]!
      if (source.split(from).length !== 2) throw Error('Terminal recovery mutation must match once')
      code = source.replace(from, to)
    }
    if (process.env.AGENTMUX_TERMINAL_RECOVERY_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_RECOVERY_LOADED,
      JSON.stringify({ path, sha256: createHash('sha256').update(code).digest('hex'), originalSHA256: createHash('sha256').update(source).digest('hex'), ...(code !== source ? { mutation } : {}) }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['packages/core/test/terminal-recovery.test.ts', 'apps/desktop/test/terminal-recovery-consumer.test.ts', 'apps/desktop/test/session-recovery-lost-receipt.test.tsx', 'apps/desktop/test/terminal-recovery-native-view.test.tsx'], passWithNoTests: false, testTimeout: 20000 }
}
