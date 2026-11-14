# Read while work continues

An Agent can add records while someone reads an earlier answer. Give each open reading viewport its own follow and history-reading state. Use the original record and its position in that viewport to retain the reader's passage.

| The host supplies | The view owns |
| --- | --- |
| The original conversation reference, ordered records and the evidence for each available page. | The visible location, follow intent, reading anchor, selection, focus and disclosure. |
| Bounded requests for earlier and newer records with outcomes tied to the exact conversation and request. | Which eligible action or reading gesture requests a page, and which original passage remains in view when it arrives. |

When a reader is following, newly presented tail content stays in view. Moving up into history leaves follow mode. Content growth and layout restoration can change the distance to the tail on their own. Treat those changes as geometry. When newer content is available, give the reader an explicit return to the current tail. Scrolling back to the tail can resume follow on the same loaded current page.

Before replacing the displayed window, check whether the incoming records retain the original visible passage. Reuse stable record and placement identity. Measure the viewport when a candidate could displace the passage. A prepend should retain the original passage at its prior viewport offset. Keep a retained text range, focused control and expanded details attached to their originals. If a replacement would discard the active passage, retain the accepted window until navigation or a reading change releases it.

Report a failed page read alongside the available conversation and its original retry action. A view that changes subject or stops reading discards late results for its superseded request. Two viewports can show the same conversation at independent positions.

## Cases an independent host can run

Use an ordered conversation with records `opening`, `answer` and `next`. Give `answer` a detail control and enough text for a multi-line selection.

| Given | When | Expected |
| --- | --- | --- |
| The reader is following at the tail | Append a record or grow the final answer | The readable tail remains in view. |
| The reader scrolled up to `answer` | Append `next` | The original passage stays in place and a return action is available. |
| Part of `answer` is selected or one of its controls has focus | Insert an earlier page containing `opening` | The same passage stays in view and the selection or focus stays on `answer`. |
| The earlier request failed | Read the error, then retry | The confirmed conversation remains available. Retry targets the same conversation and page. |
| The reader explicitly returns to the current tail | A prior history request answers afterward | The reader stays on the latest accepted page. |
| Two reading views show the same conversation | Scroll one into history | The other still follows the live tail. |

Use enough actual rendered history to measure scroll and layout work while appending. Repeat on the same host under the same input and viewport conditions. Check the original outcome before comparing costs.
