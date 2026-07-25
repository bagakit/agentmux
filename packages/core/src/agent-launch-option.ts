import { AgentMuxError } from './errors.js'
import type { AgentProviderId } from './types.js'

/**
 * Sealed Launch-Option Capabilities.
 *
 * A launch option is a choice a Provider offers ONCE, at spawn — never a live switch, because AgentMux
 * drives every agent as a real CLI process through a PTY and the only honest seam to alter model or
 * permission posture is the argv the process is launched with. The contract is split into the two halves
 * a PTY runtime can honor:
 *
 *   - the DESCRIBE half ({@link LaunchOption} / {@link LaunchOptionChoice}) is pure serializable data. It
 *     crosses IPC so the renderer can render a control from the declaration alone, with zero knowledge of
 *     the provider it came from.
 *   - the CONTRIBUTE half is the `argv` carried on each {@link LaunchOptionChoiceDeclaration}. It never
 *     crosses IPC; {@link resolveLaunchOptionArgv} runs core-side at spawn, turning the choice ids the UI
 *     sent back into the exact argv fragment appended to the launch.
 *
 * One {@link LaunchOptionDeclaration} is the single source of truth for BOTH halves, so the label the UI
 * shows and the argv used at launch can never drift. A Provider that declares no option contributes
 * nothing and the renderer, reading an empty {@link LaunchOption} array, renders no control — absence
 * hides, it never disables-with-tooltip. Adding an option to a Provider later requires no renderer change.
 */

/** Permission-style danger ranking a renderer can surface (e.g. escalating colour on a choice). */
export type LaunchOptionTier = 'safe' | 'caution' | 'danger'

/**
 * DESCRIBE half: one selectable value of an option. Pure data — this is exactly what crosses IPC and what
 * the renderer renders. It deliberately carries no argv; the launch contribution lives core-side.
 */
export type LaunchOptionChoice = {
  id: string
  label: string
  description?: string
  tier?: LaunchOptionTier
}

/**
 * DESCRIBE half: a control the renderer draws for a Provider. No choice is pre-selected — the renderer
 * starts every option unset, so nothing is contributed and the Provider's own default is left untouched
 * until the user picks.
 */
export type LaunchOption = {
  id: string
  label: string
  description?: string
  choices: LaunchOptionChoice[]
}

/**
 * SSOT declaration: a {@link LaunchOptionChoice} fused with the argv it contributes at launch. Providers
 * declare these; {@link describeLaunchOptions} projects out the DESCRIBE half for IPC and
 * {@link resolveLaunchOptionArgv} reads the argv half core-side.
 */
export type LaunchOptionChoiceDeclaration = LaunchOptionChoice & {
  readonly argv: readonly string[]
}

/** SSOT declaration: an option fused with every choice's argv contribution. */
export type LaunchOptionDeclaration = {
  id: string
  label: string
  description?: string
  readonly choices: readonly LaunchOptionChoiceDeclaration[]
}

/** UI → core: the choice id picked for each option id the renderer rendered. */
export type LaunchOptionSelection = Readonly<Record<string, string>>

/**
 * Canonicalize a caller-supplied selection for the launch path and for persistence. Every entry must be
 * a non-empty string keyed by a non-empty option id; the whole selection is fail-closed rejected
 * otherwise, so a malformed posture never reaches a spawn. A selection that names nothing (absent or
 * empty) resolves to `undefined` — an un-narrowed create contributes no argv and stores no field, so it
 * resumes on the Provider's own default rather than a fabricated empty one.
 */
export function normalizeLaunchOptionSelection(value: unknown): LaunchOptionSelection | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError('Launch option selection must be an object.', 'INVALID_LAUNCH_OPTION_SELECTION')
  }
  const selection: Record<string, string> = {}
  for (const [optionId, choiceId] of Object.entries(value as Record<string, unknown>)) {
    if (!optionId.trim() || typeof choiceId !== 'string' || !choiceId.trim()) {
      throw new AgentMuxError(
        'Launch option selection entries must be non-empty option and choice ids.',
        'INVALID_LAUNCH_OPTION_SELECTION'
      )
    }
    selection[optionId] = choiceId
  }
  return Object.keys(selection).length > 0 ? selection : undefined
}

/**
 * Fail closed on a malformed declaration so a Provider can never ship an option the UI cannot render or
 * the resolver cannot honor. Called once, when a Provider is defined.
 */
export function validateLaunchOptionDeclarations(
  providerId: AgentProviderId,
  declarations: readonly LaunchOptionDeclaration[]
): void {
  const seenOptionIds = new Set<string>()
  for (const option of declarations) {
    if (!option.id.trim() || !option.label.trim()) {
      throw new AgentMuxError(
        `Launch option on provider ${providerId} must carry a non-empty id and label.`,
        'INVALID_LAUNCH_OPTION'
      )
    }
    if (seenOptionIds.has(option.id)) {
      throw new AgentMuxError(
        `Duplicate launch option id '${option.id}' on provider ${providerId}.`,
        'INVALID_LAUNCH_OPTION'
      )
    }
    seenOptionIds.add(option.id)
    if (option.choices.length === 0) {
      throw new AgentMuxError(
        `Launch option '${option.id}' on provider ${providerId} must declare at least one choice.`,
        'INVALID_LAUNCH_OPTION'
      )
    }
    const seenChoiceIds = new Set<string>()
    for (const choice of option.choices) {
      if (!choice.id.trim() || !choice.label.trim()) {
        throw new AgentMuxError(
          `Choice on launch option '${option.id}' (provider ${providerId}) must carry a non-empty id and label.`,
          'INVALID_LAUNCH_OPTION'
        )
      }
      if (seenChoiceIds.has(choice.id)) {
        throw new AgentMuxError(
          `Duplicate choice id '${choice.id}' on launch option '${option.id}' (provider ${providerId}).`,
          'INVALID_LAUNCH_OPTION'
        )
      }
      seenChoiceIds.add(choice.id)
    }
  }
}

