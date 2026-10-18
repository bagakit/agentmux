import { AgentMuxError } from './errors.js'

export const DEFAULT_TOOLKIT_WORKSPACE_PATH = '~/.agentmux'
/** Structured error attribution, preserved by RPC and Desktop IPC; never input authority. */
export const TOOLKIT_WORKSPACE_PATH_ERROR_DETAIL = 'toolkit.workspacePath'

/** Expand only the execution Host's home prefix. The remaining path is literal. */
export function resolveToolkitWorkspacePath(value: string, homeDir: string): string {
  if (!value || value.includes('\0')) {
    throw new AgentMuxError('Working directory must be a nonempty path without null characters.', 'INVALID_SETTING_VALUE', TOOLKIT_WORKSPACE_PATH_ERROR_DETAIL)
  }
  if (value.startsWith('/')) return value
  const prefix = ['~', '$HOME', '${HOME}'].find(prefix => value === prefix || value.startsWith(prefix + '/'))
  if (!prefix) {
    throw new AgentMuxError('Working directory must be an absolute path or start with ~/, $HOME/ or ${HOME}/. Relative paths have no fixed base.', 'INVALID_SETTING_VALUE', TOOLKIT_WORKSPACE_PATH_ERROR_DETAIL)
  }
  if (!homeDir.startsWith('/') || homeDir.includes('\0')) {
    throw new AgentMuxError('The execution Host home directory is unavailable. The working directory cannot be expanded yet.', 'HOST_HOME_UNAVAILABLE', TOOLKIT_WORKSPACE_PATH_ERROR_DETAIL)
  }
  const suffix = value.slice(prefix.length)
  return homeDir.endsWith('/') && suffix.startsWith('/') ? homeDir + suffix.slice(1) : homeDir + suffix
}
