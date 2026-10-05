# Git reading surfaces: ordinary private Desktop

Run only after a coherent Core/Git/Desktop build of one clean committed candidate:

```sh
node apps/desktop/scripts/verify-git-workbench.mjs --candidate FULL_COMMIT_SHA
```

The script resolves the shared repository from `git-common-dir`. Every round is unique under that repository's `.bagakit/feature-tracker/git-reading-surfaces/native-*`; its private home, userData, runtime and real Git fixture live in a `private/` child removed in `finally`. A unique `/tmp/amx-gr-*/p` symlink to that child shortens macOS socket addresses; the final Runtime directory remains real for Core's owner check, and cleanup verifies the target before removing only its own alias. It neither opens the user's installed App nor accesses their profile, Sessions or repositories. No Store mutation, replacement bridge or storage seed is used.

The production chain is actual built Main/preload/Renderer → original Git owner → real Git, with actual mouse, keyboard and wheel input, public `git.commit`/`git.diff`/`git.open`, and real `packages/core/bin/amux git open` with and without `--oid`. Source/compiled/loaded-script hashes and native plus document visibility/focus are recorded. Native window visibility and actual document visibility/focus are required; OS foreground focus is diagnostic, while successful control hits and committed input prove operation. The delivery owner separately binds the coherent build to the exact candidate; Renderer release shell identity alone does not prove Renderer source compilation.

Scenes:

- Click a sidebar subject: independent fixed commit details, full message/all parents, no embedded History; long subject/path at normal dark and measured narrow light Region.
- Select a file: readonly Monaco appears within that same Region, without adding Regions. Attempted input and every UI/public read preserve fixture HEAD, index and exact dirty-file bytes.
- Explicit repository History: no implicit first selection; one main History plus sidebar summary. Preserve range/pages/scroll through expand/return; a larger viewport may prefetch further along the same snapshot.
- Actual wheel prefetch happens before the original loaded edge. The observed DOM rows/SVG nodes are windowed and drawn edges match real parent OIDs. CPU/render-isolation claims require the separate actual-owner qualification.
- Locate an unread root commit: locating alone does not drain pages; each explicit `Read next history page` is bounded. Once loaded, the actual older row appears inside the virtual viewport. A one-commit reference proves an outside-range target keeps the selected fixed details and current filter.
- Explicitly open a separate Diff, move its Tab with the real menu, quit normally and move fixture refs. Relaunch the same private profile: original Region/resource/selection/file/history range/layout persist, inline and separate Diff still read the original fixed OID.

Theme is a controlled presentation input; the App, Git data, Monaco and ordinary restart are real. This scene does not qualify installed-package identity, remote Git transport or Agent recovery. A behavioral `passed` receipt does not sign aesthetics. Independent reviewers must open every final full PNG, identify concrete issues, and require recapture after candidate changes, following [the visual review guide](../../../../../docs/guides/agent-visual-e2e-review.md).

Contracts: [Git behavior](../../../../../docs/design/behavior/files-and-git.md#git-源码控制与-pr), [Git presentation](../../../../../docs/design/presentation/files-and-git.md#git-工作面与渐进详情). Failures retain their round and use only the tracked private-process cleanup owner.
