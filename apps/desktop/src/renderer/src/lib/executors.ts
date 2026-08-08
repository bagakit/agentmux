import type { AppConfig } from '../../../shared/contracts'

export type ConfiguredExecutor = AppConfig['executors'][string] & { id: string }

export function configuredExecutors(config: AppConfig | null | undefined): ConfiguredExecutor[] {
  return Object.entries(config?.executors ?? {}).map(([id, executor]) => ({ id, ...executor }))
}

/** Explicit, provider-verified unattended launch posture used by the one-click YOLO action. */
export function yoloArgsForProvider(providerId: string): string[] | null {
  if (providerId === 'codex') return ['--dangerously-bypass-approvals-and-sandbox']
  if (providerId === 'claude') return ['--dangerously-skip-permissions']
  return null
}

export function withYoloArgs(providerId: string, args: readonly string[]): string[] | null {
  const yolo = yoloArgsForProvider(providerId)
  if (!yolo) return null
  const blocked = new Set([
    '--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--yolo',
    '--sandbox', '--ask-for-approval', '--permission-mode'
  ])
  const result: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!
    if (!blocked.has(token) && ![...blocked].some((flag) => token.startsWith(`${flag}=`))) { result.push(token); continue }
    if (token === '--sandbox' || token === '--ask-for-approval' || token === '--permission-mode') i += 1
  }
  return [...result, ...yolo]
}
