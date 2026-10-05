# Latest Region intent through a delayed save acknowledgement

Run from the repository root:

```sh
node apps/desktop/scripts/verify-spatial-continuity.mjs
```

The fixture loads the original `App`, store, workbench pointer handlers and
`DesktopSpatialPersistence`. It reuses the Topics restart fixture's controlled
file metadata and first-process-only seed: two original file Tabs, three
Regions, a 62% split, an unsaved file edit, a composer draft and an explicitly
expanded Files panel. A private real Core spatial-state file and Chromium
profile are shared only between the two processes of the same candidate.

After draining the initial save, native pointer input selects Region B. Core
commits B and emits its normal change event; only the IPC response to that first
commit is held. Native pointer input then returns to A before the response is
released. The original quit-time persistence flush is a completion barrier, not
a navigation repair or a delay between the two selections. The store observer
records every change of the Tab's active Region and the retained selection.

The first build replaces the actual owner's pending-aware comparison with the
previous confirmed-state-only comparison. It must fail at the latest-A
assertion after the response arrives, with B both in the Tab layout and the Core
file. Its retained selection can still be A, so a static highlight alone does
not prove this divergence. The unchanged candidate must retain A throughout the
post-response trace, with its selection and durable layout in agreement and all
original identities, drafts and topology preserved.

The first candidate process then exits. A distinct second Electron process
loads the same private files through the original initialization path, without
seeding. It must restore the same A, Tabs, Regions, selection, split ratio,
unsaved file, composer draft and explicit Files preference. Markdown preview
mode is transient; the restored source editor shows the original document.

Receipts bind loaded source, build assets, process identities, input/response
ordering, state assertions, full-frame PNGs and process cleanup. The images
require independent review. This is a File Region persistence check; it makes
no claim about Agent Session or Run recovery, or unknown commit outcomes.
