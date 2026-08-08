/**
 * The one place a git path crosses between the two coordinate systems this app uses.
 *
 * There are exactly two, and they are not interchangeable:
 *   - **repo-root-relative** — what porcelain emits. `status()` runs git at the working-tree root, so
 *     every `GitFileChange.path` is relative to that root, and the write verbs (`stage` / `unstage` /
 *     `discard`) take the same coordinate back.
 *   - **workspace-relative** — what everything the user points at uses: the file tree's node paths,
 *     `files.read` / `files.observe`, `openFile`, the document key, the editor tab identity.
 *
 * They coincide only when the workspace IS the repository root. A workspace that is a subfolder of its
 * repo makes them differ by `repoRelativePrefix`, and every symptom of confusing them is silent: a
 * change lands on the wrong tree node, or a diff is drawn for a same-named file somewhere else in the
 * repo. Nothing errors, because both coordinates are well-formed relative paths.
 *
 * So the conversion lives here once and is exported, rather than being written at each site that needs
 * it (记忆 two-resolutions-that-happen-to-agree: two independent derivations of one fact agree until
 * the day they don't, and the divergence is invisible). Today two sites need it — the file-tree status
 * projection and the Changes panel's "open this row's diff" — and they must not each carry a copy.
 *
 * The prefix itself always comes from `GitStatusResult.repoRelativePrefix`, which main got by asking
 * git (`rev-parse --show-prefix`). It is never recomputed by comparing `repoPath` against the
 * workspace path: those two strings can diverge at any ancestor segment (git canonicalizes symlinks
 * and disk case, a configured path does not), and a failed comparison yields `''` — which is also the
 * legitimate "same directory" value, so the failure would be indistinguishable from success (#740).
 */

/**
 * `repoRelativePrefix` as a slash-terminated prefix ready for comparison, or `''` at the repo root.
 *
 * Normalising the trailing slash HERE rather than at each caller is what makes `''` (root) and
 * `'app/desktop'` and `'app/desktop/'` all behave the same. The terminating slash is load-bearing for
 * the containment test below: without it the prefix `app/desk` would match `app/desktop-old/x.ts`.
 */
function terminatedPrefix(repoRelativePrefix: string): string {
  const bare = repoRelativePrefix.replace(/\/+$/u, '')
  return bare ? `${bare}/` : ''
}

/**
 * Re-express a repo-root-relative git path as a workspace-relative one, or `null` when it names
 * nothing this workspace can show.
 *
 * `null` is returned for the two genuinely different "not here" cases, deliberately folded together
 * because callers owe the user the same answer for both — this workspace has no such file:
 *   - the path is outside the workspace subtree (a change elsewhere in the repo; `status` is
 *     repo-wide, so this is the common case for a subfolder workspace, not an edge case);
 *   - the path IS the workspace directory itself, which is not a file in the tree. Git can name it:
 *     a dirty gitlink arrives as the bare directory path, and an untracked directory arrives with a
 *     trailing slash. Both would strip to the empty string, and an empty key is not a node.
 *
 * Callers must handle `null` rather than falling back to the raw path: the raw path resolved against
 * the workspace root is precisely the wrong-file read this module exists to prevent.
 */
export function workspaceRelativeGitPath(
  repoRelativePath: string,
  repoRelativePrefix: string
): string | null {
  const prefix = terminatedPrefix(repoRelativePrefix)
  if (prefix && !repoRelativePath.startsWith(prefix)) return null
  const stripped = prefix ? repoRelativePath.slice(prefix.length) : repoRelativePath
  // Git marks a directory-shaped entry with a trailing slash (`?? untracked/`); no path the tree or
  // the editor holds ever carries one, so it is normalised away before the value leaves this module.
  const path = stripped.replace(/\/+$/u, '')
  return path === '' ? null : path
}
