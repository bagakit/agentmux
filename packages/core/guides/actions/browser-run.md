# browser run

<!-- amux:content -->
Run a program in an open Browser

[browser targets](../actions/browser-targets.md "amux:include")

Usage:
  amux browser run --browser <browser-id> [--operation-id <operation-id>] < program.js
  echo 'return await snapshot()' | amux browser run --browser <browser-id>
  amux browser history [--browser <browser-id>]
  amux browser inspect --operation-id <operation-id>
  amux browser stop --operation-id <operation-id>
  amux browser replay --browser <browser-id> --operation-id <operation-id> [--preview | --step <n> | --run]

The program is read from stdin as a whole — there is no --code flag, because a real program
contains quotes, backslashes and newlines that every shell layer would re-escape.

It runs as an async function body in an isolated subprocess, so `await` and `return` both
work, and a runaway program cannot take AgentMux down with it. Page functions ([Current browser-capability-examples](../../dist/browser-page-capability.js "amux:generated browser-capability-examples"), …)
are injected into that subprocess. The current capability registry exposes:
[Current browser-capability-directory](../../dist/browser-page-capability.js "amux:generated browser-capability-directory")
Elements are addressed by the refs a snapshot hands you — never coordinates.
`snapshot(options)` and `snapshotText(options)` accept `scope: "page"|"viewport"`,
`within` (a unique CSS region in the main document), `withinRef` (an issued ref's actual document),
`interactiveOnly`, and `maxNodes` (default 200, maximum 1000). Use either within or withinRef.
Observation counts distinguish the full captured graph, scoped/matched nodes and returned nodes.
Omitted documents are excluded by scope; missingFrames are failed reads. A small response does
not mean fewer AX trees were captured. Each call replaces the prior snapshot, including snapshotText;
use its newest refs. Superseded refs in the same run are refused rather than retargeted.

A ref outlives the run that issued it: refs from an earlier `browser run`, even from before
AgentMux restarted, are matched back onto the page by what they pointed at (role, name, and
which one of the same-named). That match is by appearance, not identity — it can land on a
different element that looks the same — so a run that used one is reported `indeterminate`
with the details, not `completed`.

Requires Agent browser automation to be enabled in Settings › Browser. It is off by default,
and the refusal says so rather than failing quietly.

Every receipt also includes an `operation` object with one stable operation id, the operator identity,
ordered semantic steps, and a replay reference. Keep that id when refining a program: it is the join key
for the Browser activity timeline, the desktop operation journal, and later replay. Raw passwords, cookies,
page text, coordinates, and opaque JavaScript/CDP arguments are never stored in replay facts; sensitive
steps remain explicit review gates.

That id only arrives with the final receipt, which is too late to ask about a program still
running. Pass `--operation-id <id>` to choose it yourself, and it is addressable from the moment
the program starts: `amux browser inspect --operation-id <id>` says how it is going, and
`amux browser stop --operation-id <id>` stops it. Neither needs the same connection, the same
process, or the Browser id — the operation, not the request, is what those two address, so a
disconnect does not take the operation with it. Asking about an id we have no record of is a
successful answer of nothing, not a failure; stopping one that has already finished answers
with its existing outcome.

During an embedded Agent program, confirmed native input isolation keeps ordinary human click,
hover, wheel, key/IME, paste and drop out of the webpage; these gestures never take control.
Host navigation and execution Viewport changes require explicit Take control. Reading activity,
editing an address draft and messaging the operator remain available. Isolation preparation or
failure is reported separately; unconfirmed isolation is never a claim that input is blocked.
Program completion and Stop end execution while retaining Agent control and input isolation.
Only explicit Take control hands the embedded page to the person and fences future actions
on the original operation; Chromium actions already dispatched may still complete. Inspect the
original receipt and page rather than replaying unknown effects. A subsequent `browser run`
returns BROWSER_HUMAN_CONTROL_ACTIVE after human takeover until the person explicitly chooses Return to Agent.
Return restores Agent control and isolation only; it never resumes or replays the old program. There is no public
CLI return/approval flag: an Agent cannot impersonate that human handoff.

Large JSON return values become a durable `browser-result-artifact` reference (8 MiB per value,
64 MiB retained store). Small values up to 128 KiB, including undefined/null, return inline.
Keep the original reference; its Workspace, Browser, operation and source must stay intact.
Use `return await readResult(reference, {offset: 0, maxBytes: 65536})` in this Browser to read
base64 bytes, totalBytes and nextOffset. Join decoded bytes then parse JSON. A navigation or
restart does not require rerunning the original actions. Each read stays bounded; missing or
evicted results are explicit. A Browser without a verified Workspace still runs small scripts;
durable result capture is unavailable. If capture fails, actions may already have happened:
inspect the page and do not automatically rerun the script.

For binary files, use `return await download(ref, {path: "report.bin", timeoutMs: 30000})`.
The native listener is registered before the current ref is clicked. Only a completed transfer
published into this Browser's verified Workspace returns a `browser-download-file` reference;
cancelled/failed receipts have no file reference. Retain the original reference and use
`return await readDownload(reference, {offset: 0, maxBytes: 65536})` to read base64 bytes,
revision, totalBytes and nextOffset without triggering the download again. Navigation and
ordinary application restart preserve completed references. Read cost also reports the complete
bounded file scan used to verify its revision. Unknown Workspace binding is explicit; a failed
transfer never fabricates a Workspace file or blocks later healthy Browser programs.

Use `return await uploadFiles(ref, ["attachments/report.bin"])` on an actual file input from
this run's latest `snapshot()`. Upload refs are never recovered from an earlier run's ledger;
expired refs and a changed document require a fresh snapshot. The verified Workspace supplies
1–4 bounded files (16 MiB each); their exact bytes are pinned before assignment and the actual
FileList is verified. The receipt contains relative paths, names, byte counts and revisions.
Selected-file snapshots remain available after script completion until that Browser navigates
or closes. If assignment or acknowledgement is uncertain, inspect the original input and do
not automatically repeat it. File chooser dialogs are unsupported; select the actual input.

The receipt carries `result` (whatever the program returned), `logs` (everything it printed,
including on failure), and `outcome`, which is one of four:
  completed      the program finished
  script-failed  the program threw — fix the program
  stopped        we cut it off — the program is fine. Either its scale is (too slow, too much
                 output), or a person took the page back mid-run. Actions before that point
                 did happen; nothing after did. Run it again once the page is free.
  indeterminate  WHAT ACTUALLY HAPPENED IS UNKNOWN, for a reason the message names:
                 the process died partway (an action may already have been applied once), or a
                 ref from an earlier run was matched back by appearance and may have landed on a
                 look-alike, or the actions ran but their result could not be retained.
                 Look at the page before retrying — do not blind-retry.
