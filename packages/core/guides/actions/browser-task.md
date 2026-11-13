# browser task

<!-- amux:content -->
Create, edit, publish and run saved Browser tasks

Read `browser task source --browser <id>` for the original current demonstration's
id, browserId, revision, status and stepCount; raw recording arguments and input
values are never returned. Only stopped/interrupted sources can create a task.
Use Core `browserTaskCreateInput(source, name)` once to mint createOperationId and
proposed assetId. Save its complete JSON (also browserId, sourceRecordingId,
sourceRevision and name) before dispatching `browser task create --browser <id>
--input <file|->`. This creates a draft with unreviewed steps; it grants no page
execution or human checkpoint. The compact create receipt confirms only its original
creation binding, not a later draft revision. Unknown replies keep that exact frozen JSON:
`browser task create-inspect --browser <id> --input <same-file|->` reads the original
saved binding without writing. `unknown`/`not-found` never cancels an input or
allocates a replacement; explicitly continuing create uses the same IDs and intent.
Reusing an operation or proposed asset for another intent is a conflict.
Read `browser task draft --browser <id> --asset <id>` for one exact current definition
and revision without cumulative versions/runs. This bounded projection stays usable
when original retained history exceeds a result budget; no history is deleted.

Read `browser task assets --browser <id>` to select an existing immutable version.
To replace an existing draft, use `browser task edit --browser <id> --asset <id>
--expected-revision <n> --input <file|->` with its full draft definition. Publish
that exact saved revision with `browser task publish --browser <id> --asset <id>
--expected-revision <n>`. Both return the exact asset identity and its new revision;
publish also reports the actual immutable version number. Definitions and retained
history are read separately; they are never copied into a write receipt. All
older versions and runs remain unchanged. These actions only save definitions:
they cannot approve a human checkpoint, grant Browser access or execute a page.
On a revision conflict or unconfirmed save, read the exact draft again. A
storage failure retains the live draft with a warning; inspect before retrying.
Use `browser task reliability --browser <id> --asset <id> --version <n>` to read
retained version/run/outcome evidence. A completed script is not proof of a successful
outcome, and zero samples have no pass rate.
Run with `browser task run --browser <id> --asset <id> --version <n>`, fresh JSON
object parameters on stdin (at most 64 KiB), and optional `--run <id>` to continue
the original ready cursor. Values never enter the saved asset or durable progress.
`--step` runs one eligible step. This path cannot approve a human checkpoint or
take Browser input back from the person. `browser task stop --browser <id> --run <id>`
stops the original run while preserving its cursor.
For a bounded batch, use `browser task batch --browser <id> --asset <id> --version <n>`,
fresh stdin JSON {parameters: {...}, items: [{id: "one", parameters: {...}}]} and optional
`--batch <id>` to continue the original eligible group. Each of 1–16 unique items uses
its own original task run. Values are transient; retained item results have run identities
and statuses. Group limits are 256 operations and 120 seconds of execution.
Saved versions may also contain testing steps: `wait` (an element or URL within its
timeout), `assert` (element present/absent, URL or text), `press`, `hover`, `scroll` and `drag`. A drag step declares `target` (source) and `destination`,
each with `role`, `name`, `ordinal: 1`, `count: 1`; both are resolved from one fresh complete
snapshot of the reviewed `url`. The task editor can add and review these declarations. Changed
or ambiguous endpoints send no drag, and unknown in-flight effects are never automatically retried.
Touch steps are `tap`, `longPress`, `swipe` and `pinch`. All use a reviewed semantic
`target`; a swipe also declares `destination`. `longPress.durationMs` is positive and
uses 600 ms when absent. `pinch.scale` is positive and uses 2 when absent. The task editor
can add and review these declarations. Their immutable versions, original operations and
unknown-effect retry rules use the same task owner as other page steps.
An `upload` step names the reviewed file-input `target` and 1–4 distinct
`parameterKeys` from the version's parameter declarations. Supply each Workspace-relative
path as a fresh stdin string for this invocation. Actual files, selected-file handles,
paths and prompt values do not enter the saved definition or replay. The existing
Workspace upload owner snapshots and verifies the current FileList; an unknown assignment
is inspected, never repeated automatically. The task editor can add uploads and file bindings.
A `click` may declare `dialog: {type: "confirm", action: "accept"}` or a dismiss decision.
An accepted prompt may additionally name `promptParameterKey` for a fresh answer.
The current Desktop/Electron host does not open JavaScript prompt dialogs. Its
editor preserves portable prompt declarations; this is not a claim that they can
complete on that host. Its original task owner refuses that step before any trigger.
Read the exact target's `dialogTypes` in `browser targets`: absence means unknown,
an empty list means no native dialog answers, and a listed type grants neither
page input nor a beforeunload approval. Answering requires an actual native prompt event on a compatible host.
The original click and answer share one operation; only its observed expected type and
original document can be answered. No dialog, a different type/document, human takeover
or an unconfirmed answer stops this task without replaying the click. Leaving a page with
unsaved input still requires the person; a saved decision is not a human checkpoint approval.
Recordings preserve real triggers; dialog policies are explicitly edited and reviewed,
never inferred as a recorded human approval. Portable imports keep their declarations but
reset review and do not carry file selections or answers.
Downloads keep the existing completion declaration, for example
`{kind: "download-readable", stepId: "download-click", path: "outputs/result.bin"}`.
One reviewed click per version owns this producer: its listener is installed before the click,
and only its actual completed Workspace reference can satisfy readable-file completion.
A click cannot declare both a download producer and a dialog decision. Compose separate
steps instead. This does not create file capability on a host without a Workspace owner.

A page step may declare `retry` 0–3 and `onFail` stop, continue or goto a later step.
Only a known `script-failed` attempt that sent no page action is retried, each with its
own operation id. After continue or goto the run records `failedSteps` with the failed
operation and ends `failed`, never `completed`; stopped and unknown results are not handled.
Unknown actions or human checkpoints stop continuation; no automatic approval or replay.
`browser task batch-stop --browser <id> --batch <id>` stops preparation and current
execution while preserving original progress. This does not reclaim human input.
