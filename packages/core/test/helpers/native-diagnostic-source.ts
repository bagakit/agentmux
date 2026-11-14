import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../..')
const mutants: Record<string, [string, string, string]> = {
  'drain-native-stderr': ['packages/core/src/providers/codex-managed-run.ts', 'server.stderr?.pipe(preparationDiagnostics).pipe(process.stderr, { end: false })', 'server.stderr?.pipe(preparationDiagnostics).resume()'],
  'discard-native-cause': ['packages/core/src/providers/codex-managed-run.ts', 'formatCodexManagedDiagnostic(diagnostic, diagnosticCredentials())', 'diagnostic.message'],
  'expose-native-credentials': ['packages/providers/src/codex/managed-diagnostics.ts', 'const secrets = credentialBytes(credentials), retained', 'const secrets: Buffer[] = [], retained'],
  'mix-background-server-logs': ['packages/core/src/providers/codex-managed-run.ts', 'server.stderr?.unpipe(preparationDiagnostics); preparationDiagnostics.end(); server.stderr?.resume()', '/* Keep forwarding background native output. */']
}

/** Loaded by both Vitest and the actual managed child compilation. */
export function nativeDiagnosticSource(code: string, filename: string): string {
  const path = relative(root, filename.split('?')[0]!)
  if (!/^packages\/(?:core|providers)\/src\/.+\.ts$/u.test(path)) return code
  const original = code, mutation = process.env.AGENTMUX_DIAGNOSTIC_MUTATION, change = mutation ? mutants[mutation] : undefined
  if (mutation && !change) throw new Error('Unknown native diagnostic mutation')
  if (change && path === change[0]) {
    if (code.split(change[1]).length !== 2) throw new Error('Native diagnostic mutation anchor must be unique: ' + mutation)
    code = code.replace(change[1], change[2])
  }
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  if (process.env.AGENTMUX_DIAGNOSTIC_LOADED) appendFileSync(process.env.AGENTMUX_DIAGNOSTIC_LOADED,
    JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original !== code ? { mutation } : {}) }) + '\n')
  return code
}
