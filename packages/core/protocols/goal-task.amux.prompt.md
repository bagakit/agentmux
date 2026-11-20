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
Inspect the original Goal progress, evidence and gaps. Report verified status and the next responsible action with amux goal patrol report --help. Include the exact original worker report for collection within the same review operation.
~~~
