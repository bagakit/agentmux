import { userInfo } from 'node:os'
import { resolve } from 'node:path'

/** Overrides merge into the launching process; an own undefined removes an inherited value. */
export type ProviderExecutionEnvironment = Readonly<Record<string, string | undefined>>

export function executionEnvironmentValue(env: ProviderExecutionEnvironment | undefined, key: string): string | undefined {
  return env && Object.hasOwn(env, key) ? env[key] : process.env[key]
}

/** Match the native process home lookup without temporarily changing the Core's process.env. */
export function executionHomeDirectory(env?: ProviderExecutionEnvironment): string {
  const key = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  return executionEnvironmentValue(env, key) ?? userInfo().homedir
}

/** A relative native configuration path is relative to the launched process, not the Core. */
export function executionPath(path: string, workspacePath: string = process.cwd()): string {
  return resolve(workspacePath, path)
}

/** Native Node temporary-directory fallback, evaluated in the same inherited/unset environment. */
export function executionTemporaryDirectory(env?: ProviderExecutionEnvironment): string {
  if (process.platform === 'win32') return executionEnvironmentValue(env, 'TEMP') || executionEnvironmentValue(env, 'TMP') ||
    `${executionEnvironmentValue(env, 'SystemRoot') || executionEnvironmentValue(env, 'windir') || 'C:\\Windows'}\\temp`
  return executionEnvironmentValue(env, 'TMPDIR') || executionEnvironmentValue(env, 'TMP') || executionEnvironmentValue(env, 'TEMP') || '/tmp'
}
