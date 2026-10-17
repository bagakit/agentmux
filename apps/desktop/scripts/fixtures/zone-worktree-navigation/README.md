# Zone / worktree navigation capture

Run from the repository root:

```sh
node apps/desktop/scripts/capture-zone-worktree-navigation.mjs
```

An optional first argument selects a new evidence directory. The default is a
unique ignored `.tmp/zone-worktree-navigation-*` directory. `receipt.json` binds
the nine owning production inputs before/after, actual compiled inputs, emitted
nonempty JS/CSS/assets, loaded bundle URLs, full-frame PNG hashes and cleanup.
Shared App/Store/Core sources are consumed directly and recorded when compiled;
they are not substituted, pinned to a shared HEAD, or a global freshness gate.
Concurrent unrelated edits do not invalidate this scoped presentation proof.

The private Electron window uses `showInactive`, not application activation.
Only the fixture profile is used. Native Chromium pointer input adjusts the real
splitter to leave the Zones directory readable; the Dock itself is exactly 300
or 236 CSS pixels wide. Full product CSS and the production Dock, Files, Zones,
Git components, catalog projection and Store focus owner are used. The only
fixture CSS sets the outer capture host size and padding.

The four initial frames cover both widths and normal dark/light themes. Further
frames show native Tab/Arrow/Home/End focus without selection, Enter/Space Zone
selection, long worktree name/branch/path, a plain folder, a retained unknown
Zone, nested Home with its own directory, Manage worktrees entering Git/Branches,
the unbound-branch create form, and Changes targeting the selected worktree.
The create form is opened and closed, never submitted. Navigation is never
performed with a DOM setter or a fixture Store action. Environmental setup and
theme selection are explicitly fixture-controlled.

The module-derived logical fixture paths, Git status/branch/worktree reads and file directory reads
are controlled observations, not real filesystem/Git/Runtime evidence. No live
Agent, Main/preload, installation, process restart or durable recovery claim is
made. Original Tabs/Regions and unsent drafts exist in the real Store fixture.
Unknown is not converted to a plain folder or clean Git status. Every queried
retained Git control is filtered for actual visibility.
Zone metadata consumes the typed `git.worktrees` observation with explicit main/linked
paths, branch/detached facts and alias arrays; it does not read saved Workspace branch
labels as current checkout. This controlled projection does not prove native Git aliases.

Capture success is not visual approval. Give the complete PNG set and original
receipt to an independent reviewer; review corrected scenes again after changes.

The official task gate runs the mutation command once:

```sh
node apps/desktop/scripts/verify-zone-worktree-navigation-mutations.mjs
```

It uses the existing complete-source-copy runner without altering its baseline,
RED/GREEN or sourceBefore/sourceAfter/copyAfter guards. The guarded proof inputs
are these nine production files plus the actual consumer tests/helpers/config.
The real shared Store and App are copied normally, not replaced or unnecessarily
included in the final drift guard. Three private mutants target authoritative
kind, arrow-focus-only behavior and the current-resource Changes summary. Their
oracles are the owning `workspace-zones` / `space-git-tools` consumer tests, not
new simulated assertions. Do not duplicate the full mutation run before the gate.