/** Project the DESCRIBE half out of the SSOT declarations — the pure data that crosses IPC. */
export function describeLaunchOptions(
  declarations: readonly LaunchOptionDeclaration[]
): LaunchOption[] {
  return declarations.map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
    choices: option.choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      ...(choice.description === undefined ? {} : { description: choice.description }),
      ...(choice.tier === undefined ? {} : { tier: choice.tier })
    }))
  }))
}

/** Deep clone the DESCRIBE half so a catalog copy shares no mutable structure with a Provider. */
export function cloneLaunchOptions(options: readonly LaunchOption[]): LaunchOption[] {
  return options.map((option) => ({
    ...option,
    choices: option.choices.map((choice) => ({ ...choice }))
  }))
}

/**
 * CONTRIBUTE half: turn a Provider's declarations plus the choice ids the UI sent back into the argv
 * fragment to append at launch. Argv order follows declaration order, so composing two options is
 * deterministic regardless of how the renderer serialized the selection. Fails closed — an option id or
 * choice id the Provider does not declare throws rather than being silently ignored, so a stale or
 * tampered selection can never launch a process with a posture the Provider never offered. A Provider
 * that declares nothing, or a selection that names nothing, resolves to an empty fragment.
 */
export function resolveLaunchOptionArgv(
  providerId: AgentProviderId,
  declarations: readonly LaunchOptionDeclaration[],
  selections: LaunchOptionSelection
): string[] {
  const declaredById = new Map(declarations.map((option) => [option.id, option]))
  for (const optionId of Object.keys(selections)) {
    if (!declaredById.has(optionId)) {
      throw new AgentMuxError(
        `Provider ${providerId} does not declare launch option '${optionId}'.`,
        'UNKNOWN_LAUNCH_OPTION'
      )
    }
  }
  const argv: string[] = []
  for (const option of declarations) {
    const choiceId = selections[option.id]
    if (choiceId === undefined) continue
    const choice = option.choices.find((candidate) => candidate.id === choiceId)
    if (!choice) {
      throw new AgentMuxError(
        `Launch option '${option.id}' on provider ${providerId} has no choice '${choiceId}'.`,
        'UNKNOWN_LAUNCH_OPTION_CHOICE'
      )
    }
    argv.push(...choice.argv)
  }
  return argv
}

// SSOT launch-option declarations. Every flag below was verified against the installed CLI's own --help
// before it was declared; nothing is invented. Each choice's argv is the exact flag pair the CLI accepts,
// and the label is what the renderer shows — one declaration, so the two can never drift. AgentMux drives
// these as real PTY processes, so these are honestly launch-time choices, not live switches. They live in
// this node-free module (it imports only ./errors.js and ./types.js) so both the Provider catalog and the
// browser-only preview mock read the SAME constant — the mock projects its DESCRIBE half via
// describeLaunchOptions, exactly as the real catalog does, and can never hand-copy a diverging catalog.

// codex top-level (interactive) flags. `-s/--sandbox <read-only|workspace-write|danger-full-access>` and
// `-a/--ask-for-approval <on-request|never>` verified via `codex --help`. Two options that compose.
export const CODEX_LAUNCH_OPTIONS: readonly LaunchOptionDeclaration[] = [
  {
    id: 'sandbox',
    label: 'Sandbox',
    description: 'How much of the machine Codex may touch when it runs commands.',
    choices: [
      { id: 'read-only', label: 'Read only', tier: 'safe', argv: ['--sandbox', 'read-only'] },
      {
        id: 'workspace-write',
        label: 'Workspace write',
        description: 'Writes limited to the workspace.',
        tier: 'caution',
        argv: ['--sandbox', 'workspace-write']
      },
      {
        id: 'danger-full-access',
        label: 'Full access',
        description: 'No sandbox — full machine access.',
        tier: 'danger',
        argv: ['--sandbox', 'danger-full-access']
      }
    ]
  },
  {
    id: 'approval',
    label: 'Approval policy',
    description: 'When Codex pauses for human approval before running a command.',
    choices: [
      {
        id: 'on-request',
        label: 'On request',
        description: 'The model decides when to ask.',
        tier: 'caution',
        argv: ['--ask-for-approval', 'on-request']
      },
      {
        id: 'never',
        label: 'Never',
        description: 'Never pauses for approval.',
        tier: 'danger',
        argv: ['--ask-for-approval', 'never']
      }
    ]
  }
]

// claude top-level flag `--permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>`,
// verified via `claude --help`. One option; its argv composes cleanly with the positional prompt.
export const CLAUDE_LAUNCH_OPTIONS: readonly LaunchOptionDeclaration[] = [
  {
    id: 'permission-mode',
    label: 'Permission mode',
    description: 'How Claude handles tool-permission prompts for this session.',
    choices: [
      { id: 'manual', label: 'Manual', description: 'Ask for each action.', tier: 'safe', argv: ['--permission-mode', 'manual'] },
      { id: 'plan', label: 'Plan', description: 'Plan first, no edits.', tier: 'safe', argv: ['--permission-mode', 'plan'] },
      { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-accept file edits.', tier: 'caution', argv: ['--permission-mode', 'acceptEdits'] },
      { id: 'auto', label: 'Auto', tier: 'caution', argv: ['--permission-mode', 'auto'] },
      { id: 'dontAsk', label: "Don't ask", tier: 'caution', argv: ['--permission-mode', 'dontAsk'] },
      { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Skip all permission checks.', tier: 'danger', argv: ['--permission-mode', 'bypassPermissions'] }
    ]
  }
]
