import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { CatalogCandidate, CatalogContext, CatalogIssue, NativeCatalogServices, RecoveryContext, ResumeContext } from '../native-catalog-services.js'

export function createClaudeNativeCatalog({ AgentMuxError, normalizeNativeSessionId, assertNativeCatalogPath,
  nativeCatalogFiles, nativeCatalogIssue, readNativeCatalogFile }: NativeCatalogServices) {
  function root(context: CatalogContext): string {
    const configured = context.env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
    return join(configured ? resolve(configured) : join(context.env.HOME ?? homedir(), '.claude'), 'projects')
  }

  async function candidate(path: string, context: CatalogContext): Promise<CatalogCandidate<'claude'> | null> {
    if (path.split(/[\\/]/u).includes('subagents')) return null
    path = await realpath(path)
    const metadata = await readNativeCatalogFile('claude', path, context, async reader => {
      for (let next = await reader.readNext(); next; next = await reader.readNext()) {
        const row = next.value
        if (row.type === 'user' || row.type === 'assistant') return row
      }
      return null
    })
    const row = metadata.value, id = normalizeNativeSessionId(row?.sessionId), cwd = row?.cwd
    if (row?.isSidechain === true) return null
    if (!row || !id || row.isSidechain !== false || typeof cwd !== 'string' || !isAbsolute(cwd) || basename(path) !== `${id}.jsonl`) {
      throw new AgentMuxError('Claude conversation metadata has no exact main identity and execution directory.', 'AGENT_NATIVE_SESSION_METADATA_INVALID')
    }
    if (context.workspacePath !== undefined && cwd !== context.workspacePath) return null
    const createdAt = Date.parse(String(row.timestamp))
    return { source: { nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: id, transcriptPath: path }, workspacePath: cwd, revision: metadata.revision },
      ...(Number.isFinite(createdAt) ? { createdAt } : {}), updatedAt: metadata.updatedAt }
  }

  async function listClaudeNativeSessions(context: CatalogContext) {
    const catalog = { providerId: 'claude' as const, availability: 'available' as const, sessions: [] as CatalogCandidate<'claude'>[], issues: [] as CatalogIssue[] }
    for await (const path of nativeCatalogFiles(root(context), context, catalog.issues, name => name.endsWith('.jsonl'))) {
      try { const entry = await candidate(path, context); if (entry) catalog.sessions.push(entry) }
      catch (error) { context.signal.throwIfAborted(); catalog.issues.push(nativeCatalogIssue(error)) }
    }
    catalog.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return catalog
  }

  async function assertClaudeNativeResumeSource(context: ResumeContext): Promise<void> {
    const source = context.source, path = source.nativeHandle.transcriptPath
    if (source.nativeHandle.providerId !== 'claude' || !path) throw new AgentMuxError('This exact source does not belong to Claude.', 'INVALID_AGENT_NATIVE_RESUME_SOURCE')
    await assertNativeCatalogPath(path, [root(context)])
    const actual = await candidate(path, { env: context.env, signal: context.signal })
    if (!actual || actual.source.nativeHandle.sessionId !== source.nativeHandle.sessionId ||
        actual.source.workspacePath !== source.workspacePath || actual.source.revision !== source.revision) {
      throw new AgentMuxError('The selected Claude conversation changed. Refresh native conversations; the original Agent is retained.', 'AGENT_NATIVE_RESUME_SOURCE_CHANGED')
    }
  }

  async function claudeRecoveryFiles(context: RecoveryContext) {
    const path = context.transcriptPath
    if (!path || context.source.providerId !== 'claude') throw new AgentMuxError('The exact original Claude transcript is unavailable.', 'RECOVERY_NATIVE_LOCATOR_UNAVAILABLE')
    await assertNativeCatalogPath(path, [root(context)])
    const original = await candidate(path, context)
    if (!original || original.source.nativeHandle.sessionId !== context.source.nativeSessionId || original.source.workspacePath !== context.workspacePath)
      throw new AgentMuxError('The retained native locator answers for another original Claude Session.', 'RECOVERY_NATIVE_SOURCE_CHANGED')
    return { files: [{ id: 'transcript', path, format: 'file' as const }], gaps: [], assertCurrent: async () => {
      await assertClaudeNativeResumeSource({ env: context.env, signal: context.signal, source: original.source })
    } }
  }

  return { listClaudeNativeSessions, assertClaudeNativeResumeSource, claudeRecoveryFiles }
}
