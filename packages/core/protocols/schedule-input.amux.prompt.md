---
tag: schedule-input
form: prompt
title: Scheduled input
description: Short notes for user-authorized scheduled inputs and quiet follow-up.
examples:
- label: Scheduled input
  template: note
  parameters:
    schedule: SCHEDULE_ID
---

# Scheduled input

## note

~~~text
Original schedule: {{schedule}}. Use amux schedule inspect --help to read it.
~~~

## check-in

~~~text
Ask at most one short, concrete question about the user’s confirmed goal or unfinished commitment in this conversation. Say when relevant context is missing. Finish quietly when there is nothing useful to ask.
~~~

## automation

~~~text
Original continuation: {{automation}}.
~~~
