# Git history navigation: ordinary private Desktop

This is the native integration harness for the Space Git tree and its fixed commit/Diff review. It uses the actual built Desktop, original Main/preload/Renderer, Store and Git owners, a real private Git repository, public CLI/RPC and trusted Chromium mouse/keyboard/wheel input. It does not control the installed user App, user profile, user Session or user Run.

## Candidate and invocation

Freeze the exact joined candidate only after the implementation slices and harness are ready:

```sh
candidate=$(git rev-parse HEAD)
source_digest=$(node apps/desktop/scripts/verify-git-workbench.mjs --print-source-digest)
node apps/desktop/scripts/verify-git-workbench.mjs --candidate "$candidate" --source-digest "$source_digest"
```

The print command only reads source and prints a SHA-256; it does not import built Core, create evidence, build or launch Electron. Its manifest includes current tracked and added source under `apps/` and `packages/`, root build/config inputs, modes and symlink targets. Generated outputs, dependencies, local evidence, caches and temporary worktrees are excluded. Adding, removing or changing a source invalidates the pin.

The first native invocation must leave `AGENTMUX_GIT_WORKBENCH_RECEIPT` unset. After that one original proof and independent visual review, an integration gate may explicitly consume its receipt without rebuilding or launching another process:

```sh
AGENTMUX_GIT_WORKBENCH_RECEIPT="$native_receipt" \
  node apps/desktop/scripts/verify-git-workbench.mjs \
  --candidate "$candidate" --source-digest "$source_digest"
```

This variable belongs only to this local proof harness, not product configuration. Consumption checks the current HEAD and complete source manifest before and after reading evidence; the original passing receipt, source manifest/diff, successful build commands/logs, compiled identities/release/actually loaded bundles, full PNG references/hashes/dimensions, two normal process exits and completed private-profile/socket cleanup must all match. Empty collections, missing or changed evidence, source drift and failed cleanup reject consumption explicitly with `fallback: disabled`; there is no implicit native retry. It prints `exactEvidenceReused: true`, `originalNativeProofRuns: 1` and `newNativeProofRuns: 0` only for the original proof. It neither writes a second proof nor signs aesthetics. The integration owner separately requires candidate-bound independent visual review and records one native execution in acceptance, not two proofs.

Keep the original qualification tree and its compiled outputs until this read-only consumption and review finish; deleting those outputs first intentionally makes receipt consumption fail. Afterward the coordinator may remove that isolated tree.

Native mode checks the explicit HEAD and source digest before building. It retains the source manifest, relevant binary tracked diff, added-source inventory, both real build commands, their logs and exit results. It actively builds `@agentmux/client-ui...` and Desktop, checks equal source around builds and both launches, and binds the compiled Main chunks, preload, Renderer release manifest and actual loaded entry/lazy JS/CSS. A changed candidate fails qualification rather than silently refreshing the pin or discarding anyone's work.

When shared main is moving, the coordinator may run the same command from an isolated verification tree of the final main candidate. Include the reviewed harness bytes in that candidate; do not substitute an old build or omit concurrent source changes from the source manifest. Native execution is deliberately separate from cheap preparation checks:

```sh
node --check apps/desktop/scripts/verify-git-workbench.mjs
node apps/desktop/scripts/fixtures/git-workbench/check-repository.mjs
node apps/desktop/scripts/fixtures/git-workbench/check-receipt.mjs
```

The repository check proves only the private Git fixture. The receipt check uses disposable synthetic evidence to exercise exact reuse and rejection paths, including a refused CLI invocation; it produces no native proof. Neither check proves product navigation, Renderer behavior, restart or aesthetics, or substitutes for native execution on the final joined candidate.

## Private ownership and evidence

Each round is unique under the shared repository's `.bagakit/feature-tracker/git-history-navigation/native-*`. The `private/` child contains its home, userData, Runtime, real repository and second worktree. All inherited AgentMux/ctxmux routing is removed. A unique short system-temporary symlink addresses macOS Unix sockets; its final Runtime parent remains real and its target is checked before removal.

The first process receives only a private authored config and real filesystem/Git inputs. No Store setter, bridge replacement or workbench storage seed manufactures a result. The second process gets the same private profile and no replacement workface. Both native userData paths and distinct PIDs are recorded. Each quit requires the original PID to exit with code zero and no signal within its recorded observation budget; cleanup kills cannot qualify recovery.

`receipt.json` preserves behavior results, input/build identities, public replies, exact spatial graph/resources, request-count observations, original Git baselines, process exits and full PNG hashes. It always leaves `aestheticReview: not-performed`: capture success does not sign aesthetics or the whole integration task. Failed rounds keep their evidence.

## Native scenes and oracles

