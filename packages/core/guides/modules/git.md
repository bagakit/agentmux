---
summary: "Git history/diff, native worktree observations, exact Desktop presentation and worktree closeout"
roles: "Agents inspecting repositories or closing completed worktrees"
when: "Read commits, display original repository history or close a worktree"
---

# git

<!-- amux:content -->
The Git owner reads an exact resource repository. Commits, parent-selected trees and
diff snapshots retain their original identities; a displayed history is not a checkout or
workspace mutation. Begin with global resource discovery, then preserve complete OIDs and
the returned pagination/snapshot facts through each read and presentation request.
Use git worktrees with the original Workspace/Host/path to observe main, linked and bare
worktree paths, current branches and detached HEAD without creating Zones or changing cwd.
Non-Git and unavailable are distinct; preserve the old workface and treat older observations
as historical while retrying the same exact resource. Registration names are not current branches.

Use git worktree close for product closeout after integrating the work. It gathers the
original Tabs into the same project's default workspace while retaining Session/Run and
execution cwd. workface moved confirms the saved display move; pending keeps its unfinished
responsibility visible. Read cleanup separately: pending retains unfinished cleanup responsibility;
inspect its reason for the actual directory state. removed confirms directory deletion. kept ends cleanup after Git registration has ended
and execution/file references are gone, preserving remaining user evidence with an explicit reason.
Keep the original operation ID and exact Host/path
when recovering an unknown result. Discarding Git changes never authorizes stopping a healthy
Agent or deleting its cwd.

Read amux git --help for repository/history contracts and amux git worktree close --help
for the exact closeout journey.

Use `git compare --workspace ID --host ID --workspace-path PATH --base BRANCH --target BRANCH
--mode merge-base|two-point` to obtain the original fixed branch comparison. Both branches are
exact local names from `refs/heads`, never arbitrary revision expressions. `merge-base` compares
from their common ancestor; `two-point` compares the exact base and target commits. Each result
entry supplies repository-relative `path` and `origPath` (including both sides of a rename).
To read it, pass `{snapshot,file:{path,origPath}}` unchanged to `git diff --input FILE|-`.
The snapshot's Host/repository and immutable OIDs remain authoritative if branch labels move.
This calls the GUI's original Git comparison producer; it does not fetch, checkout or mutate
Git, Workspaces, Sessions or execution cwd. Ordinary Git/GitHub write workflows stay with git/gh.
