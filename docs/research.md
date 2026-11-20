# Background research — GTA VI trophy rarity forecast

Findings from primary sources (live Exophase page, Exophase forums, PSNProfiles, Kwak 2022, trophy guides), gathered 20 Nov 2026. Numbers marked "not found" were not found — they are not estimates.

## 1. The trophy list (55)

1 platinum (`Vice Got a Price!`), 2 gold (`A Long Road` — 100% completion; `You Gotta Know When to Get Off` — final mission), 6 silver, 46 bronze; 28 hidden; no online trophies. 5 chapters, 93 main missions. The case file itself carries each trophy's name, description, tier, points and secret flag — the program reads those from the case, it does not hard-code this list.

Sources: https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/ ; https://insider-gaming.com/complete-gta-6-trophy-list-how-to-get-all-trophies-achievements/ ; https://www.trueachievements.com/game/Grand-Theft-Auto-VI/achievements

## 2. Live Exophase snapshot, 20 Nov 2026 16:05 UTC (~40h after release)

The only mid-horizon "answer" available; used as a pseudo-backtest (checkpoint 19 Nov 03:00 UTC → target 20 Nov 16:05 UTC).

| Trophy | Rate |
|---|---|
| Platinum — Vice Got a Price! | 0.01% |
| Complete Gone Fishing (opener) | 100.00% |
| Complete Chapter 1 | 11.98% |
| Complete Chapter 2 | 1.71% |
| Complete Chapter 3 | 0.03% |
| Complete Chapter 4 | 0.02% |
| Complete the final mission | 0.02% |
| Complete Breakfast Run | 4.26% |
| Beat Cal in a fishing challenge | 13.30% |
| Complete an arcade game | 1.42% |
| Discover 100 vehicles | 1.70% |
| Bowling (Kolt & Associates) | 1.26% |
| All other trophies | 0.01% (print floor) |

Lessons: the story funnel is steep (100% → 12% → 1.7% → 0.03% → 0.02% in ~40h); 0.01% is the two-decimal print floor (the true rate can be ≤0.015%); the opener is structurally 100%. Players Tracked was not captured from the page text. For scale only: TrueAchievements (Xbox side) showed 120,946 tracked gamers at the same time — Xbox, not PS5.

## 3. How Exophase counts (the denominator is half the model)

Only players who have earned at least one trophy in the game count in the rarity stat (Exophase staff, forum). So rate(t) = E(t) / N(t), and a rate can FALL while nobody loses a trophy — N growing faster than E is enough. That is exactly what the practice refresh did (N 638 → 3,868, nearly every rate down). A model that only extrapolates rates gets the direction wrong; it must separate E and N.

No public Exophase refresh schedule was found. Empirically (house recording): the page was flat 23:48–04:00, then refreshed between 04:00–04:30 (a flat gap of ≥4.5h). Treat refreshes as discrete jumps at unknown times, not a continuous flow. The final answer is the first read in [target, target+60min).

Sources: https://forums.exophase.com/threads/rarity-percentage-is-shown-differently-from-the-original.62896/ ; https://www.truetrophies.com/n14451/explaining-your-truetrophy-score ; https://www.exophase.com/faq/

## 4. GTA V baseline — funnel shape, not week-one levels

PSNProfiles mature rates (PSN-wide, not week one; no week-one time series was found anywhere): Welcome to Los Santos 42.8% → Diamond Hard 19.0% → A Friendship Resurrected 17.6% → A Fair Day's Pay 11.3% → final mission 8.5%; platinum 0.1% PSN vs 5.35% among PSNProfiles members. Selection bias (Kwak 2022, 377,938 trophies): tracker populations are far more engaged than PSN at large, so rare-trophy rates among members run 5–50× the PSN rate. Never use a PSN rate as a prior for an Exophase rate — but the funnel SHAPE transfers.

Sources: https://psnprofiles.com/trophies/15720-grand-theft-auto-v/LeonNutson ; https://projectgamr.com/research/playstation-trophy-completion-rates/ (Kwak, WebSci 2022)

## 5. Play-time budget — why late trophies stay at the floor on day 7

GTA VI story ~50–65h (Rockstar: ~80h with side content); platinum ~200h. A typical player (2–4h/day) reaches only ~15–25h by day 7 — not finished with the story. So on 26 Nov: final / 100% / platinum practically stay at 0.01–0.1%; Chapters 3–4 only start moving; Chapters 1–2 move the most. Hard bound: no tracked player can hold 200h by day 7 (168h since release).

Sources: https://insider-gaming.com/every-chapter-story-mission-in-gta-6-game-length-explained/ ; https://www.gamespot.com/articles/how-long-to-beat-gta-6/ ; https://gtasnaps.com/gta-6-trophy-list-and-achievements/

## 6. What this means for the model (in `main.ts`)

- **Separate E and N.** From each read: N = `players_tracked`, E_i ≈ rate_i/100 × N. Project both to the target, rate = E/N.
- **Two history regimes.** Flat history (practice): no slope is estimable — fall back to the refresh prior (a refresh is due, median falls for nearly every trophy, starter stays 100%). Moving history (final): fit the trends of N and of each E_i from the recent reads.
- **Growth is saturating, not a power law.** Trophy curves follow the story funnel (Ch1 > Ch2 > Ch3 > Ch4 > final); grind/collection trophies (250 stunts, 100 WAiNK, card sets, 50 challenges, 5 vaults) saturate very low on day 7 (median ~0.01–0.05% with a wide upper tail). The program therefore fits logit rates linearly in log time — deliberately tame — instead of extrapolating earner counts as a power law.
- **Interval width (logit):** ~1.0 for ordinary trophies, wider for floor trophies (near 0, a move 0.01% → 0.05% is already +1.6 logit). What matters more than symmetric width is the median shifting the right way per trophy class — pinball on the logit scale punishes a wrong median at every level.

## 7. Gaps (honest)

No public Exophase refresh schedule; no launch-week earn-rate time series for any game; no GTA V week-one rates; no live PS5 Players Tracked number captured.
