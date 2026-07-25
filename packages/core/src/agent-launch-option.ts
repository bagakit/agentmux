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
 * DESCRIBE half: a control the renderer draws for a Provider. `defaultChoiceId`, when present, names the
 * choice the renderer should pre-select; its absence means "leave the Provider's own default untouched",
 * and no argv is contributed until the user picks.
 */
export type LaunchOption = {
  id: string
  label: string
  description?: string
  choices: LaunchOptionChoice[]
  defaultChoiceId?: string
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
  defaultChoiceId?: string
}

/** UI → core: the choice id picked for each option id the renderer rendered. */
export type LaunchOptionSelection = Readonly<Record<string, string>>

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
    if (option.defaultChoiceId !== undefined && !seenChoiceIds.has(option.defaultChoiceId)) {
      throw new AgentMuxError(
        `Launch option '${option.id}' on provider ${providerId} names an unknown defaultChoiceId '${option.defaultChoiceId}'.`,
        'INVALID_LAUNCH_OPTION'
      )
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
    ...(option.defaultChoiceId === undefined ? {} : { defaultChoiceId: option.defaultChoiceId }),
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
