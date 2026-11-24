---
description: Open the Merge Harbor canvas (optionally at overview, convoy, watchtower, or decisions)
argument-hint: "[view]"
---

Open the Merge Harbor canvas.

1. Call `merge_harbor_open_canvas`. If the user gave a view (`$ARGUMENTS`), pass it as `view`: one of `overview`, `convoy` (PR flow), `watchtower` (Needs attention), or `decisions`.
2. Give the user the URL it returns. If you have a built-in browser or browser-pane tool, open the URL there as well.
3. Mention that assessments they queue from the page start when they run `/merge-harbor:assess`.
