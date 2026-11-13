import { AgentMuxError, isBrowserProfileControlOperation, type AgentMuxControlRequest, type AgentMuxControlResult, type AgentMuxNameActor,
  type BrowserProfileControlOperation } from '@agentmux/core/control'
import { ZodError } from 'zod'
import type { BrowserProfileSummary } from '../shared/contracts.js'
import type { BrowserProfileManager } from './browser-profile-manager.js'
import type { BrowserProfileUsageOwner } from './browser-profile-usage.js'
import type { BrowserProfileNetworkControl } from './browser-profile-network-control.js'

type ProfileRequest = Extract<AgentMuxControlRequest, { operation: BrowserProfileControlOperation }>
type ProfileResult = Extract<AgentMuxControlResult, { operation: BrowserProfileControlOperation }>

export function isBrowserProfileControlRequest(request: AgentMuxControlRequest): request is ProfileRequest {
  return isBrowserProfileControlOperation(request.operation)
}

export type BrowserProfileControlPorts = {
  profiles: Pick<BrowserProfileManager, 'initialize' | 'listProfiles' | 'listRevision' | 'createProfile' | 'updateProfile' | 'setDefaultProfile'>
  usage: Pick<BrowserProfileUsageOwner, 'usage' | 'deleteProfile'>
  network: BrowserProfileNetworkControl
}

function existing(ports: BrowserProfileControlPorts, profileId: string): BrowserProfileSummary {
  const profile = ports.profiles.listProfiles().find(candidate => candidate.id === profileId)
  if (!profile) throw new AgentMuxError(`Unknown Browser Profile: ${profileId}. Read browser profile ls for the current ids.`, 'BROWSER_PROFILE_NOT_FOUND')
  return profile
}

/** Store validation names what was wrong; keep those sentences instead of the raw issue array. */
async function owned<T>(write: () => Promise<T>): Promise<T> {
  try { return await write() }
  catch (cause) {
    if (cause instanceof ZodError) throw new AgentMuxError(cause.issues.map(issue => issue.message).join('; '), 'INVALID_CONTROL_REQUEST')
    throw cause
  }
}

/**
 * Public Browser Profile control. Every answer comes from the same Main manager and usage owner the
 * Settings page uses; this dispatcher keeps no Profile state. A delete approval is built here from the
 * trusted caller recorded by the Host, never from request fields.
 */
export async function executeBrowserProfileControl(request: ProfileRequest, ports: BrowserProfileControlPorts,
  actor: AgentMuxNameActor | undefined): Promise<ProfileResult> {
  await ports.profiles.initialize()
  switch (request.operation) {
    case 'browser.profile.proxy-sign-in.set':
    case 'browser.profile.proxy-sign-in.clear': {
      if (!actor?.verified || (actor.kind !== 'user' && actor.kind !== 'device')) {
        throw new AgentMuxError('Proxy sign-in changes require a person or device. The Profile, its route and Browsers remain available; ask the person to change the sign-in.',
          'BROWSER_PROFILE_PROXY_AUTH_REQUIRES_PERSON')
      }
      existing(ports, request.profileId)
      const { reconnected } = await ports.network.setProxySignIn(request.profileId, request.operation === 'browser.profile.proxy-sign-in.set' ? request.signIn : null)
      return request.operation === 'browser.profile.proxy-sign-in.set'
        ? { operation: request.operation, profileId: request.profileId, saved: true, reconnected }
        : { operation: request.operation, profileId: request.profileId, cleared: true, reconnected }
    }
    case 'browser.profile.network.check':
      existing(ports, request.profileId)
      return { operation: request.operation, profileId: request.profileId, check: await ports.network.checkExit(request.profileId) }
    case 'browser.profile.ls':
      return { operation: request.operation, revision: ports.profiles.listRevision(), profiles: ports.profiles.listProfiles() }
    case 'browser.profile.inspect': {
      const profile = existing(ports, request.profileId)
      const revision = ports.profiles.listRevision()
      return { operation: request.operation, revision, profile, usage: await ports.usage.usage(request.profileId) }
    }
    case 'browser.profile.create': {
      const profile = await owned(() => ports.profiles.createProfile(request.label))
      return { operation: request.operation, revision: ports.profiles.listRevision(), profile }
    }
    case 'browser.profile.update': {
      existing(ports, request.profileId)
      const profile = await owned(() => ports.profiles.updateProfile(request.profileId, request.edit, request.expectedRevision))
      return { operation: request.operation, revision: ports.profiles.listRevision(), profile }
    }
    case 'browser.profile.set-default':
      existing(ports, request.profileId)
      await ports.profiles.setDefaultProfile(request.profileId)
      return { operation: request.operation, revision: ports.profiles.listRevision(), profileId: request.profileId }
    case 'browser.profile.delete': {
      if (!actor?.verified || (actor.kind !== 'user' && actor.kind !== 'device')) {
        throw new AgentMuxError('Deleting a Browser Profile requires a person or device, not a managed Agent. The Profile, its Browsers and the Agent remain available; ask the person to delete it.',
          'BROWSER_PROFILE_DELETE_REQUIRES_PERSON')
      }
      existing(ports, request.profileId)
      await ports.usage.deleteProfile(request.profileId, { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: request.profileId })
      return { operation: request.operation, revision: ports.profiles.listRevision(), profileId: request.profileId, deleted: true }
    }
  }
}
