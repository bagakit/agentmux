import { createCodexDurableQueueInput } from '@agentmux/providers/codex/native-queue'
import type { AgentProvider } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import { nativeProcessBirth, nativeProcessExecutable, nativeProcessFiles } from '../agent-native-process.js'
import { nativeInputSourceId } from '../native-input-correlation.js'
import { locateAppServerNativeSession } from './app-server.js'

export const prepareCodexDurableQueueInput: NonNullable<AgentProvider['prepareNativeInput']> =
  createCodexDurableQueueInput({
    AgentMuxError, nativeInputSourceId, locateAppServerNativeSession,
    nativeProcessBirth: (processId, signal) => nativeProcessBirth(processId, signal),
    nativeProcessExecutable: (processId, signal) => nativeProcessExecutable(processId, signal),
    nativeProcessFiles: (processId, signal, scope) => nativeProcessFiles(processId, signal, scope)
  })
