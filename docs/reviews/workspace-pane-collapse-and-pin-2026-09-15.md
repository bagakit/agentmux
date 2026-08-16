# Workspace pane: full Explorer collapse, and pinning a Topic or Branch

Date: 2026-09-15
Scope: two user-requested UI capabilities in the workspace content slot and the left rail.
Status: approved for implementation.

## 1. What was asked

1. The Explorer inside the content slot should collapse completely, leaving only Topics
   (Scratch) or Branches (Project). Scratch defaults to collapsed; a Project defaults to
   expanded.
2. A Topic or Branch can be pinned. A pinned item sorts first inside its own list, and also
   appears as a child node under the Scratch / owning Project entry in the left rail, at a
   smaller type size.

## 2. Findings that constrain the design

### 2.1 Scratch is an id, not a kind

`WorkspaceKind` is `'folder' | 'worktree'` — that axis describes **disk backing**, and Scratch
is itself a `kind: 'folder'` record. The discriminator is `isScratchWorkspaceId(id)`
(`apps/desktop/src/shared/contracts.ts`), comparing against the single reserved
`SCRATCH_WORKSPACE_ID`. Keying the per-kind collapse default off `workspace.kind` would be a
defect: every plain folder project would inherit Scratch's default.

### 2.2 Two defaults break the established "store only deviations" idiom

`collapsedProjectGroups` carries an explicit design rule in `store.ts`: persist only the
collapsed set, because absence must mean the default, and storing the *other* side would
require registering every newly discovered group or it silently gets the wrong state.

That idiom assumes **one** global default. This feature has two (Scratch collapsed, Project
expanded), so a single collapsed-set cannot encode it. The resolution keeps the spirit of the
rule while admitting the second default:

- the slice stores the user's **explicit override**, so both `true` and `false` are values;
- **absence means "use this workspace's kind default"**, resolved through
  `contentSlotPresentation`, never means "expanded".

A workspace the user has never touched therefore needs no registration and is still born with
the right state — which is the property the original rule existed to protect.

### 2.3 The per-kind branch point already exists and is pure

`contentSlotPresentation(isScratch)` in `apps/desktop/src/renderer/src/lib/surface-tool-dock.ts`
already answers "how does this slot present in Scratch vs a Project" and is unit-tested without
rendering. The collapse default belongs there as one more field, not as a second `isScratch`
test somewhere in the component. One question, one place that answers it.

### 2.3.1 Collapsed means no split, not a collapsed panel

`react-resizable-panels` offers `collapsible` / `collapsedSize`, which would put the collapse
state inside the panel library as well as in the store — two sources for one fact, and the
library's copy is the one that survives a remount with its own persistence.

With the Explorer collapsed there is nothing left to split: one pane occupies the whole slot.
So the collapsed branch renders the Explorer header plus a full-height Topics / Branches
directly, with no `PanelGroup` at all. The store stays the only place that knows, and the dead
draggable handle the acceptance criterion warns about cannot exist because the handle is not
rendered.

`FileExplorer` has exactly one render site, and it is `WorkspaceFilesTool` — the same component
that will own the collapse state. The toggle therefore lives in `WorkspaceFilesTool`, which
simply does not render `<FileExplorer>` when collapsed and shows a header stub in its place. No
collapse prop is threaded into `FileExplorer`, which has ~20 dependent modules and no business
knowing whether something outside it decided to hide it.

### 2.4 Pin scope differs between the two item types, and getting it wrong is silent

- A Topic id (`<kind>:<slug>`) is unique inside the one Scratch workspace.
- A **branch name is unique only within a repository.** Two projects can both have `main`.

So pins key by scope: `SCRATCH_WORKSPACE_ID` for Topics, `workspaceProjectId(workspace)` —
which is `[hostId, repoPath]`, and therefore correctly spans a repo's worktrees — for Branches.
A global set of branch names would appear to work in single-project testing and cross-pin in
real use. This gets an explicit two-project test rather than a comment.

### 2.5 One pin concept, one slice

Topic pin and Branch pin are the same idea instantiated twice: a set of ids within a scope. A
single `pinnedItems: Record<scopeKey, string[]>` means the left rail reads one thing instead of
unioning two parallel slices — and a third pinnable kind later costs a scope key, not a slice.

### 2.6 Pinned-first ordering must not destroy the orderings it sits on top of

Both lists already have a meaningful order that pinning must survive intact:

- Topics: the user's drag order (`orderTopics`), which is a stated *preference over* disk order.
- Branches: the server's ordering, split into `Worktrees` / `Without worktree` groups.

Pinning is therefore a **partition**, not a sort: pinned first, relative order preserved inside
both partitions, applied *within* each branch group. Promoting a worktree-less branch into the
`Worktrees` group would make that heading lie, so the partition stays inside the group.

### 2.7 The left rail has no child-node slot today

Nesting in `WorkspaceSidebar` is currently *faked*: sibling rows carry a `--rail-depth` custom
property. Pinned children are new markup either way; the choice between reusing `--rail-depth`
and introducing real children is recorded at implementation time rather than assumed here.

Two traps noted: the Scratch row already renders a decorative `<Pin>` badge meaning "this
workspace is pinned", which is a different concept and must not read as the same control; and
the rail must render pinned branches from the pin list alone — introducing a per-project branch
fetch into the rail would buy nothing and cost a load per project.

Reading the markup settles the choice rather than leaving it open. `.project-rail-entry` is a
flex **row** (icon, the row button, a trailing activity element), not a container that can hold
a child list — so a pinned child cannot nest inside it. `.project-rail-row` already indents from
a `--rail-depth` custom property, where the row reports a *level* and the stylesheet owns the
pixels.

Pinned children therefore follow the mechanism already in the file: sibling entries emitted
after their parent, carrying `--rail-depth` one level deeper, at a smaller type size. This keeps
one indent mechanism in the rail instead of two, and inherits the existing depth clamp for free.
The cost is accepted and stated: depth is visual, so a pinned child is a sibling in the DOM and
the parent/child relation is not conveyed structurally — the same trade the rail already makes
for nested projects.

## 3. Structural prerequisite

`SurfaceToolDock.tsx` is 1084 lines holding five unrelated components, of which
`WorkspaceTopicsPanel` plus its row component is ~300. Feature 2 edits that cluster, and a
concurrent change is in flight elsewhere in the same file. Extracting the Topics panel to its
own file is therefore done first, as a pure behaviour-preserving move: it both reduces the file
and moves the feature work out of the contended one.

## 4. Verification posture

Each feature ends with a mutation run rather than a green suite. The named mutations are the
ways these two features rot silently:

- collapse: flipping the Scratch default; making absence mean expanded instead of the kind
  default; dropping the slice from `partialize`.
- pin: dropping the scope from the branch key so names go global; reshuffling the unpinned
  partition; resurrecting a pinned id whose Topic is gone; dropping the slice from `partialize`.

A mutation that stays green is the finding, not a footnote.
