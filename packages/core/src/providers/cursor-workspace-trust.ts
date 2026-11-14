import { randomUUID } from 'node:crypto'
import { link, mkdir, open, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AgentWorkspaceTrustContext, AgentWorkspaceTrustReceipt } from '../agent-provider.js'
import type { ProviderExecutionEnvironment } from './execution-environment.js'
import { cursorWorkspaceSlug } from '@agentmux/providers/cursor/native-history'
import { cursorDataRoot } from './cursor-history.js'

/** Cursor's native marker lookup, scoped to its actual physical cwd and execution environment. */
export function cursorTrustMarkerPath(workspacePath: string, env?: ProviderExecutionEnvironment): string {
  return join(cursorDataRoot(workspacePath, env), 'projects', cursorWorkspaceSlug(workspacePath), '.workspace-trusted')
}

/** Trust belongs to the exact Host-owned home seam, independently of optional Hook installation. */
export async function prepareCursorOwnedWorkspaceTrust(context: AgentWorkspaceTrustContext): Promise<AgentWorkspaceTrustReceipt> {
  let trustKey: string | null = null, configPath: string | null = null
  try {
    context.signal?.throwIfAborted()
    trustKey = await realpath(resolve(context.workspacePath))
    if (trustKey !== await realpath(resolve(context.ownedRoot))) return {
      status: 'not-applicable', trustKey, configPath, code: 'CURSOR_TRUST_HOME_MISMATCH' }
    configPath = cursorTrustMarkerPath(trustKey, context.env)
    const present = async () => {
      try { return (await stat(configPath!)).isFile() }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    }
    if (await present()) return { status: 'already-trusted', trustKey, configPath, code: 'CURSOR_TRUST_PRESENT' }
    const directory = dirname(configPath)
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, `.agentmux-trust-${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        // Optional trustMethod is omitted: this was neither Cursor's CLI flag nor inherited trust.
        await file.writeFile(JSON.stringify({ trustedAt: new Date().toISOString(), workspacePath: trustKey }) + '\n')
        await file.sync()
      } finally { await file.close() }
      context.signal?.throwIfAborted()
      try { await link(temporary, configPath) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await present()) throw error }
      const dir = await open(directory, 'r')
      try { await dir.sync() } finally { await dir.close() }
    } finally { await unlink(temporary).catch(() => undefined) }
    return { status: 'trusted', trustKey, configPath, code: 'CURSOR_TRUST_RECORDED' }
  } catch (error) {
    if (context.signal?.aborted) throw error
    return { status: 'unconfirmed', trustKey, configPath, code: 'CURSOR_TRUST_UNCONFIRMED',
      issue: error instanceof Error ? error.message : String(error) }
  }
}
