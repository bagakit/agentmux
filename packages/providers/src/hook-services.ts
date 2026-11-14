export type ProviderHookServices<Id extends string> = {
  formatHookToolOutput(value: unknown): string | undefined
  hookToolFields(name: unknown, input: unknown, reportedId?: unknown): {
    toolName?: string
    toolInput?: unknown
    reportedToolCallId?: string
  }
  runScopedHookCommand(providerId: Id): string
  hookCommandTimeout(providerId: Id, unit?: 'seconds' | 'milliseconds'): Record<string, number>
}

export type ProviderExecutionEnvironment = Readonly<Record<string, string | undefined>>

export type ProviderHookTarget = { env?: ProviderExecutionEnvironment; workspacePath?: string }

export type ProviderHookEnvironment = {
  executionEnvironmentValue(env: ProviderExecutionEnvironment | undefined, key: string): string | undefined
  executionHomeDirectory(env?: ProviderExecutionEnvironment): string
  executionPath(path: string, workspacePath?: string): string
}
