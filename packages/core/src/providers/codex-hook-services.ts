import { createCodexLaunchHooks } from '@agentmux/providers/codex/launch-hooks'
import { createCodexHookActivation } from '@agentmux/providers/codex/hook-activation'
import { AgentMuxError } from '../errors.js'
import { HOOK_COMMAND_TIMEOUT_SECONDS, runScopedHookCommand } from './shared.js'
import { withAppServerNativeRead } from './app-server.js'

const launch = createCodexLaunchHooks({ HOOK_COMMAND_TIMEOUT_SECONDS, runScopedHookCommand })
export const { codexManagedHooks, codexManagedHookConfigs, isCodexManagedHookConfig, withCodexLaunchHooks }: ReturnType<typeof createCodexLaunchHooks> = launch
export const inspectCodexHookActivation = createCodexHookActivation({ AgentMuxError, withAppServerNativeRead, ...launch })
