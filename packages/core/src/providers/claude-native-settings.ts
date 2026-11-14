import { createClaudeHookSettings } from '@agentmux/providers/claude/hook-settings'
import { readClaudeInputInitialization as readInput } from '@agentmux/providers/claude/input-initialization'
import { claudeGlobalConfigPath as findConfig, prepareClaudeOwnedWorkspaceTrust as prepareTrust } from '@agentmux/providers/claude/workspace-trust'
import { AgentMuxError } from '../errors.js'
import { executionEnvironmentValue, executionHomeDirectory, executionPath } from './execution-environment.js'

const environment = { executionEnvironmentValue, executionHomeDirectory, executionPath }

export const inspectClaudeHookSettings = createClaudeHookSettings({ AgentMuxError, ...environment })
export const claudeGlobalConfigPath = findConfig.bind(undefined, environment)
export const prepareClaudeOwnedWorkspaceTrust = prepareTrust.bind(undefined, environment)
export const readClaudeInputInitialization = readInput.bind(undefined, claudeGlobalConfigPath)
