import { createCursorNativeDiscovery, type CursorDiscovery } from '@agentmux/providers/cursor/native-session'
import { createCursorPayloadProtocol } from '@agentmux/providers/cursor/payload-protocol'
import { createCursorWorkspaceTrust } from '@agentmux/providers/cursor/workspace-trust'
import type { AgentProviderPromptExecutionContext } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import * as nativeProcess from '../agent-native-process.js'
import { NativeSqliteHistoryReader } from '../native-sqlite-history-reader.js'
import type { AgentProviderNativeSessionDiscoveryContext } from '../types.js'
import { cursorDataRoot, readCursorStoreMetadata, resolveCursorStorePath } from './cursor-history.js'

export const { cursorTrustMarkerPath, prepareCursorOwnedWorkspaceTrust } = createCursorWorkspaceTrust(cursorDataRoot)
export const { discoverCursorNativeSession }: {
  discoverCursorNativeSession(context: AgentProviderNativeSessionDiscoveryContext): Promise<CursorDiscovery | null>
} =
  createCursorNativeDiscovery({ AgentMuxError,
    nativeProcessBirth: (...args) => nativeProcess.nativeProcessBirth(...args),
    nativeProcessFiles: (...args) => nativeProcess.nativeProcessFiles(...args),
    openStore: (path, signal) => NativeSqliteHistoryReader.open(path, signal),
    readCursorStoreMetadata, resolveCursorStorePath
  })
export const { qualifyCursorPayloadProtocol }: { qualifyCursorPayloadProtocol(context: AgentProviderPromptExecutionContext): Promise<string> } =
  createCursorPayloadProtocol({ AgentMuxError, nativeProcessBirth: (...args) => nativeProcess.nativeProcessBirth(...args),
    nativeProcessExecutable: (...args) => nativeProcess.nativeProcessExecutable(...args)
  })
