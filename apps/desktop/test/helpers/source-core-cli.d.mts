export type SourceCoreCli = {
  sourceRoot: string
  cliPath: string
  identityRuntime: string
  identity: { recipe: string; sha256: string }
  cli: { sha256: string; inputs: Record<string, string> }
}
export function buildSourceCoreCli(root: string, temporary: string): Promise<SourceCoreCli>
export function prepareSourceCoreCli(): Promise<SourceCoreCli & { cleanup(): Promise<void> }>
