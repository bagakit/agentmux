import { browserPageCapabilityNames } from './browser-page-capability.js'

const capabilityExamples = () => (['observe', 'act', 'wait'] as const)
  .flatMap(effect => browserPageCapabilityNames(effect).slice(0, 1)).map(name => `\`${name}\``).join(', ')

export const AGENTMUX_BROWSER_TASK_GUIDE = `Read and run saved Browser task versions

Read \`browser task assets --browser <id>\` to select an existing immutable version.
Use \`browser task reliability --browser <id> --asset <id> --version <n>\` to read
retained version/run/outcome evidence. A completed script is not proof of a successful
outcome, and zero samples have no pass rate.
Run with \`browser task run --browser <id> --asset <id> --version <n>\`, fresh JSON
object parameters on stdin (at most 64 KiB), and optional \`--run <id>\` to continue
the original ready cursor. Values never enter the saved asset or durable progress.
\`--step\` runs one eligible step. This path cannot approve a human checkpoint or
take Browser input back from the person. \`browser task stop --browser <id> --run <id>\`
stops the original run while preserving its cursor.
For a bounded batch, use \`browser task batch --browser <id> --asset <id> --version <n>\`,
fresh stdin JSON {parameters: {...}, items: [{id: "one", parameters: {...}}]} and optional
\`--batch <id>\` to continue the original eligible group. Each of 1–16 unique items uses
its own original task run. Values are transient; retained item results have run identities
and statuses. Group limits are 256 operations and 120 seconds of execution.
Unknown actions or human checkpoints stop continuation; no automatic approval or replay.
\`browser task batch-stop --browser <id> --batch <id>\` stops preparation and current
execution while preserving original progress. This does not reclaim human input.`

