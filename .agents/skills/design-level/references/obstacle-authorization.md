# Special-mechanic authorization

The authorization ledger is deny-by-default. Queue effects, grid effects, dish effects, combined or linked groups, timed customers, staff, bosses, and shippers are special mechanics with failure modes, not generic difficulty knobs.

An explicit brief requirement authorizes only the named mechanic and scope. It does not authorize adjacent effects. Broad difficulty adjectives authorize none.

When ordinary tuning cannot meet the brief:

1. Gather evidence from validation, estimates, and instant playtests.
2. Call `propose_obstacle_options`.
3. Present a small choice set with expected impact and risks.
4. Wait for the designer's explicit approval.
5. Record only the approved mechanic through `amend_session_requirements`.
6. Add it granularly, then revalidate reachability and difficulty.

If approval is declined, continue ordinary tuning or report the closest attainable result. Never infer approval from silence or difficulty wording.