- Preserve the existing Files + Zones / Git / Changes / Branches journey: discover two real worktree Zone bindings, open real files through public `file.open`, switch exact original workfaces and type distinct unsent commit drafts using actual input. Git history range changes must not change the execution resource or borrow the other worktree's draft. Neither draft is committed.
- `git open` without an OID opens/reuses the original repository review, reveals the exact Space/Zone and Git History tools, and does not implicitly choose a commit. There is exactly one visible tree and one range picker, permanently in Space Git. The main review contains neither a History tree nor a replacement sidebar status card.
- A sidebar row opens its commit in that same repository Region. Compare its original range, loaded pages and scroll after the initial selection. Repeated choices retain the repository Region; independently opened fixed commits and parent comparisons remain unchanged. Public `git.open` with an OID still owns independent fixed details rather than replacing repository review.
- Standard messages show the real type/scope/breaking layer, original multiline body, explicitly openable raw message, locally generated unverified author marker and actual per-parent file-change categories. Plain/root and merge messages retain their text and all parents. Literal markup remains text. Choose a merge parent through real keyboard input and verify its actual file list against that parent.
- Open files as readonly Monaco Diff inside the original Region, test an attempted edit and retain the fixture's HEAD/index/dirty bytes. Long paths remain usable. Capture the full Space chrome, sole tree, commit and Diff at normal/narrow widths in both themes; no cropped component screenshot substitutes.
- The real fixture has hundreds of local and remote references, long names and distinct local/remote main identities. References are spread over real older commits rather than inventing graph objects. Measure observed count, virtualized option count, geometry and search response conditions. Search/clear/Escape use real text and keyboard input, preserve the current range and trigger focus, and make zero original Git history/commit-detail calls. Zero matches are not an empty repository.
- The old main tip is outside the All first page. Its full reference exists in the complete observed snapshot even though its commit is unread. Confirm the searched full ref name, verify one original history call and a first bounded result containing that tip, and read the same ref through actual public RPC and `git history --ref`. No All-page drain, fetch, checkout, staging or Git mutation may implement this navigation.
- Delete only a selected private fixture ref, explicitly refresh and capture the real History failure. Keep the original Region, descriptor, fixed commit, parent and file; the fixed commit can still reload and its Diff stays readable. Restore the ref in `finally` and explicitly refresh back to the ordinary healthy state. This controlled Git fault is not an injected bridge reply or a real user failure.
- Wheel the sole tree to trigger bounded prefetch before the previous page edge. Actual visible row and SVG-node counts are windowed; drawn edges must name real Git parents. Hide History behind Changes while keeping the main review visible: the review must not start a local History reader. The explicit History header action restores the same sidebar range, pages and scroll rather than transferring a tree to the main area.
- Locate an unread root without exhausting pages automatically. Explicit next-page actions stay bounded, and the actual target must appear inside the virtual viewport. A one-commit ref distinguishes an outside-range target from an unread one; both retain fixed details and the selected range.
- Explicitly open a separate Diff and move its Tab through the actual menu. Save the nondefault Git History tool and two resource-keyed drafts through ordinary production persistence. Quit the first process, intentionally move only private fixture refs, then launch the second process. Before any navigation, compare the saved tool/view/workface/drafts and complete original spatial graph. Original Region, descriptor, scope, range, commit, parent, file, layout and independent fixed Diff must survive. Both inline and separate Diff still read the original fixed OID, not the moved tip.

## Cost observation and proof limits

Request counts come from Main V8 precise function-call coverage over the actual compiled `GitService` method bodies, including split Main chunks. No bridge wrapper or replacement Store supplies counts. Each checkpoint resets coverage; receipts retain compiled source hashes and the current observation conditions. Search timing includes input/observation overhead and is diagnostic, not a permanent machine-independent latency threshold. Native scenarios do not claim an unrelated-Session scaling benchmark or replace the owning source-mutation tests.

The fixture's staged files, indexes and tracked/dirty bytes are frozen before UI navigation and compared before and after restart. Intentional ref deletion/restoration and the post-quit tip move are separately recorded and never rebased away as an unexplained new expected result.

This harness proves private GUI workface recovery, not actual user Run survival or Provider-native conversation recovery. It does not qualify remote Git transport, installed-package identity, arbitrary reference counts or aesthetic delivery. The public fixed-commit read is `git.commit` / `git commit --oid`, not the Changes commit-write action.

Independent Kierkegaard review must actually open every final full PNG and state deliverability, concrete corrections and unknown scope according to the [visual review guide](../../../../../docs/guides/agent-visual-e2e-review.md). Candidate changes require affected scenes to be recaptured. The coordinating Agent consumes these conclusions before delivery; this script does not launch another Agent or sign its own aesthetics.

Cleanup uses only the existing private-process owner and verified temporary paths. It removes this round's private profile/repository/socket alias after processes are gone and preserves evidence. Generated `out`/`dist` stay with the candidate tree because the harness must not remove unowned builds; after consuming receipts, the coordinator removes an isolated verification tree and its private outputs. The harness does not package, install, commit, alter Feature state or remove concurrent work.

Contracts: [Git behavior](../../../../../docs/design/behavior/files-and-git.md#git-源码控制与-pr), [Git presentation](../../../../../docs/design/presentation/files-and-git.md#git-工作面与渐进详情).
