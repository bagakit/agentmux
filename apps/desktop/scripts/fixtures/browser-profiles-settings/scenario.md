# Browser Profiles visual scene

Real `SettingsPanel` → Browser Profiles over the web-preview Profile owner.

- Contract: [Browser 工作面](../../../../../docs/design/behavior/browser-workface.md), [Settings 资源库与编辑](../../../../../docs/design/presentation/settings-and-observation.md).
- Preview data: four Profiles (Personal as default, Northwind client with notes, QA de-DE, Release review); Northwind client is used by one open and one not-yet-loaded Browser.
- Frames: default and client editors in dark, the identity hue picker, inline rename, the client editor and its ⋯ menu in light, and the narrow list/editor round trip in both themes.
- Boundary: capture only. Edits stay in the preview owner; Main persistence, the delete guard and the public commands are proved by their owning tests. No user data, Core, PTY or Run is touched.

Run from the repository root: `node apps/desktop/scripts/capture-browser-profiles-settings.mjs`. The command prints the private evidence directory; open each PNG for review.
