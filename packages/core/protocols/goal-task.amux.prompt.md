---
tag: goal-task
form: prompt
title: Goal roles and requests
description: Instructions for a specific Goal role, plan or inspection.
examples:
- label: Goal roles and requests
  template: plan
---

# Goal roles and requests

## role

~~~text
Goal role: {{role}}
Known original context: {{identity}}

{{task}}

Operation details: {{entry}}
~~~

## plan

~~~text
Prepare and save the original Goal’s dependency plan. Use amux goal --skill, then goal plan append or revise --help. Include dependencies, covered criteria and repeatable checks. Clarify missing criteria with the original user, and read back the saved proposal before reporting. Plan preparation ends at review.
~~~

## patrol

~~~text
Inspect the original Goal progress, evidence and gaps. Report verified status and the next responsible action with amux goal patrol report --help. When you actually reviewed a worker result, reference its original report in that review entry.
~~~

## start-attention

~~~text
The original Goal Start Run ended before a Start-associated result was recorded. Inspect its original prompt input, Run and Goal evidence. Report the verified blocker or continue through the explicit original Goal path.
~~~

## clarify

~~~text
Clarify this existing Goal.
~~~

## inspect

~~~text
Inspect this existing Goal and its actual results.
~~~

## undefined

~~~text
This Goal still needs the user’s intended outcome and criteria. Ask what they want to achieve.
~~~

## alignment

~~~text
Propose an alignment summary, stable criterion IDs and the questions the original user needs to decide.
~~~

## grounding

~~~text
Inspect the actual work and report each criterion as met, gap or unknown with locatable evidence. Give this assessment to the user for their acceptance decision.
~~~

## discussion

~~~text
Coordinate the existing Goal {{goalId}}.

{{missing}}{{task}}

Inspect the original Goal, roles, evidence and Project references. Use amux goal inspect --help with this Goal. Preserve the original intent. End this discussion at the proposal or inspection.
~~~

## facts

~~~text
Original Goal facts:
{{facts}}
~~~

## global-patrol

~~~text
全局 Demand 巡查

{{guide}}

Original-owner scope reference (all statuses): {{scope}}

Use goal ls --all without filters or a limiting sample, then goal inspect, goal delegations and goal activity for every original Goal. Return the overview, proposals requiring confirmation and structured questions.
~~~

## project

~~~text
Project: {{name}}
Project ID: {{id}}
Host: {{host}}
Repository root: {{repository}}
Workspace ID: {{workspace}}
Workspace path: {{directory}}
{{branch}}Use this exact Project resource. The PMO’s execution directory is separate.
~~~

## project-branch

~~~text
Branch: {{branch}}
~~~

## project-unavailable

~~~text
Assigned Project ID: {{id}}
The registered Project and its workspace are unavailable.
~~~

## project-unassigned

~~~text
Project: unassigned
~~~

## delegated-work

~~~text
Read the verified envelope.application and, when assigned, the current Ticket before acting. Use goal report --input FILE with this original delegation operation to return every delegated criterion with evidence, gap or unknown. Include sourceMessageId when reporting from another Core. For a question or blocker, reply to the original source and record message dispatch report --kind question|escalation. Keep the worker report distinct from collection by the current Supervisor. See amux goal --skill for verified handoff and exact Run closeout.
~~~

## workflow-budget-unknown

~~~text
The saved Workflows budget is unconfirmed. Read the original Goal settings before any new automatic Ticket dispatch.
~~~

## continuation

~~~text
As Supervisor of original Goal {{goal}} at confirmed revision {{revision}}, use amux goal plan active --help for the current Tickets. For dispatch, verify the assigned executor and original predecessor receipts. For review, independently verify the frozen delivery and record the actual result. Reconcile unknown receipts at the original owner. When all relevant Tickets have passed, prepare the result evidence for the person’s acceptance.

{{original}}
~~~


## review-result

~~~text
Review passed for Goal {{goal}}, Ticket {{ticket}}, attempt {{attempt}}. The original executor is Session {{session}}, Run {{run}}, Host {{host}}, Runtime {{runtime}}.
Independent reviewer: give this receipt to the current Supervisor and finish your review.
Current Supervisor: verify the exact attempt, report collection and remaining work. Assign the next ready Ticket when appropriate. When the handoff is confirmed and work is finished, ask the original executor to use amux goal closeout for this exact attempt and Run.
Keep the original Run and operation if any check or receipt is unknown. An authorized person or device can use amux agent stop inspect for the exact Stop receipt. See amux goal --skill.
~~~

## report-result

~~~text
{{status}} Give the current Supervisor these original report references: {{handoff}}. Read back the handoff before checking whether you can stop your exact Run. See amux goal --skill.
~~~

## report-saved

~~~text
This Core saved your original Goal report.
~~~

## report-submission

~~~text
This Core saved your report submission. The Goal owner’s receipt and collection still need confirmation.
~~~

## collection-result

~~~text
If you remain the Goal’s Supervisor, acknowledge this saved collection to the original executor: {{handoff}}. Use the separate review and closeout receipts to check those outcomes. See amux goal --skill.
~~~
