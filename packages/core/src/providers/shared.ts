import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { resolveCoreBinPath } from '../runtime-paths.js'
import type { AgentCatalogEntry, AgentProviderId } from '../types.js'

export type ManagedHookPlanBuilder = (
  workspacePath: string,
  env?: Readonly<Record<string, string>>
) => AgentManagedHookPlan

/** Add the common foreground-process readiness signal to a provider catalog seed. */
export function catalog(input: Omit<AgentCatalogEntry, 'readySignal' | 'launchOptions'>): Omit<AgentCatalogEntry, 'launchOptions'> {
  return {
    ...input,
    readySignal: { kind: 'foreground-process', expectedProcess: input.expectedProcess }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Build the managed hook command written into a provider's hooks config.
 *
 * The executable is intentionally resolved at launch time so both a real Node
 * process and packaged Electron can invoke the same hook runner.
 */
export function managedHookCommand(providerId: AgentProviderId): string {
  const commandPath = resolveCoreBinPath('agentmux-hook.js')
  return `ELECTRON_RUN_AS_NODE=1 AGENTMUX_HOOK_PROVIDER=${shellQuote(providerId)} ${shellQuote(process.execPath)} ${shellQuote(commandPath)}`
}

/** Hermes invokes shell hooks with shlex.split(...), shell=False. */
export function hermesHookCommand(): string {
  const commandPath = resolveCoreBinPath('agentmux-hook.js')
  return `/usr/bin/env ELECTRON_RUN_AS_NODE=1 AGENTMUX_HOOK_PROVIDER=${shellQuote('hermes')} ${shellQuote(process.execPath)} ${shellQuote(commandPath)}`
}

export const BRACKETED_PASTE_START = '\u001b[200~'
export const BRACKETED_PASTE_END = '\u001b[201~'

export function sanitizeBracketedPasteText(text: string): string {
  return text.replaceAll('\u001b', '\u241b')
}

export function wrapBracketedPasteText(text: string): string {
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(text)}${BRACKETED_PASTE_END}`
}

export function buildPromptInputPayload(prompt: string): string {
  return /[\r\n]/.test(prompt)
    ? wrapBracketedPasteText(prompt)
    : sanitizeBracketedPasteText(prompt)
}