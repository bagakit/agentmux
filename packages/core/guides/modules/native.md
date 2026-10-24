---
summary: "Exact native OS observation, images, clipboard and typed input"
roles: "Authorized operators of the connected Host"
when: "Observe OS apps/windows/displays, capture the screen, use the clipboard or perform authorized native actions"
---

# native

<!-- amux:content -->
The AgentMux native layer owns OS app/window discovery, AX references, system images,
clipboard and typed input. It does not own Agent Sessions, Runs, PTYs or Browser page
navigation. Read `amux native ACTION --help` for this version’s exact inputs.

Start with `amux native capabilities --data FILE|-` and `{ "hostId": "EXACT_HOST" }`.
Keep the returned native instanceId. Use apps list and displays list with that instance,
then windows list using the exact target `{pid,processStartedAt}`. Window observations
and actions also require the original windowId. These OS identities cannot be inferred
from a title, tree label, application name or Bundle display string. Querying does not
activate/recover a window or grant system permission. Snapshot defaults to AX-only.
Use explicit capture with an operationId for system pixels; Browser screenshots stay
with their original page source and do not require OS recording permission.

Keep snapshotId and each returned element index with its original native instance,
process birth and window. Secondary AX actions use the returned machine action names.
native action accepts only its registered typed actions, never arbitrary code or shell.
Input and clipboard text preserve whitespace and Unicode. Clipboard write never means
paste. A failed request retains the original draft and clipboard where still available;
permission preflight is an observation, not proof of an operation’s cause or eligibility.

Every mutation requires an original operationId. A response is not proof that a click
or key achieved the requested effect: read its native verification. Timeout/disconnection
leaves an unknown outcome. Inspect that exact original operation and instance; do not
automatically replay it. Inspection does not start a replacement process. Retained results
have finite bounds; an expired/unavailable receipt never proves the action did not happen.
System permission UI is reserved for the actual person. Missing native support affects
this capability only; existing Agents, workfaces and Browser capture remain available.
The present macOS Desktop implementation owns only its local Host. A hostId does not
discover a remote implementation or authorize substituting this computer for another.
Other hosts must supply their own explicit native port.
