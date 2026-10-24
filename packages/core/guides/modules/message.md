---
summary: "Original Inbox messages, reference notifications, input and dispatch reports"
roles: "Agents communicating across independent Sessions"
when: "Browse original A2A messages, inspect delivery, manage pending input or report through an original dispatch"
---

# message

<!-- amux:content -->
Core owns authenticated messages, ordered delivery, inbox generations and original
dispatch threads. Use message ls --direction incoming|outgoing for bounded original metadata
and body previews; message read --message-id ID retrieves one original body, without
creating a delivery batch or advancing ack. Keep nextBeforeSequence with the same Host,
participant and direction. message read --operation-id retains original intake lookup.
Its derived inputOrigin is the exact direct input's original queue position, or null when
membership cannot be confirmed. It uses only frozen original Run facts, never the current Run;
reference-only Inbox messages have no direct input position. A notification's separate prompt-key
position belongs to message notify inspect. Missing membership does not remove
an authorized original body read or prove input dispatch, native adoption or task completion.
Add --notification-id ID to read that exact notification's metadata for the original MID
and recipient. An unassociated result keeps the original body and never substitutes the
latest notice. Notification mode is separate from the original message execution choice.
preparedAt and resultRecordedAt are original journal preparation and outcome-recording
times; null means that historical time was not recorded. submitted confirms notification
submission, never model adoption. queued delivery.at is not an Inbox-arrival timestamp.
message events reads the same original message/delivery/notification/dispatch changes from either side,
without opening bodies or consuming. Narrow by an original MID or broadcast operation when needed.
Use --latest for a bounded recent window. Preserve its exact scope, journal incarnation and
throughSequence when paging older with --before-sequence nextBeforeSequence; forward reads use
--after-sequence and nextAfterSequence. For new changes start after the prior throughSequence.
Returned events always keep original ascending order; another journal cannot inherit the old cursor.
Authenticated Agent participants and trusted users/devices may explicitly use message notify
for original MIDs in one durable recipient Session. The new notification freezes that Session's current Run once; historical envelope Runs
stay unchanged. After an unknown reply use message notify inspect --host ID --operation-id ID:
it reads the original notification and its own input receipt without preparing or sending.
The read also returns inputOrigin for exact recorded input membership (queueId, incarnation and
sequence), or null when that claim has no recorded membership. This is not the notification's
preparation position or proof of input dispatch, native adoption or task acceptance.
A null notification only means this read did not find the original notice, never permission to replay unknown input.
Managed Agents notify and inspect only references in which they are original participants,
at their authenticated Host; every selected MID must satisfy this same boundary.
These observations are not
model adoption, task acceptance or business completion.
Use message inbox check only for explicit batch consumption, and read the exact original message or
dispatch before replying. Keep operationId, messageId, source message, thread and reply
identities. Pending drafts, queued input, delivery and business reports are different states.

Discover exact Session IDs before agent broadcast; one frozen explicit recipient set is sent
once per target through the same Inbox owner. Duplicates do not repeat sends; each target has its
own stable MID/operation and independent saved, not-applied or unconfirmed outcome. After unknown,
use agent broadcast inspect with the original operation instead of rerunning discovery or changing
IDs. Broadcast does not grant steer, cross-owner authority or task ownership.

Use agent send for a new authorized cross-Session Inbox message; message read/delivery inspect and
dispatch inspect/read reconcile the original exchange. Pending edit/send/stop/archive/restore
operate one retained pending item, not a new message. Inbox acknowledgement records reading
of its exact generation and reader Run; it does not report work or complete a Goal. Dispatch
report uses the actual source/reply and kind; worker_done is a report pending collection.
Unknown/partial input remains original and cannot be blindly resent with fresh identities.

[A2A communication contract](../shared/messaging/contract.md "amux:include")
