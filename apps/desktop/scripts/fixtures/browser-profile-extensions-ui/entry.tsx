import '../browser-profiles-settings/entry'
import { api } from '../../../src/renderer/src/lib/api'
import type { BrowserProfileExtension, BrowserProfileExtensionReview } from '@agentmux/core/control'
// Real Profile editor with deterministic package facts for visual review only. The separate native
// fixture proves the public CLI/Main/Session path; this page cannot approve or execute any package.
const source = { kind: 'zip' as const, label: 'ZIP package', homepage: 'https://project.example.test/', updateUrl: 'https://updates.example.test/form-helper.xml', signature: 'not-verified' as const }
const permissions = { api: ['storage'], hosts: ['https://forms.example.test/*'], contentScripts: ['1:match:https://forms.example.test/*', '1:frames:top', '1:about-blank:false', '1:origin-fallback:false'], optional: [], fileAccess: false as const }
const extension: BrowserProfileExtension = { id: 'visual-extension', nativeId: 'abcdefghijklmnopabcdefghijklmnop', name: 'Form helper', version: '1.4.0', sha256: 'b'.repeat(64), source, permissions, application: { state: 'loaded' } }
const failed: BrowserProfileExtension = { ...extension, id: 'visual-failed', name: 'Reading companion', version: '0.9.2', source: { ...source, label: 'Unpacked extension', kind: 'directory' }, application: { state: 'failed', reason: 'The host could not load this approved package. Its original files and Profile data remain; use Load to retry.' } }
const receipt = { prepares: 0, applies: 0, loaded: 0, removes: 0 }
api.browser.listProfileExtensions = async profileId => ({ profileId, profileRevision: (await api.browser.readProfiles()).profiles.find(item => item.id === profileId)!.revision, extensions: [extension, failed], pending: [{ operationId: 'original-unconfirmed-removal', profileId, extensionId: failed.id, kind: 'remove', sha256: failed.sha256, version: failed.version, expectedRevision: 'original-review-revision', previousSha256: failed.sha256, nativeId: failed.nativeId }] })
api.ui.chooseFiles = async () => ['/visual-only/form-helper-2.0.0.zip']
api.browser.prepareProfileExtension = async (profileId, expectedRevision, reviewId, _source, extensionId) => { receipt.prepares++; return { profileId, expectedRevision, reviewId, extensionId: extensionId ?? extension.id, name: extension.name, version: '2.0.0', previousVersion: '1.4.0', sha256: 'c'.repeat(64), source: { ...source, label: 'ZIP package' }, permissions: { ...permissions, api: ['storage', 'tabs'] }, addedPermissions: ['API: tabs'] } satisfies BrowserProfileExtensionReview }
api.browser.applyProfileExtension = async profileId => { receipt.applies++; return { profileId, profileRevision: (await api.browser.readProfiles()).profiles.find(item => item.id === profileId)!.revision, outcome: 'cancelled', receipt: null } }
api.browser.loadProfileExtension = async (profileId, extensionId) => { receipt.loaded++; return { profileId, extensionId, application: { state: 'failed', reason: failed.application.reason } } }
Object.assign(window, { extensionsVisual: { receipt } })
