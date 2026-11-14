import { AgentMuxError } from '@agentmux/core'

/**
 * The one decision for "may this caller drive this Browser's page?".
 *
 * The caller decides, not the handler name: a managed Agent arrives with a caller attached by Core,
 * a person starts runs from the GUI or from the CLI without one. The global switch in
 * Settings › Browser keeps its meaning for both, so a person who turned it off cannot start runs
 * either. A Profile's own Agent switch only narrows Agent callers; a person can still run their own
 * steps in a Profile where Agents are turned off. Stopping never asks this gate: turning a switch
 * off must not take away the way to stop what is already running.
 */
export type BrowserAutomationCaller = { kind: 'agent'; agentSessionId: string } | { kind: 'person' }

export type BrowserAutomationFacts = {
  /** Settings › Browser › Agent browser automation. */
  automation: boolean
  /** The Profile of the Browser being driven; null for a private page or a Capsule, unknown when unread. */
  profile: { agentAccess: boolean } | null | 'unknown'
}

export function browserAutomationCaller(caller: { agentSessionId?: string } | undefined | null): BrowserAutomationCaller {
  return caller?.agentSessionId ? { kind: 'agent', agentSessionId: caller.agentSessionId } : { kind: 'person' }
}

/** Throws a typed refusal naming where to change it; returns when the caller may drive the page. */
export function assertBrowserAutomation(caller: BrowserAutomationCaller, facts: BrowserAutomationFacts): void {
  if (!facts.automation) {
    throw new AgentMuxError('Agent browser automation is off. Turn it on in Settings › Browser.', 'BROWSER_AUTOMATION_DISABLED')
  }
  if (caller.kind !== 'agent') return
  if (facts.profile === 'unknown') {
    throw new AgentMuxError('This Browser’s Profile is not confirmed yet, so whether Agents may use it is unknown. The page is kept; retry once Browser Profiles load.',
      'BROWSER_PROFILE_AGENT_ACCESS_UNKNOWN')
  }
  if (facts.profile && !facts.profile.agentAccess) {
    throw new AgentMuxError('Agents are turned off for this Browser’s Profile. A person can turn them on in Settings › Browser Profiles, or use a Browser in another Profile.',
      'BROWSER_PROFILE_AGENT_ACCESS_OFF')
  }
}

export type BrowserAutomationGatePorts = {
  automation(): boolean
  /** The Browser's storage: a Profile id, null for a private page, a Capsule or an external tab. Throws when unread. */
  profileOf(browserId: string): Promise<string | null>
  /** The Profile's Agent switch; undefined when the Profile list is not loaded or lacks it. */
  agentAccess(profileId: string): boolean | undefined
}

/** One gate for every entry that starts page work: run, replay, task run, batch and outcome checks. */
export function createBrowserAutomationGate(ports: BrowserAutomationGatePorts) {
  return async (browserId: string, rawCaller: { agentSessionId?: string } | undefined | null, expectedProfileId?: string): Promise<void> => {
    const caller = browserAutomationCaller(rawCaller)
    if (!ports.automation() || caller.kind !== 'agent') return assertBrowserAutomation(caller, { automation: ports.automation(), profile: null })
    // Only an Agent asks for the Profile, so a person's run does no extra reads.
    let profile: BrowserAutomationFacts['profile'], observedProfileId: string | null | undefined
    try {
      const profileId = await ports.profileOf(browserId)
      observedProfileId = profileId
      if (profileId === null) profile = null
      else {
        const access = ports.agentAccess(profileId)
        profile = access === undefined ? 'unknown' : { agentAccess: access }
      }
    } catch { profile = 'unknown' }
    if (expectedProfileId !== undefined && observedProfileId !== undefined && observedProfileId !== expectedProfileId) throw new AgentMuxError('The original task target Profile changed. No native page or action was admitted for a replacement Profile.', 'CONTROL_REQUEST_CONFLICT')
    assertBrowserAutomation(caller, { automation: ports.automation(), profile })
  }
}
export type BrowserAutomationGate = ReturnType<typeof createBrowserAutomationGate>
