const policy = 'apps/desktop/src/main/browser-session-permissions.ts'
const hid = 'apps/desktop/src/main/browser-webauthn-access.ts'
export const clipboardPermissionMutations = [
  { name: 'old-write-denial', path: policy, edits: [["permission === 'clipboard-sanitized-write' ? owns(contents)", "permission === 'clipboard-sanitized-write' ? false"]], expected: 'allows only current owned Chromium clipboard write' },
  { name: 'clipboard-read-granted', path: policy, edits: [["permission === 'clipboard-sanitized-write' ? owns(contents)", "(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') ? owns(contents)"]], expected: 'denies clipboard read, unrelated permissions' },
  { name: 'write-request-denied', path: policy, edits: [["callback(permission === 'clipboard-sanitized-write' && owns(contents))", 'callback(false)']], expected: 'allows only current owned Chromium clipboard write' },
  { name: 'contents-owner-ignored', path: policy, edits: [['[...created.registrations.keys()].filter(owner => owner.ownsContents(contents)).length === 1', 'created.registrations.size > 0']], expected: 'denies clipboard read, unrelated permissions' },
  { name: 'session-identity-ignored', path: policy, edits: [[' || contents.session !== session', '']], expected: 'Session identity is mandatory' },
  { name: 'hid-origin-ignored', path: hid, edits: [['trustedOrigin(securityOrigin)', 'true']], expected: 'uses actual requesting securityOrigin' },
  { name: 'hid-device-ignored', path: hid, edits: [[' && fidoDevice(details.device)', '']], expected: 'device policy requires hid' },
  { name: 'registration-released-early', path: policy, edits: [['if (--originalRegistration.references > 0) return', 'originalRegistration.references--']], expected: 'reference counts one Session slot set' },
  { name: 'original-slot-not-released', path: policy, edits: [['session.setPermissionCheckHandler(null)', 'void 0']], expected: 'reference counts one Session slot set' },
  { name: 'stale-hid-owner-allowed', path: policy, edits: [["permission === 'hid' && sessions.get(session) === created &&", "permission === 'hid' &&"]], expected: 'reference counts one Session slot set' },
  { name: 'browser-manager-owner-unplugged', path: 'apps/desktop/src/main/browser-view-manager.ts', edits: [[`const releaseAccess = registerBrowserSessionPermissions(session, {
        ownsContents: contents => {
          const entry = this.entriesByContents.get(contents)
          return !!entry && this.owns(entry, entry.view) && entry.view.webContents === contents
        },
        resolveHidOwner: resolveOwner
      })`, 'const releaseAccess = () => {}']], expected: '真实 BrowserViewManager.create → Session event' }
]
