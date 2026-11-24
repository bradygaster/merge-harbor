---
description: Run the repository assessments queued from the Merge Harbor canvas
---

Run the repository assessments the user queued with **Assess repository** in the Merge Harbor canvas.

1. Call `merge_harbor_claim_assessments`. If nothing is queued, say so and remind the user to click **Assess repository** in the canvas (`/merge-harbor:open`).
2. For each claimed mission, follow its instructions exactly. They are read-only: work in an isolated clone, don't run repository code, and make no GitHub writes.
3. Report progress and the final findings for every mission with `merge_harbor_report_repository_assessment`, using its `missionId`. If you can't finish one, report it as `failed` with the reason instead of leaving it in progress.
4. Finish with one line per repository: how many findings, and the most severe one. The user reviews findings and creates any issues themselves in the canvas.
