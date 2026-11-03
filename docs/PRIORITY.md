# How Nova scores priority

Deterministic, local, no model. Every input is a field Brightspace already returns to Nova through the allowlisted routes, or a derivation from those fields. Lives in `packages/planner`.

```
score = round(clamp(urgency + stakes + weight + momentum + crunch + effort, 0, 100))
```

| Component | Range | Rule | Brightspace field |
|---|---|---|---|
| Urgency | 0 to 50 | 50 when overdue (within the two-week window the Focus tab shows). Otherwise 40 shrinking linearly to 0 over the next 168 hours. | `DueDate` |
| Stakes | 0 to 20 | Base 6 for an assignment, 8 for a quiz. Quiz: timed +4, password or address restricted +4, one attempt +4, unlimited attempts −4. Assignment: group +3, rubric attached +2. | `SubmissionTimeLimit`, `Password`, `RestrictIPAddressRange`, `AttemptsAllowed`, `DropboxType`, `Assessment.Rubrics` |
| Weight | 0 to 15 | Percentile of points possible among the open items of the same course, times 15, when three or more have known points. Otherwise absolute: 100 or more points 10, 50 or more 7, 20 or more 4, fewer 2, unknown 3. | `Assessment.ScoreDenominator` |
| Momentum | 0 to 10 | Overdue with the availability end date still ahead 10 (a late submission is still possible). A saved draft that was never submitted 5. | `Availability.EndDate`, `mysubmissions` status 2 |
| Crunch | 0 to 10 | 4 for each other open item due within 24 hours of this one, capped. | derived |
| Effort | 0 to 10 | Only when a duration is known: 10 × hours ÷ max(hours left ÷ 4, 1), capped. A timed quiz supplies its time limit. | `SubmissionTimeLimit.TimeLimitValue` |

Excluded from ranking: submitted and completed items, hidden and expired items, long overdue items (more than 14 days), items the student marked done on the device, and the student's own Week tab deadlines.

## How the score is read

- A band in words: 70 and up "Do this first", 45 to 69 "Start soon", 20 to 44 "On the radar", below 20 "Can wait".
- The hero shows the top item and its two strongest reasons. The details panel shows up to three reasons, a one-sentence reading of the score ("Top of the list at 74 out of 100: overdue by 1 day and still unfinished; worth 50 points, one of the bigger items in this course; overdue, but still open for a late submission."), and a breakdown of every component against its maximum.
- Baseline reasons (a plain assignment or quiz, points not shared by Brightspace) only appear when nothing stronger exists.

## Other signals read from the same responses

- Earned scores: `mysubmissions` carries `Feedback.Score` once an assignment is graded. Nova shows it in the item details ("36 of 40"), sends it to Ask Nova as `earnedScore`, and reports a score arriving or changing as a "Graded" change. A withdrawn score is not reported. Quiz scores are not available through the allowlisted routes.
- Submission type: an assignment handed in on paper or observed in person may never be marked submitted in Brightspace; the details say so instead of showing a stale "Not started".
- Late allowed: whether a quiz accepts late attempts, kept on the item for later use.

## Not used until verified on the Villanova tenant

Class submission counts (`TotalUsersWithSubmissions`) and `Access.LastAccessed` are present in the response shapes but it is not known whether a learner role receives real values. Grade items, weights, and course grades need the grades routes, which are not on the allowlist.
