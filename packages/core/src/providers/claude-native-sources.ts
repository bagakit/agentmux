import { createClaudeNativeCatalog } from '@agentmux/providers/claude/native-catalog'
import { createClaudeNativeRegistry } from '@agentmux/providers/claude/native-registry'
import { createClaudeNativeSession } from '@agentmux/providers/claude/native-session'
import { AgentMuxError } from '../errors.js'
import type { AgentProvider } from '../agent-provider.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { nativeProcessBirth, nativeProcessFiles } from '../agent-native-process.js'
import { linuxNativeProcessStart } from '../agent-native-process-linux.js'
import { runProcess } from '../process-runner.js'
import { assertNativeCatalogPath, nativeCatalogFiles, nativeCatalogIssue, readNativeCatalogFile } from './native-session-catalog-files.js'

const discoverClaudeRegisteredSession = createClaudeNativeRegistry({ AgentMuxError, nativeProcessBirth, linuxNativeProcessStart, runProcess })
const nativeSession = createClaudeNativeSession({ AgentMuxError, normalizeNativeSessionId, nativeProcessFiles, discoverClaudeRegisteredSession })
export const { locateClaudeNativeSessions }: Pick<ReturnType<typeof createClaudeNativeSession>, 'locateClaudeNativeSessions'> = nativeSession
export const discoverClaudeNativeSession: NonNullable<AgentProvider['discoverNativeSession']> = nativeSession.discoverClaudeNativeSession
const nativeCatalog = createClaudeNativeCatalog({ AgentMuxError, normalizeNativeSessionId, assertNativeCatalogPath,
  nativeCatalogFiles, nativeCatalogIssue, readNativeCatalogFile })
export const listClaudeNativeSessions: NonNullable<AgentProvider['listNativeSessions']> = nativeCatalog.listClaudeNativeSessions
export const assertClaudeNativeResumeSource: NonNullable<AgentProvider['assertNativeResumeSource']> = nativeCatalog.assertClaudeNativeResumeSource
export const claudeRecoveryFiles: NonNullable<AgentProvider['recoveryFiles']> = nativeCatalog.claudeRecoveryFiles
