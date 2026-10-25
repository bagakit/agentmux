---
summary: "Civil-time arrangements, one-shot countdowns and original lifecycle"
roles: "Authorized scheduling operators"
when: "Inspect, create, pause, resume or cancel a scheduled task"
---

# schedule

<!-- amux:content -->
The scheduler owns schedule identity, timing, lifecycle and original run references.
Reading this module creates no schedule or periodic Loop. Begin with schedule list/inspect
and retain the exact schedule ID, current revision and requested trigger.
Use schedule list --data <FILE|-> with {"scope":{"hostId":"EXACT_HOST","workspacePath":"EXACT_WORKSPACE"}}
to read saved calendar arrangements, one-shot countdowns and repeating messages across discussions at that exact Host and
execution directory. scope and the complete target selector are mutually exclusive. A scope is a read
filter; it does not change any arrangement target or grant control authority. Keep each original Session.
The SDK schedule-calendar projection can show rule estimates in a finite visible window; those estimates
are not saved inputs, delivery receipts or authority to send. Create within the
user's authorization and original target. A finite own-task check may support already-authorized
work; it does not authorize recurring greetings, external actions or a background reflection loop.

Use schedule create --data <FILE|-> with the exact target {hostId,agentSessionId,providerId,
workspacePath}, original prompt and operationId. Choose exactly one timing form:
- calendar: an explicit civil-time once/daily/weekly/monthly/yearly rule with its timezone and policies.
- afterMs: a positive safe integer in milliseconds, for example 90000 for 90 seconds or 300000 for
  five minutes. This is a one-shot countdown, not a recurring interval. It cannot enable checkIn.
- everyMs: a whole number of minutes in milliseconds, at least 60000, for recurring messages.
  The first due time anchors the cadence; older missed occurrences collapse to the latest eligible one.
  An occupied or unready Agent retains its due occurrence; an unknown receipt keeps the original operation.
  It cannot enable checkIn.

Read amux schedule create --help for the complete current schema. The first creation of the original
operation fixes nextCheckAt as its absolute deadline. Repeating the same operationId, restarting the owner
or pausing and resuming keeps that deadline. Pause suspends delivery, not time; resuming an overdue
countdown processes the original occurrence. One confirmed input delivery ends a countdown.
The connected Host must be running; App exit, sleep or offline delivery is not promised. Busy
Agents, user input and permission waits keep the original occurrence pending.

Inspect the current help for supported triggers and complete input. Pause/resume/cancel
change the exact schedule; they do not stop unrelated healthy Agents or accept its results.
Creation/activation, a timer firing, input delivery and completed business work are separate.
Inspect original schedule facts after an unknown result rather than making a duplicate.
Unavailable scheduler observations retain original schedules, Sessions and requests; report
the failed read and the same-owner recovery action. Goal supervision does not itself authorize
installing a recurring patrol, new task ledger or automatic resend.
