---
tag: amux:capsule-answer
form: envelope
title: Page answer
description: A confirmed answer to one Capsule page question, with its original page and question IDs. The trusted
  confirmation and input receipt, not this text, establish the human source.
examples:
- label: Confirmed page answer
  template: wire
  parameters:
    json: '{"capsuleId":"Kd7mQ2xRb9Wp","interactionId":"Q4nT8vHc2Jzs","question":"Which icon?","answer":"B, with a
      lighter shadow"}'
---

# Page answer

## wire

~~~text
<amux:capsule-answer version="1">
{{json}}
</amux:capsule-answer>
~~~
