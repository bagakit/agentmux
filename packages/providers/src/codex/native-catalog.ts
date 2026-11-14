import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { NativeProviderError } from '../provider-error.js'

type CatalogContext = { workspacePath?: string; env: Readonly<NodeJS.ProcessEnv>; signal: AbortSignal }
type CatalogIssue = { code: string; message: string }
type NativeResumeSource = {
  nativeHandle: { kind: 'provider'; providerId: string; sessionId: string; transcriptPath?: string }
  workspacePath: string
  revision: string
}
type CodexCandidate = {
  source: NativeResumeSource & { nativeHandle: { providerId: 'codex'; transcriptPath: string } }
  title?: string
  createdAt?: number
  updatedAt: number
}
type CatalogReader = {
  readFirst(): Promise<Record<string, unknown> | null>
  readNext(): Promise<{ value: Record<string, unknown> } | null>
}
type ResumeContext = CatalogContext & { source: NativeResumeSource }
type RecoveryContext = CatalogContext & { workspacePath: string; transcriptPath?: string; source: { providerId: string; nativeSessionId: string } }

export function createCodexNativeCatalog({ AgentMuxError, normalizeNativeSessionId, assertNativeCatalogPath,
  nativeCatalogFiles, nativeCatalogIssue, readNativeCatalogFile }: {
  AgentMuxError: NativeProviderError
  normalizeNativeSessionId: (value: unknown) => string | undefined
  assertNativeCatalogPath: (path: string, roots: readonly string[]) => Promise<void>
  nativeCatalogFiles: (root: string, context: CatalogContext, issues: CatalogIssue[], accepts: (name: string) => boolean) => AsyncGenerator<string>
  nativeCatalogIssue: (error: unknown) => CatalogIssue
  readNativeCatalogFile: <T>(providerId: string, path: string, context: CatalogContext,
    read: (reader: CatalogReader) => Promise<T>) => Promise<{ value: T; revision: string; updatedAt: number }>
}) {
  function home(context: CatalogContext): string {
    const configured = context.env.CODEX_HOME ?? process.env.CODEX_HOME
    return configured ? resolve(configured) : join(context.env.HOME ?? homedir(), '.codex')
  }
  const roots = (context: CatalogContext): string[] => [join(home(context), 'sessions'), join(home(context), 'archived_sessions')]

  async function candidate(path: string, context: CatalogContext): Promise<CodexCandidate | null> {
    path = await realpath(path)
    const metadata = await readNativeCatalogFile('codex', path, context, async reader => await reader.readFirst())
    const record = metadata.value, payload = record?.payload as Record<string, unknown> | undefined
    const id = normalizeNativeSessionId(payload?.id), cwd = payload?.cwd
    if (record?.type !== 'session_meta' || !id || typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new AgentMuxError('Codex conversation metadata has no exact native identity and execution directory.', 'AGENT_NATIVE_SESSION_METADATA_INVALID')
    }
    // Native child records are ancestry, never independent main conversations in the Resume catalog.
    if (payload!.source && typeof payload!.source === 'object' && 'subagent' in payload!.source) return null
    // The native 0.42/0.43 SessionMeta protocol records originator and cli_version, without source.
    // These original CLI/editor producers identify retained main conversations; missing metadata is not a child.
    const legacyMain = payload!.source === undefined && ['codex_cli_rs', 'codex_vscode'].includes(String(payload!.originator)) &&
      typeof payload!.cli_version === 'string' && payload!.cli_version.trim().length > 0
    if (!legacyMain && !['cli', 'exec', 'vscode', 'appServer'].includes(String(payload!.source))) {
      throw new AgentMuxError('Codex native conversation provenance is unknown.', 'AGENT_NATIVE_SESSION_PROVENANCE_UNKNOWN')
    }
    if (context.workspacePath !== undefined && cwd !== context.workspacePath) return null
    const createdAt = Date.parse(String(payload!.timestamp ?? record!.timestamp))
    return { source: { nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: id, transcriptPath: path }, workspacePath: cwd, revision: metadata.revision },
      ...(Number.isFinite(createdAt) ? { createdAt } : {}), updatedAt: metadata.updatedAt }
  }

  async function listCodexNativeSessions(context: CatalogContext) {
    const catalog = { providerId: 'codex' as const, availability: 'available' as const, sessions: [] as CodexCandidate[], issues: [] as CatalogIssue[] }
    const titles = new Map<string, string>()
    try {
      await readNativeCatalogFile('codex', join(home(context), 'session_index.jsonl'), context, async reader => {
        for (let next = await reader.readNext(); next; next = await reader.readNext()) {
          const row = next.value, id = normalizeNativeSessionId(row.id)
          if (id && typeof row.thread_name === 'string' && row.thread_name.trim()) titles.set(id, row.thread_name.slice(0, 240))
        }
      })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') catalog.issues.push(nativeCatalogIssue(error)) }
    for (const root of roots(context)) for await (const path of nativeCatalogFiles(root, context, catalog.issues, name => /^rollout-.*\.jsonl$/u.test(name))) {
      try {
        const entry = await candidate(path, context)
        if (entry) catalog.sessions.push({ ...entry, ...(titles.has(entry.source.nativeHandle.sessionId) ? { title: titles.get(entry.source.nativeHandle.sessionId)! } : {}) })
      } catch (error) { context.signal.throwIfAborted(); catalog.issues.push(nativeCatalogIssue(error)) }
    }
    catalog.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return catalog
  }

  async function assertCodexNativeResumeSource(context: ResumeContext): Promise<void> {
    const source = context.source, path = source.nativeHandle.transcriptPath
    if (source.nativeHandle.providerId !== 'codex' || !path || !/^rollout-.*\.jsonl$/u.test(basename(path))) {
      throw new AgentMuxError('This exact source does not belong to Codex.', 'INVALID_AGENT_NATIVE_RESUME_SOURCE')
    }
    await assertNativeCatalogPath(path, roots(context))
    const actual = await candidate(path, { env: context.env, signal: context.signal })
    if (!actual || actual.source.nativeHandle.sessionId !== source.nativeHandle.sessionId ||
        actual.source.workspacePath !== source.workspacePath || actual.source.revision !== source.revision) {
      throw new AgentMuxError('The selected Codex conversation changed. Refresh native conversations; the original Agent is retained.', 'AGENT_NATIVE_RESUME_SOURCE_CHANGED')
    }
  }

  async function codexRecoveryFiles(context: RecoveryContext) {
    const path = context.transcriptPath
    if (!path || context.source.providerId !== 'codex') throw new AgentMuxError('The exact original Codex transcript is unavailable.', 'RECOVERY_NATIVE_LOCATOR_UNAVAILABLE')
    await assertNativeCatalogPath(path, roots(context))
    const original = await candidate(path, context)
    if (!original || original.source.nativeHandle.sessionId !== context.source.nativeSessionId || original.source.workspacePath !== context.workspacePath)
      throw new AgentMuxError('The retained native locator answers for another original Codex Session.', 'RECOVERY_NATIVE_SOURCE_CHANGED')
    return { files: [{ id: 'transcript', path, format: 'file' as const }], gaps: [], assertCurrent: async () => {
      await assertCodexNativeResumeSource({ env: context.env, signal: context.signal, source: original.source })
    } }
  }

  return { listCodexNativeSessions, assertCodexNativeResumeSource, codexRecoveryFiles }
}
