---
name: daily-brief
description: Assemble the morning brief — overnight run outcomes, anything still blocked, spend against budget, and the top thing worth doing today. Use for scheduled morning heartbeats, "what happened overnight", "brief me", or any request for a status roll-up across projects.
triggers: [brief, overnight, morning, roll-up, catch me up]
---

# daily-brief

## When to use this

A heartbeat fires this most mornings. A person also asks for it directly with
"catch me up" or "what happened overnight". Either way the output is one text
message, not a report.

## Steps

1. Run `scripts/collect.mjs` — it reads the Switchboard event log directly and
   returns JSON: runs since the cutoff, failures, pending confirmations, spend.
2. Read the DeerDawn board for any project that had a run, so "what to do
   today" comes from the actual backlog and not from your imagination.
3. Write the brief. Hard limits: five lines, no markdown, no preamble.

## Shape of the output

```
3 runs overnight: 2 done, 1 failed (r-8k2wq — MCP auth expired).
swb: event log + runner landed, branch switchboard/r-4m1xz.
$1.83 spent, $198 left this month.
1 thing waiting on you: r-3p0aa wants to push to origin.
Next: the intent router — it blocks the iMessage adapter.
```

## Rules

- If nothing happened, say "nothing overnight" and stop. Do not pad.
- Never report a run as successful without checking its exit status.
- Anything waiting on a human goes in the brief even if it is old.
