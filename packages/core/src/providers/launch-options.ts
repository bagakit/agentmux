import { CODEX_LAUNCH_OPTIONS } from '@agentmux/providers/codex/launch-options'
import { CLAUDE_LAUNCH_OPTIONS } from '@agentmux/providers/claude/launch-options'
import { GEMINI_LAUNCH_OPTIONS } from '@agentmux/providers/gemini/launch-options'
import { GROK_LAUNCH_OPTIONS } from '@agentmux/providers/grok/launch-options'
import { TRAEX_LAUNCH_OPTIONS } from '@agentmux/providers/traex/launch-options'
import { CURSOR_LAUNCH_OPTIONS } from '@agentmux/providers/cursor/launch-options'
import { HERMES_LAUNCH_OPTIONS } from '@agentmux/providers/hermes/launch-options'
import { ANTIGRAVITY_LAUNCH_OPTIONS } from '@agentmux/providers/antigravity/launch-options'
import { withUnrestrictedLaunchOptionArgs, type LaunchOptionDeclaration } from '../agent-launch-option.js'

export {
  ANTIGRAVITY_LAUNCH_OPTIONS,
  CODEX_LAUNCH_OPTIONS,
  CLAUDE_LAUNCH_OPTIONS,
  GEMINI_LAUNCH_OPTIONS,
  GROK_LAUNCH_OPTIONS,
  TRAEX_LAUNCH_OPTIONS,
  CURSOR_LAUNCH_OPTIONS,
  HERMES_LAUNCH_OPTIONS
}

/** Browser-safe inventory of the original Provider-owned launch declarations. */
export const LAUNCH_OPTIONS_BY_PROVIDER_ID: Readonly<Record<string, readonly LaunchOptionDeclaration[]>> =
  Object.freeze({
    codex: CODEX_LAUNCH_OPTIONS,
    claude: CLAUDE_LAUNCH_OPTIONS,
    gemini: GEMINI_LAUNCH_OPTIONS,
    grok: GROK_LAUNCH_OPTIONS,
    traex: TRAEX_LAUNCH_OPTIONS,
    cursor: CURSOR_LAUNCH_OPTIONS,
    hermes: HERMES_LAUNCH_OPTIONS,
    antigravity: ANTIGRAVITY_LAUNCH_OPTIONS
  })


/** Built-in Provider contributions are lightweight and safe to use from settings/preview consumers. */
export function withUnrestrictedLaunchArgs(providerId: string, args: readonly string[]): string[] | null {
  const declarations = Object.hasOwn(LAUNCH_OPTIONS_BY_PROVIDER_ID, providerId) ? LAUNCH_OPTIONS_BY_PROVIDER_ID[providerId] : undefined
  return declarations ? withUnrestrictedLaunchOptionArgs(declarations, args) : null
}
