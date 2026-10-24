import { createRoot } from 'react-dom/client'
import { mountThemeRuntime, updateThemeSelection, GRAPHITE_THEME, themeValue } from '@agentmux/client-ui/theme'
import type { SettingsPageId } from '../../../src/renderer/src/components/settings/settings-catalog'
import '../../../src/renderer/src/monaco'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { resolveUserProfile } from '../../../src/shared/user-profile'
import { fixturePath, fixtureEpoch } from '../../../../../test/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'

const calls: unknown[] = []
const host = { id: 'preview-ssh', kind: 'ssh' as const, label: 'Build server', hostname: 'build.invalid', runtimeId: 'original-runtime' }
const tool = { id: 'actions-preview', mode: 'tui' as const, revision: 'original-command', name: 'Workspace shell', icon: 'terminal', enabled: true, statusBar: 'icon' as const, workspacePath: fixturePath('toolkit'), script: '', args: [] }
const originalSave = api.config.save
const base = await api.config.get()
await originalSave({ ...base, hosts: [base.hosts[0]!, host], workspaces: [{ id: 'preview-workspace', name: 'Workspace', hostId: 'local', path: fixturePath('workspace'), kind: 'folder' }], profile: { ...resolveUserProfile(undefined), displayName: 'Workspace author', about: 'Build useful tools with clear interactions.', avatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=' }, appearance: { ...base.appearance, customThemes: { 'custom.action-study': { ...themeValue(GRAPHITE_THEME), name: 'Action study' } } }, toolkit: { tools: [tool] } }, base)
let saveResult: ((failure: boolean) => void) | undefined
api.config.save = async (next, expected) => {
  calls.push({ method: 'config.save', profile: next.profile })
  await new Promise<void>((resolve, reject) => { saveResult = failure => failure ? reject(new Error('Save unavailable. Your draft is retained.')) : resolve() })
  return originalSave(next, expected)
}
const candidate = { digest: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), protocolVersion: 22 }
const expected = { targetDigest: 'c'.repeat(64), runtimeId: host.runtimeId, ownerInstanceId: 'original-owner', processId: 100, startTicks: '123', candidateDigest: candidate.digest, nativeInstanceId: 'native-owner', nativeProcessId: 101, nativeStartTicks: '456' }
let finishCheck: (() => void) | undefined, holdCheck = false
api.hosts.upgradeCheck = async input => { calls.push({ method: 'hosts.upgradeCheck', input }); if (holdCheck) await new Promise<void>(resolve => { finishCheck = resolve }); return { input, eligible: true, reason: 'ready', candidate, expected } }
let finishUpgrade: (() => void) | undefined
api.hosts.upgrade = async (input, expected, operationId) => {
  calls.push({ method: 'hosts.upgrade', input, expected, operationId })
  await new Promise<void>(resolve => { finishUpgrade = resolve })
  return { input, expected, operationId, status: 'completed', stage: 'completed', updatedAt: fixtureEpoch(2) }
}
api.ui.requestStorageFlush = async () => {}
api.ui.writeClipboardText = async text => { calls.push({ method: 'clipboard', text }) }
api.toolkit.get = async () => ({ schema: 'agentmux.toolkit.v1', kind: 'script', toolId: tool.id, definition: tool, state: 'idle', reason: null, consumerCount: 0, sequence: 1, latestConfirmed: null, admission: null })
api.toolkit.observe = (_id, listener) => { void api.toolkit.get(tool.id).then(listener); return { dispose() {} } }
let revoked = false
api.deviceManagement.ls = async () => ({ hostId: 'local', devices: revoked ? [] : [{ deviceId: 'preview-phone', name: 'Personal phone', createdAt: fixtureEpoch(1), keyFingerprint: 'preview-key-fingerprint', online: false }], mobileAccess: { state: 'connected', message: 'Private controlled service' } })
api.deviceManagement.revoke = async input => { calls.push({ method: 'device.revoke', input }); revoked = true; return { hostId: 'local', device: { deviceId: input.deviceId, name: 'Personal phone', createdAt: fixtureEpoch(1), revokedAt: fixtureEpoch(2) } } }
api.connections.hostingTarget = async () => ({ hostId: 'local', runtimeId: 'preview-runtime' })
api.connections.call = async method => { calls.push({ method }); throw new Error('Private preview transport is unavailable. Existing configuration is kept.') }
await useAppStore.getState().initialize()
mountThemeRuntime(window, { appAppearance: 'dark' })
const root = createRoot(document.getElementById('root')!)
function open(section: SettingsPageId) {
  root.render(<SettingsPanel onClose={() => {}} initialSection={section} toolId={tool.id} navigationRequest={section === 'hosts' ? { section: 'hosts', hostId: host.id } : undefined} />)
}
open('profile')
Object.assign(window, { buttonsScene: { ready: true, calls, open, theme: (mode: 'dark' | 'light') => updateThemeSelection({ appAppearance: mode }), finishSave: (failure: boolean) => saveResult?.(failure), finishUpgrade: () => finishUpgrade?.(), finishCheck: () => { holdCheck = false; finishCheck?.() }, holdCheck: () => { holdCheck = true } } })
