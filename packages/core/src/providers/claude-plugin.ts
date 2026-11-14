import { identityRuntimeSource } from '@agentmux/identity/runtime-source'
import { claudeNativeActivitySource as nativeSource, claudePlugin } from '@agentmux/providers/claude/native-activity'
import { defaultAgentMuxStateDirectory } from '../runtime-paths.js'
import { HOOK_COMMAND_TIMEOUT_SECONDS } from './shared.js'

export function claudeNativeActivitySource(): string {
  return nativeSource(identityRuntimeSource, HOOK_COMMAND_TIMEOUT_SECONDS)
}

export function createClaudePlugin(classicHooks: Readonly<Record<string, readonly unknown[]>>) {
  return claudePlugin(defaultAgentMuxStateDirectory(), claudeNativeActivitySource(), classicHooks)
}