/** Original Browser program contract; command spelling follows the object surface. */
export const AGENTMUX_BROWSER_PROGRAM_GUIDE = `Run a program in an open Browser

Usage:
  agentmux browser run --browser <browser-id> [--operation-id <operation-id>] < program.js
  echo 'return await snapshot()' | agentmux browser run --browser <browser-id>
  agentmux browser history [--browser <browser-id>]
  agentmux browser inspect --operation-id <operation-id>
  agentmux browser stop --operation-id <operation-id>
  agentmux browser replay --browser <browser-id> --operation-id <operation-id> [--preview | --step <n> | --run]

The program is read from stdin as a whole — there is no --code flag, because a real program
contains quotes, backslashes and newlines that every shell layer would re-escape.

It runs as an async function body in an isolated subprocess, so \`await\` and \`return\` both
work, and a runaway program cannot take AgentMux down with it. Page functions (${capabilityExamples()}, …)
are injected into that subprocess; \`agentmux --skill\` lists them.
Elements are addressed by the refs a snapshot hands you — never coordinates.
\`snapshot(options)\` and \`snapshotText(options)\` accept \`scope: "page"|"viewport"\`,
\`within\` (a unique CSS region in the main document), \`withinRef\` (an issued ref's actual document),
\`interactiveOnly\`, and \`maxNodes\` (default 200, maximum 1000). Use either within or withinRef.
Observation counts distinguish the full captured graph, scoped/matched nodes and returned nodes.
Omitted documents are excluded by scope; missingFrames are failed reads. A small response does
not mean fewer AX trees were captured. Each call replaces the prior snapshot, including snapshotText;
use its newest refs. Superseded refs in the same run are refused rather than retargeted.

A ref outlives the run that issued it: refs from an earlier \`browser run\`, even from before
AgentMux restarted, are matched back onto the page by what they pointed at (role, name, and
which one of the same-named). That match is by appearance, not identity — it can land on a
different element that looks the same — so a run that used one is reported \`indeterminate\`
with the details, not \`completed\`.

Requires Agent browser automation to be enabled in Settings › Browser. It is off by default,
and the refusal says so rather than failing quietly.

Every receipt also includes an \`operation\` object with one stable operation id, the operator identity,
ordered semantic steps, and a replay reference. Keep that id when refining a program: it is the join key
for the Browser activity timeline, the desktop operation journal, and later replay. Raw passwords, cookies,
page text, coordinates, and opaque JavaScript/CDP arguments are never stored in replay facts; sensitive
steps remain explicit review gates.

That id only arrives with the final receipt, which is too late to ask about a program still
running. Pass \`--operation-id <id>\` to choose it yourself, and it is addressable from the moment
the program starts: \`agentmux browser inspect --operation-id <id>\` says how it is going, and
\`agentmux browser stop --operation-id <id>\` stops it. Neither needs the same connection, the same
process, or the Browser id — the operation, not the request, is what those two address, so a
disconnect does not take the operation with it. Asking about an id we have no record of is a
successful answer of nothing, not a failure; stopping one that has already finished answers
with its existing outcome.

A person can take the page back at any time: a real click, keypress or scroll on that Browser
hands ownership to them mid-run. Actions (click, fillInput, gotoUrl, js, cdp, …) are refused
from that moment on; observation (snapshot, pageInfo, waitFor…) keeps working so the program
can see where it left things. The page carries a badge while a program is driving it, and the
Tab it sits in is marked too, so the takeover is a deliberate act, not a surprise — they can
see which Browser you are in without switching to it. A subsequent \`browser run\` stays refused
until the person explicitly chooses Return to Agent (or an equivalent handoff control).

Large JSON return values become a durable \`browser-result-artifact\` reference (8 MiB per value,
64 MiB retained store). Small values up to 128 KiB, including undefined/null, return inline.
Keep the original reference; its Workspace, Browser, operation and source must stay intact.
Use \`return await readResult(reference, {offset: 0, maxBytes: 65536})\` in this Browser to read
base64 bytes, totalBytes and nextOffset. Join decoded bytes then parse JSON. A navigation or
restart does not require rerunning the original actions. Each read stays bounded; missing or
evicted results are explicit. A Browser without a verified Workspace still runs small scripts;
durable result capture is unavailable. If capture fails, actions may already have happened:
inspect the page and do not automatically rerun the script.

For binary files, use \`return await download(ref, {path: "report.bin", timeoutMs: 30000})\`.
The native listener is registered before the current ref is clicked. Only a completed transfer
published into this Browser's verified Workspace returns a \`browser-download-file\` reference;
cancelled/failed receipts have no file reference. Retain the original reference and use
\`return await readDownload(reference, {offset: 0, maxBytes: 65536})\` to read base64 bytes,
revision, totalBytes and nextOffset without triggering the download again. Navigation and
ordinary application restart preserve completed references. Read cost also reports the complete
bounded file scan used to verify its revision. Unknown Workspace binding is explicit; a failed
transfer never fabricates a Workspace file or blocks later healthy Browser programs.

Use \`return await uploadFiles(ref, ["attachments/report.bin"])\` on an actual file input from
this run's latest \`snapshot()\`. Upload refs are never recovered from an earlier run's ledger;
expired refs and a changed document require a fresh snapshot. The verified Workspace supplies
1–4 bounded files (16 MiB each); their exact bytes are pinned before assignment and the actual
FileList is verified. The receipt contains relative paths, names, byte counts and revisions.
Selected-file snapshots remain available after script completion until that Browser navigates
or closes. If assignment or acknowledgement is uncertain, inspect the original input and do
not automatically repeat it. File chooser dialogs are unsupported; select the actual input.

The receipt carries \`result\` (whatever the program returned), \`logs\` (everything it printed,
including on failure), and \`outcome\`, which is one of four:
  completed      the program finished
  script-failed  the program threw — fix the program
  stopped        we cut it off — the program is fine. Either its scale is (too slow, too much
                 output), or a person took the page back mid-run. Actions before that point
                 did happen; nothing after did. Run it again once the page is free.
  indeterminate  WHAT ACTUALLY HAPPENED IS UNKNOWN, for a reason the message names:
                 the process died partway (an action may already have been applied once), or a
                 ref from an earlier run was matched back by appearance and may have landed on a
                 look-alike, or the actions ran but their result could not be retained.
                 Look at the page before retrying — do not blind-retry.`
