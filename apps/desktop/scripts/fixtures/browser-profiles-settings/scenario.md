# Browser Profiles visual scene

Real `SettingsPanel` → Browser Profiles over the web-preview Profile owner.

- Contract: [Browser 工作面](../../../../../docs/design/behavior/browser-workface.md), [Settings 资源库与编辑](../../../../../docs/design/presentation/settings-and-observation.md).
- Preview data: four Profiles (Personal as default with three sites holding sign-ins, Northwind client with notes and Agents turned off, QA de-DE, Release review); Northwind client is used by one open and one not-yet-loaded Browser. Agent browser automation is on globally.
- Frames: default and client editors in dark, the default Profile's sites with one in-row clear confirmation, the client editor with Agents turned off, the identity hue picker, inline rename, the client editor and its ⋯ menu in light, and the narrow list/editor round trip in both themes. Network frames show a real route draft, its explicit Apply, the saved proxy, the proxy sign-in form and a preview exit result. Toolbar frames mount the actual `BrowserPane` with its Profile chip and switcher at normal and narrow widths.
- Candidate: `source.json` records the checked-out commit and hashes of the owning Profile components, styles and fixture inputs; an input changing during capture leaves the result unconfirmed. These source hashes supplement the screenshots; they do not sign aesthetics.
- Boundary: capture only. Edits stay in the preview owner; injected proxy-sign-in read failure and reconnect failure demonstrate unknown status with explicit Retry, and saved credentials with an outstanding connection refresh, without touching a keychain or network. Main persistence, the delete guard and the public commands are proved by their owning tests. No user data, Core, PTY or Run is touched.

Run from the repository root: `node apps/desktop/scripts/capture-browser-profiles-settings.mjs`. The command prints the private evidence directory; open each PNG for review.

For the proxy authentication service-notice scene, add `--service-notice`. This bounded scene mounts the real `BrowserPane` with a preview `activity.warning` naming the original Profile, a non-sensitive keychain failure and the Settings → Browser Profiles recovery path. It captures normal dark and narrow light layouts and operates Dismiss; the warning's actual auth-owner → Main snapshot/public projection is proved separately by T018. The existing Profile settings frames and their unchanged source-bound review remain separate evidence; this scene does not reopen their completed Tasks.
