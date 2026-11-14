import type { NativeProviderError } from './provider-error.js'

export type CatalogContext = { workspacePath?: string; env: Readonly<NodeJS.ProcessEnv>; signal: AbortSignal }
export type CatalogIssue = { code: string; message: string }
type NativeResumeSource = {
  nativeHandle: { kind: 'provider'; providerId: string; sessionId: string; transcriptPath?: string }
  workspacePath: string
  revision: string
}
export type CatalogCandidate<Id extends string> = {
  source: NativeResumeSource & { nativeHandle: { providerId: Id; transcriptPath: string } }
  title?: string
  createdAt?: number
  updatedAt: number
}
type CatalogReader = {
  readFirst(): Promise<Record<string, unknown> | null>
  readNext(): Promise<{ value: Record<string, unknown> } | null>
}
export type ResumeContext = CatalogContext & { source: NativeResumeSource }
export type RecoveryContext = CatalogContext & { workspacePath: string; transcriptPath?: string; source: { providerId: string; nativeSessionId: string } }

export type NativeCatalogServices = {
  AgentMuxError: NativeProviderError
  normalizeNativeSessionId: (value: unknown) => string | undefined
  assertNativeCatalogPath: (path: string, roots: readonly string[]) => Promise<void>
  nativeCatalogFiles: (root: string, context: CatalogContext, issues: CatalogIssue[], accepts: (name: string) => boolean) => AsyncGenerator<string>
  nativeCatalogIssue: (error: unknown) => CatalogIssue
  readNativeCatalogFile: <T>(providerId: string, path: string, context: CatalogContext,
    read: (reader: CatalogReader) => Promise<T>) => Promise<{ value: T; revision: string; updatedAt: number }>
}
