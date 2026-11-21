import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../..')
const mutants: Record<string, [string, string, string]> = {
  'omit-frontend-cwd': ['packages/core/src/providers/codex-managed-run.ts', "'--cd', workspacePath, ...args", '...args'],
  'ignore-backend-signal-exit': ['packages/core/src/providers/codex-managed-run.ts', "resolve({ code: code ?? (signal ? 1 : 0) })", "if (code !== null) resolve({ code })"],
  'kill-backend-on-detach': ['packages/core/src/providers/codex-managed-run.ts', '      tui = undefined', "      tui = undefined; server.kill('SIGTERM')"],
  'replay-initial-prompt': ['packages/core/src/providers/codex-managed-run.ts', "['resume', request.nativeSessionId, ...flags]", 'plan.args'],
  'forget-frontend-generation': ['packages/core/src/providers/codex-managed-run.ts', "frontend.frontendId === expectedId", "true"],
  'skip-bypass-create': ['packages/providers/src/codex/input-protocol.ts', 'if (arg === BYPASS_PERMISSIONS) {\n        if (bypass) return null', 'if (arg === BYPASS_PERMISSIONS) {\n        return null'],
  'keep-bypass-token': ['packages/providers/src/codex/input-protocol.ts', "resume.sandbox = 'danger-full-access'; resume.approvalPolicy = 'never'", "resume.sandbox = 'danger-full-access'; resume.approvalPolicy = 'never'; serverConfig.push(arg)"],
  'wrong-bypass-policy': ['packages/providers/src/codex/input-protocol.ts', "resume.sandbox = 'danger-full-access'; resume.approvalPolicy = 'never'", "resume.sandbox = 'read-only'; resume.approvalPolicy = 'on-request'"],
  'create-only': ['packages/core/src/providers/codex-native-input.ts', "context.kind === 'fork'", "context.kind !== 'create'"],
  'keep-policy-argv': ['packages/providers/src/codex/input-protocol.ts', "resume.sandbox = value as NonNullable<CodexManagedThreadConfiguration['sandbox']>", "resume.sandbox = value as NonNullable<CodexManagedThreadConfiguration['sandbox']>; serverConfig.push(arg, value)"],
  'forget-resume-policy': ['packages/core/src/providers/codex-managed-run.ts', '{ ...expected, excludeTurns: true }', '{ threadId: expected.threadId, excludeTurns: true }'],
  'forget-resume-hook-flag': ['packages/core/src/providers/codex-managed-run.ts', "...(plan.frontendArgs.includes('--dangerously-bypass-hook-trust') ? { config: { bypass_hook_trust: true } } : {})", ''],
  'accept-wrong-policy': ['packages/core/src/providers/codex-managed-run.ts', 'expected.sandbox !== undefined && resumed.sandbox?.type !== sandboxType ||', ''],
  'forget-native-target': ['packages/core/src/providers/codex-managed-run.ts', 'resumed?.thread?.id !== expected.threadId', 'false'],
  'skip-resume-before-tui': ['packages/core/src/providers/codex-managed-run.ts', 'if (plan.resume) {', 'if (false) {']
}

/** Both the in-process qualifier and isolated child compile consume this exact source mutation. */
export function nativeResumeSource(code: string, filename: string): string {
  const path = relative(root, filename.split('?')[0]!)
  if ((!path.startsWith('packages/core/src/') && !path.startsWith('packages/providers/src/')) || !path.endsWith('.ts')) return code
  const original = code, mutation = process.env.AGENTMUX_NATIVE_RESUME_MUTATION
  const change = mutation ? mutants[mutation] : undefined
  if (mutation && !change) throw new Error('Unknown native resume mutation')
  if (change && path === change[0]) {
    if (code.split(change[1]).length !== 2) throw new Error('Native resume mutation anchor must be unique: ' + mutation)
    code = code.replace(change[1], change[2])
  }
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  if (process.env.AGENTMUX_NATIVE_RESUME_LOADED) appendFileSync(process.env.AGENTMUX_NATIVE_RESUME_LOADED,
    JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original !== code ? { mutation } : {}) }) + '\n')
  return code
}
