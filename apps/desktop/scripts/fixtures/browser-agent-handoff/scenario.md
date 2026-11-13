# Browser collaborator handoff proof

Run from the repository root:

```sh
node apps/desktop/scripts/verify-browser-agent-handoff.mjs --output .tmp/browser-agent-handoff/review
```

Without `--output`, the command first checks the local derived
`.tmp/browser-agent-handoff/latest-green.json` pointer. It reuses evidence only
when the original successful proof, both process receipts, saved-state copies,
reviewed PNGs, independent approved review and every source input hash still
match. An explicit `--output` always performs a fresh isolated observation. A
capture alone does not publish an approved review; the independent reviewer
binds the completed review to the successful proof before publishing this local
pointer. These receipts and reviews remain local process evidence.

The driver bundles current workspace sources. It launches two private Electron
processes, uses the production sandbox preload, Main IPC, BrowserViewManager,
RuntimeController, Renderer Store and BrowserPane, and invokes the actual public
CLI against the private Desktop endpoint. Test-owned Core Sessions use the
repository fake Codex CLI over real ctxmux; no upstream model is contacted. The
user's App, workface, Sessions and Runs are not operated.

The owning behavior and presentation contracts are
[Browser workface](../../../../../docs/design/behavior/browser-workface.md) and
[Browser workface presentation](../../../../../docs/design/presentation/browser-workface.md).
The scenario checks these concrete transitions:

1. Start with no Agent Region in the original Browser's Tab, then one confirmed
   existing Agent. Use the actual Browser toolbar to give the page to A without
   creating a Session. Before handoff, open the real creation options, enter an
   unsent task, choose a placement and close. Preserve this utility draft through
   the original Launcher persistence owner without creating another Agent.
2. Enter an opinion draft addressed to A. Run B's permitted Browser program
   through its real authenticated CLI. While B is waiting, inspect that same
   original operation ID and verify actual operator B, persistent association A
   and the public service explanation. Stop that same in-flight operation through
   the CLI and retain Agent control and A's association until explicit takeover.
3. Take control and select B from the actual activity menu. Reject a stale body
   expecting A while retaining B. Inspect the published target through the CLI.
   Operation ID, actual operator and warning retain their history; the operation
   control field reports current host-owned input facts.
4. Capture the normal dark state and narrow light states. Save the actual Store
   draft and Core spatial workface.
5. Exit the first App process without retiring the test Sessions. The second App
   process reads the same original saved files and exact Session/Run identities;
   it does not seed another Tab, Region, layout, association or draft. Check the
   original Browser identity, B association, A draft, unsent creation options and
   loadable saved URL.
6. After proving recovery, append a separate test-owned Browser and Tab. Use its
   real options and submit the selected Executor, below placement and authored
   task. Check the actual third Core Session and Region, its execution resource,
   original creation request, first message identity and Core input receipt.
   Recheck that same creation request without another Session or duplicate task.
   The original Browser remains linked to B and its old opinion still addresses A.

`receipt.json` binds source hashes and phase receipts. Each phase includes exact
trusted IPC inputs and actual CLI JSON. Root Renderer screenshots and native
WebContentsView screenshots are separate original captures with recorded native
geometry; they are not a synthesized OS screenshot. They do not establish OS
composition, physical input, an installed package or the user's original page.
An independent Agent must open the complete relevant PNGs and record its visual
judgment before treating the captures as visual acceptance. The driver itself
records `independentVisualReview: "not-performed"`.

The driver retains its bounded private source bundles and proof data for review.
Failed or completed attempts may be removed after the exact test-owned processes
are confirmed ended and necessary receipts are preserved.
