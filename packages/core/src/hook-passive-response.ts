import { ANTIGRAVITY_PASSIVE_HOOK_RESPONSES } from './providers/antigravity-hook-response.js'

// Lightweight native contributions shared by the worker and its pre-load entry.
const contributions: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  antigravity: ANTIGRAVITY_PASSIVE_HOOK_RESPONSES
}
export function passiveHookResponses(provider: string | null): Readonly<Record<string, string>> {
  return provider ? contributions[provider] ?? {} : {}
}
export function hookResponseFor(provider: string | null, event: string | null): string {
  return event ? passiveHookResponses(provider)[event] ?? '{}\n' : '{}\n'
}
