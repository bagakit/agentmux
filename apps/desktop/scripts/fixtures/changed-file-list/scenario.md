# Changed file list visual scene

The real `GitCommitDetails` and its `ChangedFileList`, compiled with preview data.

- Context: the commit details reading surface of [Git 源码控制与 PR](../../../../../docs/design/behavior/files-and-git.md#git-源码控制与-pr). The list keeps every file of one fixed read available, mounts only the rows near the viewport and shows a path filter from 12 files; those rules live in `ChangedFileList.tsx` and its tests.
- Preview data: one commit with 5001 files (5000 glyphs across four folders, about one in seven modified, and one rename), and a three-file commit that stays below the filter threshold.
- Frames: the large commit at the top in dark, then with one row hovered beside the selected (open) row, scrolled to the middle in dark, filtered by a path that only the rename's old path contains, a filter with no match, the top in light at a narrow width with and without a hovered row, and the small commit in dark and light narrow. The pointer is parked outside the list for every other frame, so no row is hovered by accident. The receipt records the mounted row counts and the filter count.
- Boundary: capture only. Reading the commit from Git and the list's mounting rules are proved by `apps/desktop/test/git-commit-workbench.test.tsx`. No user data, Git repository, Core, PTY or Run is touched.

Run from the repository root: `node apps/desktop/scripts/capture-changed-file-list.mjs`. The command prints the private evidence directory under `.tmp/`; open each PNG for review.
