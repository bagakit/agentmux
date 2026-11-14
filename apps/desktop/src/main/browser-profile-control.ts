import { queryBrowserProfiles, AgentMuxError, isBrowserProfileControlOperation, type AgentMuxControlRequest, type AgentMuxControlResult, type AgentMuxNameActor,
  type BrowserProfileControlOperation } from '@agentmux/core/control'
import { ZodError } from 'zod'
import type { BrowserProfileBookmarkOpen } from './browser-profile-bookmark-open.js'
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
  profiles: Pick<BrowserProfileManager, 'networkHistory' | 'listProxies' | 'saveProxy' | 'deleteProxy' | 'assignProxy' | 'initialize' | 'listProfiles' | 'listRevision' | 'listSequence' | 'createProfile' | 'copyProfile' | 'updateProfile' | 'listViews' | 'saveView' | 'deleteView' | 'bulkUpdate' | 'listFolders' | 'createFolder' | 'renameFolder' | 'deleteFolder' | 'setDefaultProfile' | 'refresh' | 'listTrash' | 'listLegacyPendingDeletes' | 'restoreProfile' | 'setTrashRetention' | 'purgeProfile' | 'inspectTrashPurge'> & { extensions?: BrowserProfileManager['extensions']; bookmarks?: BrowserProfileManager['bookmarks']; cookieFiles?:BrowserProfileManager['cookieFiles'] }
  usage: Pick<BrowserProfileUsageOwner, 'usage' | 'deleteProfile' | 'assertUnused'>
  openBookmark?: (request: BrowserProfileBookmarkOpen, url: string) => Promise<void>
  network: BrowserProfileNetworkControl
}

function cookieFileOwner(ports:BrowserProfileControlPorts):BrowserProfileManager['cookieFiles']{
  if(!ports.profiles.cookieFiles)throw new AgentMuxError('Cookie file exchange is unavailable in this Browser host. Original Profiles remain available.','HOST_CAPABILITY_UNAVAILABLE')
  return ports.profiles.cookieFiles
}

function bookmarkOwner(ports: BrowserProfileControlPorts): BrowserProfileManager['bookmarks'] {
  if (!ports.profiles.bookmarks) throw new AgentMuxError('Bookmark management is unavailable in this Browser host. Original Profiles remain available.', 'HOST_CAPABILITY_UNAVAILABLE')
  return ports.profiles.bookmarks
}

