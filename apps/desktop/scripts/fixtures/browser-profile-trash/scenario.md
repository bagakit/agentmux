# Original Profile recycling and restore

Owning behavior: [Browser workface](../../../../../docs/design/behavior/browser-workface.md).
Presentation: [Settings and observation](../../../../../docs/design/presentation/settings-and-observation.md).

Run `node apps/desktop/scripts/verify-browser-profile-trash.mjs` for native seed and a real process restart. `--seed-only` explicitly omits restart. `--admission-only` exercises the original writer/admission race, legacy credential retention and unknown write acknowledgement in one private App; it makes no restart claim.

The fixture loads the actual App Settings/Browser components, CSS, preload, trusted root-document IPC, original Profile Manager/Store, public compiled CLI and original native Sessions. It uses explicit private Runtime/State/Notes/config/socket and Electron app paths, does not override process HOME, connects no Provider/Native Run, and visits only its loopback site. Generated receipts record consumed source hashes, actual requested stages, original process identities, cleanup and PNG hashes. Capture does not grant aesthetic approval.

Seed verifies open and Core-saved use; actual service-worker, request and download use after native pages and saved references are gone; an exact GUI recycle; same original partition/configuration, encrypted credential and permission ownership; original page/cookie/localStorage and neighboring draft preservation. The fixture finishes only its own workers/requests/downloads, never claiming a production Session-wide disposal or immutable checkpoint. A new, never-opened Profile's native cookie owner is initialized explicitly; this is not an empty replacement for archived data.

Restart restores the original Core workface before native acquisition, refuses a missing retained source, then restores the exact archive to its original Profile ID with a fresh token and observes original native cookie/localStorage/IndexedDB, proxy username and permission ownership. No data is copied, moved, cleared or filtered.

Admission pauses the original archive write, attempts the actual BrowserViewManager create through trusted IPC, verifies this exact Profile is fenced while an unrelated Browser and original draft remain usable, then explicitly restores and admits the same Profile. It retains a previous-version deletion tombstone's original encrypted credential row after the same auth queue acknowledges an unrelated operation, without authorizing an unknown proxy. Its final adverse case injects owner ACK loss after a real metadata replacement; actual Core filesystem directory-sync failure and failed readback are covered by the unit suite.

The native probe's first four normal visual states and source-unavailable state are independent of its write-unconfirmed state. Review each changed visible state against its actual source receipt; do not relabel seed-only or admission-only evidence as a restart. Production mutations are separate, explicitly recorded transformed-module/native receipts; fixture bootstrap failures and a surviving mutation remain failed/unknown evidence.
