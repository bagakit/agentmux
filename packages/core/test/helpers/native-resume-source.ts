import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../..')
const mutants: Record<string, [string, string, string]> = {
  'ignore-backend-signal-exit': ['codex-managed-run.ts', "resolve({ code: code ?? (signal ? 1 : 0) })", "if (code !== null) resolve({ code })"],
  'kill-backend-on-detach': ['codex-managed-run.ts', '      tui = undefined', "      tui = undefined; server.kill('SIGTERM')"],
  'replay-initial-prompt': ['codex-managed-run.ts', "['resume', request.nativeSessionId, ...flags]", 'plan.args'],
  'forget-frontend-generation': ['codex-managed-run.ts', "frontend.frontendId === expectedId", "true"],
  'skip-bypass-create': ['codex-native-input.ts', 'if (arg === BYPASS_PERMISSIONS) {\n      if (bypass) return null', 'if (arg === BYPASS_PERMISSIONS) {\n      return null'],
  'keep-bypass-token': ['codex-native-input.ts', "resume.approvalPolicy = 'never'; removed.add(i)", "resume.approvalPolicy = 'never'"],
  'wrong-bypass-policy': ['codex-native-input.ts', "resume.sandbox = 'danger-full-access'; resume.approvalPolicy = 'never'", "resume.sandbox = 'read-only'; resume.approvalPolicy = 'on-request'"],
  'create-only': ['codex-native-input.ts', "context.kind === 'fork'", "context.kind !== 'create'"],
  'keep-policy-argv': ['codex-native-input.ts', 'args.filter((_, i) => !removed.has(i))', '[...args]'],
  'forget-resume-policy': ['codex-managed-run.ts', '{ ...expected, excludeTurns: true }', '{ threadId: expected.threadId, excludeTurns: true }'],
  'accept-wrong-policy': ['codex-managed-run.ts', 'expected.sandbox !== undefined && resumed.sandbox?.type !== sandboxType ||', ''],
  'forget-native-target': ['codex-managed-run.ts', 'resumed?.thread?.id !== expected.threadId', 'false'],
  'skip-resume-before-tui': ['codex-managed-run.ts', 'if (plan.resume) {', 'if (false) {']
}

/** Both the in-process qualifier and isolated child compile consume this exact source mutation. */
export function nativeResumeSource(code: string, filename: string): string {
  const path = relative(root, filename.split('?')[0]!)
  if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return code
  const original = code, mutation = process.env.AGENTMUX_NATIVE_RESUME_MUTATION
  const change = mutation ? mutants[mutation] : undefined
  if (mutation && !change) throw new Error('Unknown native resume mutation')
  if (change && path === 'packages/core/src/providers/' + change[0]) {
    if (code.split(change[1]).length !== 2) throw new Error('Native resume mutation anchor must be unique: ' + mutation)
    code = code.replace(change[1], change[2])
  }
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  if (process.env.AGENTMUX_NATIVE_RESUME_LOADED) appendFileSync(process.env.AGENTMUX_NATIVE_RESUME_LOADED,
    JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original !== code ? { mutation } : {}) }) + '\n')
  return code
}