function extensionOwner(ports: BrowserProfileControlPorts): BrowserProfileManager['extensions'] {
  if (!ports.profiles.extensions) throw new AgentMuxError('Extension management is unavailable in this Browser host. Original Profiles remain available.', 'HOST_CAPABILITY_UNAVAILABLE')
  return ports.profiles.extensions
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
  if (request.operation === 'browser.profile.proxy.ls' || request.operation === 'browser.profile.ls' || request.operation === 'browser.profile.inspect' || request.operation === 'browser.profile.trash.ls') await ports.profiles.refresh()
  switch (request.operation) {
    case 'browser.profile.cookie-file.prepare-import':return {operation:request.operation,review:await cookieFileOwner(ports).prepareImport(request.profileId,request.operationId,request.source,request.scope)}
    case 'browser.profile.cookie-file.import':return {operation:request.operation,receipt:await cookieFileOwner(ports).import(request.profileId,request.reviewId)}
    case 'browser.profile.cookie-file.export':return {operation:request.operation,receipt:await cookieFileOwner(ports).export(request.profileId,request.operationId,request.destination,request.scope)}
    case 'browser.profile.cookie-file.inspect':return {operation:request.operation,...await cookieFileOwner(ports).inspect(request.profileId,request.operationId,request.offset,request.limit)}
    case 'browser.profile.cookie-file.discard':return {operation:request.operation,...await cookieFileOwner(ports).discard(request.profileId,request.reviewId)}
    case 'browser.profile.cookie-file.reveal':return {operation:request.operation,...await cookieFileOwner(ports).reveal(request.profileId,request.operationId)}
    case 'browser.profile.bookmark.ls': return { operation: request.operation, ...await bookmarkOwner(ports).list(request.profileId, request.folderId, request.operationId) }
    case 'browser.profile.bookmark.edit': return { operation: request.operation, ...await bookmarkOwner(ports).edit(request.profileId, request.expectedRevision, request.operationId, request.change) }
    case 'browser.profile.bookmark.import': return { operation: request.operation, ...await bookmarkOwner(ports).import(request.profileId, request.folderId, request.expectedRevision, request.operationId, request.sourcePath) }
    case 'browser.profile.bookmark.export': return { operation: request.operation, ...await bookmarkOwner(ports).export(request.profileId, request.folderId, request.expectedRevision, request.operationId, request.destinationPath) }
    case 'browser.profile.bookmark.open': {
      if (!ports.openBookmark) throw new AgentMuxError('Opening bookmarks is unavailable in this Browser host. The library is kept.', 'HOST_CAPABILITY_UNAVAILABLE')
      return { operation: request.operation, ...await bookmarkOwner(ports).open(request.profileId, request.bookmarkId, request.browserId, request.expectedRevision, request.operationId, url => ports.openBookmark!(request, url)) }
    }
    case 'browser.profile.extension.ls': return { operation: request.operation, ...await extensionOwner(ports).list(request.profileId, request.operationId) }
    case 'browser.profile.extension.prepare': return { operation: request.operation, review: await extensionOwner(ports).review(request.profileId, request.expectedRevision, request.operationId, request.sourcePath, request.extensionId) }
    case 'browser.profile.extension.apply': return { operation: request.operation, ...await extensionOwner(ports).apply(request.profileId, request.expectedRevision, request.reviewId) }
    case 'browser.profile.extension.remove': return { operation: request.operation, ...await extensionOwner(ports).remove(request.profileId, request.expectedRevision, request.extensionId, request.operationId) }
    case 'browser.profile.extension.load': return { operation: request.operation, ...await extensionOwner(ports).load(request.profileId, request.extensionId) }
    case 'browser.profile.proxy.ls': return { operation: request.operation, revision: ports.profiles.listRevision(), proxies: ports.profiles.listProxies() }
    case 'browser.profile.proxy.create': return { operation: request.operation, ...await owned(() => ports.profiles.saveProxy(request.edit)) }
    case 'browser.profile.proxy.update': return { operation: request.operation, ...await owned(() => ports.profiles.saveProxy(request.edit, request.proxyId, request.expectedRevision)) }
    case 'browser.profile.proxy.delete': return { operation: request.operation, ...await owned(() => ports.profiles.deleteProxy(request.proxyId, request.expectedRevision)) }
    case 'browser.profile.proxy.assign': {
      const results = await owned(() => ports.profiles.assignProxy(request.proxyId, request.expectedRevision, request.items))
      return { operation: request.operation, revision: ports.profiles.listRevision(), proxyId: request.proxyId, proxyRevision: request.expectedRevision, results }
    }
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
    case 'browser.profile.network.probe':
      existing(ports, request.profileId)
      return { operation: request.operation, profileId: request.profileId, ...await ports.network.probe(request.profileId, request.operationId) }
    case 'browser.profile.network.history':
      return { operation: request.operation, profileId: request.profileId, ...await ports.profiles.networkHistory(request.profileId, request.operationId, request.before) }
    case 'browser.profile.network.check':
      existing(ports, request.profileId)
      return { operation: request.operation, profileId: request.profileId, check: await ports.network.checkExit(request.profileId) }
    case 'browser.profile.folder.create': {
      const folder = await owned(() => ports.profiles.createFolder(request.label, request.expectedRevision))
      return { operation: request.operation, revision: ports.profiles.listRevision(), folder }
    }
    case 'browser.profile.folder.rename': {
      const folder = await owned(() => ports.profiles.renameFolder(request.folderId, request.label, request.expectedRevision))
      return { operation: request.operation, revision: ports.profiles.listRevision(), folder }
    }
    case 'browser.profile.folder.delete': {
      const receipt = await owned(() => ports.profiles.deleteFolder(request.folderId, request.expectedRevision))
      return { operation: request.operation, revision: ports.profiles.listRevision(), deleted: true, ...receipt }
    }
    case 'browser.profile.view.create': case 'browser.profile.view.update': {
      const receipt = await owned(() => ports.profiles.saveView(request.label, request.query, request.expectedRevision, request.operation === 'browser.profile.view.update' ? request.viewId : undefined))
      return { operation: request.operation, ...receipt }
    }
    case 'browser.profile.view.delete':
      await owned(() => ports.profiles.deleteView(request.viewId, request.expectedRevision))
      return { operation: request.operation, revision: ports.profiles.listRevision(), viewId: request.viewId, deleted: true }
    case 'browser.profile.bulk-update': {
      const results = await owned(() => ports.profiles.bulkUpdate(request.items, request.action))
      return { operation: request.operation, revision: ports.profiles.listRevision(), results }
    }
    case 'browser.profile.ls': {
      const profiles = ports.profiles.listProfiles(), folders = ports.profiles.listFolders(), views = ports.profiles.listViews()
      const view = request.viewId === undefined ? undefined : views.find(value => value.id === request.viewId)
      if (request.viewId !== undefined && !view) throw new AgentMuxError('The exact saved Profile view is unavailable. Read profile ls for current view IDs.', 'BROWSER_PROFILE_VIEW_NOT_FOUND')
      const query = view?.query ?? request.query, evaluatedAt = Date.now()
      return { operation: request.operation, revision: ports.profiles.listRevision(), sequence: ports.profiles.listSequence(),
        profiles: query === undefined ? profiles : queryBrowserProfiles(profiles, folders, query, evaluatedAt), folders, views,
        ...(query === undefined ? {} : { filter: { query, evaluatedAt, ...(view ? { viewId: view.id } : {}) } }) }
    }
    case 'browser.profile.inspect': {
      const profile = existing(ports, request.profileId)
      const revision = ports.profiles.listRevision()
      return { operation: request.operation, revision, sequence: ports.profiles.listSequence(), profile, usage: await ports.usage.usage(request.profileId) }
    }
    case 'browser.profile.trash.ls':
      return { operation: request.operation, revision: ports.profiles.listRevision(), sequence: ports.profiles.listSequence(),
        entries: ports.profiles.listTrash(), legacyPendingDeletes: ports.profiles.listLegacyPendingDeletes() }
    case 'browser.profile.trash.inspect': return { operation: request.operation, revision: ports.profiles.listRevision(), purge: await ports.profiles.inspectTrashPurge(request.purgeId) }
    case 'browser.profile.trash.retention': case 'browser.profile.trash.purge': {
      if (!actor?.verified || (actor.kind !== 'user' && actor.kind !== 'device')) throw new AgentMuxError('Permanent deletion and retention approval require the person or their device. The original Profile and data remain available.', 'BROWSER_PROFILE_DELETE_REQUIRES_PERSON')
      return request.operation === 'browser.profile.trash.retention'
        ? { operation: request.operation, ...await owned(() => ports.profiles.setTrashRetention(request.archiveId, request.expectedRevision, request.purgeId, request.deleteAfter)) }
        : { operation: request.operation, ...await owned(() => ports.profiles.purgeProfile(request.archiveId, request.expectedRevision, request.purgeId, profileId => ports.usage.assertUnused(profileId))) }
    }
    case 'browser.profile.trash.restore': {
      if (!actor?.verified || (actor.kind !== 'user' && actor.kind !== 'device')) {
        throw new AgentMuxError('Restoring a Browser Profile requires a person or device. Its original data is kept; ask the person to restore it.', 'BROWSER_PROFILE_RESTORE_REQUIRES_PERSON')
      }
      return { operation: request.operation, ...await owned(() => ports.profiles.restoreProfile(request.archiveId, request.expectedRevision, request.folderId)) }
    }
    case 'browser.profile.create': {
      const profile = await owned(() => ports.profiles.createProfile(request.label))
      return { operation: request.operation, revision: ports.profiles.listRevision(), profile }
    }
    case 'browser.profile.copy': {
      existing(ports, request.profileId)
      const profile = await owned(() => ports.profiles.copyProfile(request.profileId, request.label, request.expectedRevision))
      return { operation: request.operation, revision: ports.profiles.listRevision(), sourceProfileId: request.profileId, profile }
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
        throw new AgentMuxError('Recycling a Browser Profile requires a person or device. The Profile, its Browsers and the Agent remain available; ask the person to recycle it.',
          'BROWSER_PROFILE_DELETE_REQUIRES_PERSON')
      }
      existing(ports, request.profileId)
      const receipt = await ports.usage.deleteProfile(request.profileId, { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: request.profileId }, request.expectedRevision)
      return { operation: request.operation, ...receipt }
    }
  }
}
