# Find an Agent's work

“Agent 在哪，工作在哪” describes a question a person might ask from their phone. An Agent is editing a project on a workstation. Its conversation appears in two open views. Which Agent is this, where are the files being changed, and which view will open if I continue?

This is a written interaction contract. The examples use fictional hosts, sessions and views. A host can implement the cases with any UI toolkit. A shared React location chooser is a roadmap item.

## What the host supplies

| Question | Required information |
| --- | --- |
| Which Agent am I looking at? | A stable reference to the original Agent session and the host that owns it. Two hosts can use the same local session ID. Display names can change. |
| Where is it executing, and where is the project? | The observed execution host and the resource host or project, with their own identities. They may be different machines. A path is meaningful on its owning host. Show each fact the host can confirm. |
| Where can I open its work? | The source's observation of the session's open views, its coverage and a stable reference to each exact location. A view may have several named routes into it. |
| What happens when I choose? | A navigation action scoped to the original session and chosen location. The host rechecks their current relationship and reports the result. The viewing device owns its own focus. |

Another host can use opaque handles for these subjects and locations. It needs a way to tell a completed read with zero results from an incomplete read. Keep the execution host, resource host and display location distinct even when all three happen to be local.

## Show the observation and act on a choice

Use a short location summary where people look for Agent details. Offer names that distinguish the candidates and an exact address on demand. Several routes to the same physical view count once in the summary. The chooser can expose each route with its context.

| Situation | Observable result |
| --- | --- |
| The source confirms no open views | Show zero open locations. Keep any separately available conversation or original work accessible. |
| The location read is incomplete or unavailable | Say that locations are unconfirmed. Keep an already open view and its draft available. An earlier observation can be identified as such. |
| There is one confirmed view, or an existing exact choice resolves the ambiguity | An explicit Open action can enter that view after the host revalidates it. The user can inspect other routes when available. |
| Several views match and the caller has no exact choice | Present distinguishable candidates. Browsing or cancelling leaves the current view, focus context and draft intact. A keyboard-opened chooser returns focus to its trigger on cancel. |
| The selected view moved, vanished or changed subject before activation | Keep the chooser and its context. Give a readable result and allow another selection or refresh. Opening a different view requires a new choice. |

Navigation opens the chosen view on the viewing client. On success, focus belongs to that destination. Looking up a location, opening the chooser or selecting a candidate issues **zero** session create, restart, move or stop requests. The session's execution directory continues to come from its execution owner.

## Cases an independent host can run

Use session `s7` on host `build`, project `p4` on host `files`, and a viewer on `phone`. Let `review` and `logs` be distinct exact views of `build/s7`. A fake navigation handler can record its arguments and the viewing client's destination.

| Given | When | Expected |
| --- | --- | --- |
| Both views have the display name “Review” | Open the chooser with the keyboard, then cancel | Both choices are distinguishable. Focus returns, the destination stays put, and the handler receives zero selections. |
| Both views are confirmed | Choose `logs` | The handler receives `build/s7` and the exact `logs` view once. The phone enters that view. The project still points to `files/p4`. |
| Two named routes lead to `review` | Inspect locations | The summary counts one physical view. Both routes can be identified. |
| `logs` has been rebound to `other/s7` since the chooser opened | Activate the old `logs` choice | The host rejects that choice. The chooser reports the change, and the viewer stays on its original work. |
| A completed empty list and an unavailable read arrive in separate runs | Inspect each summary | The first says zero and the second says unconfirmed. Neither changes session status. |
| The user switches to a different Agent while a prior check is pending | Deliver the prior check's success | The new Agent and its draft retain their focus context. The prior result opens no destination. |

For a narrow touch surface, open and cancel the sheet with the same cases. Check that full candidate names or addresses are available on demand. With reduced motion, the current choice, result and return path remain legible. The host chooses the shape of the panel and the wording for its audience.
