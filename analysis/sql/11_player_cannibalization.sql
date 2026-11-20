-- title: Did Marvel Rivals take Overwatch's players, and did Deadlock take players from both?
-- question: Using monthly average Steam players: was Overwatch's drop after Marvel Rivals launched (Dec 2024) unusual for Overwatch? Do the games' monthly changes move against each other? When Deadlock surged, did the other two lose players?
-- techniques: monthly roll-up + pivot, rolling 3-month averages, event study ranked against the game's own history (PERCENT_RANK placebo), CORR() with a noise threshold, LAG-based % changes, UNION ALL of tests
-- why: "Game A took game B's players" is a causal claim, and aggregate counts can't show individuals switching. The defensible test is whether one game's losses line up with another's gains more than that game's normal swings would explain. Caveats: Steam only (most Overwatch players are on Battle.net and consoles); before 2026 the source kept about one figure per month, which is noisy.
WITH monthly AS (                       -- one average per game per month, complete months only
    SELECT game, date_trunc('month', date) AS month, AVG(avg_players) AS players
    FROM players_daily
    WHERE date < date_trunc('month', (SELECT MAX(date) FROM players_daily))
    GROUP BY game, month
),
wide AS (
    SELECT month,
        MAX(players) FILTER (WHERE game = 'overwatch')     AS ow,
        MAX(players) FILTER (WHERE game = 'marvel-rivals') AS mr,
        MAX(players) FILTER (WHERE game = 'deadlock')      AS dl
    FROM monthly
    GROUP BY month
),
changes AS (                            -- month-over-month % change per game
    SELECT month,
        100.0 * (ow / LAG(ow) OVER (ORDER BY month) - 1) AS ow_chg,
        100.0 * (mr / LAG(mr) OVER (ORDER BY month) - 1) AS mr_chg,
        100.0 * (dl / LAG(dl) OVER (ORDER BY month) - 1) AS dl_chg
    FROM wide
),

-- Test 1: Overwatch around Marvel Rivals' launch, ranked against every other period in Overwatch's history.
ow_roll AS (
    SELECT month, AVG(ow) OVER (ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS ow_3mo
    FROM wide WHERE ow IS NOT NULL
),
ow_windows AS (
    SELECT month,
        100.0 * (ow_3mo / LAG(ow_3mo, 3) OVER (ORDER BY month) - 1) AS chg_next_3mo,   -- this 3 months vs the 3 before
        100.0 * (ow_3mo / LAG(ow_3mo, 6) OVER (ORDER BY month) - 1) AS chg_months_4_6  -- months 4-6 vs the 3 before the gap
    FROM ow_roll
),
ow_ranked AS (
    SELECT month, chg_next_3mo, chg_months_4_6,
        PERCENT_RANK() OVER (ORDER BY chg_next_3mo)   AS pctile_3mo,
        PERCENT_RANK() OVER (ORDER BY chg_months_4_6) AS pctile_4_6,
        COUNT(chg_next_3mo) OVER ()                   AS windows
    FROM ow_windows
    WHERE month >= '2024-02-01'                 -- skip Overwatch's own Steam-launch hype (Aug-Oct 2023)
      AND chg_next_3mo IS NOT NULL
),
launch AS (
    SELECT
        MAX(chg_next_3mo) FILTER (WHERE month = '2025-02-01')   AS drop_3mo,      -- Dec-Feb vs Sep-Nov
        MAX(pctile_3mo)   FILTER (WHERE month = '2025-02-01')   AS pct_3mo,
        MAX(chg_months_4_6) FILTER (WHERE month = '2025-05-01') AS drop_4_6,      -- Mar-May vs Sep-Nov
        MAX(pctile_4_6)   FILTER (WHERE month = '2025-05-01')   AS pct_4_6,
        MAX(windows)                                            AS windows
    FROM ow_ranked
),

-- Test 2: do monthly changes move together (shared drivers) or against each other (substitution)?
pairs AS (
    SELECT 'Overwatch vs. Marvel Rivals' AS games, CORR(ow_chg, mr_chg) AS r, COUNT(ow_chg + mr_chg) AS n FROM changes
    UNION ALL SELECT 'Overwatch vs. Deadlock',     CORR(ow_chg, dl_chg), COUNT(ow_chg + dl_chg) FROM changes
    UNION ALL SELECT 'Marvel Rivals vs. Deadlock', CORR(mr_chg, dl_chg), COUNT(mr_chg + dl_chg) FROM changes
),

-- Test 3: Deadlock's three biggest surges since Marvel Rivals launched, and how the other two did in those months,
-- ranked against their own monthly changes (0% = worst month, 100% = best month).
ranked_changes AS (
    SELECT month, dl_chg, ow_chg, mr_chg,
        PERCENT_RANK() OVER (ORDER BY ow_chg) AS ow_pctile,
        PERCENT_RANK() OVER (ORDER BY mr_chg) AS mr_pctile,
        COUNT(*) OVER ()                      AS months
    FROM changes
    WHERE ow_chg IS NOT NULL AND mr_chg IS NOT NULL AND dl_chg IS NOT NULL
),
surges AS (
    SELECT * FROM ranked_changes
    QUALIFY ROW_NUMBER() OVER (ORDER BY dl_chg DESC) <= 3
)

SELECT '1. Marvel Rivals launch' AS test,
       'Overwatch: Dec 2024-Feb 2025 vs. the 3 months before' AS measure,
       ROUND(drop_3mo, 1) AS change_pct,
       ROUND(100 * pct_3mo) AS pctile_in_own_history,          -- low = an unusually bad stretch for that game
       windows AS compared_with,
       CASE WHEN pct_3mo <= 0.05 THEN 'One of Overwatch''s worst stretches ever: strong sign Marvel Rivals pulled players'
            WHEN pct_3mo <= 0.20 THEN 'Worse than most stretches but not exceptional: suggestive, not conclusive'
            ELSE 'A normal swing for Overwatch' END AS reading
FROM launch
UNION ALL
SELECT '1. Marvel Rivals launch', 'Overwatch: Mar-May 2025 vs. before launch (did it recover?)',
       ROUND(drop_4_6, 1), ROUND(100 * pct_4_6), windows,
       CASE WHEN drop_4_6 > -5 THEN 'Recovered to its pre-launch level'
            WHEN pct_4_6 <= 0.20 THEN 'Still well below pre-launch: a lasting loss'
            ELSE 'Somewhat below pre-launch, within normal variation' END
FROM launch
UNION ALL
SELECT '2. Co-movement', games || ': correlation of monthly % changes',
       ROUND(r, 2), NULL, n,
       CASE WHEN ABS(r) < 2 / SQRT(n) THEN 'No reliable relationship (|r| under the ~2/sqrt(n) noise threshold)'
            WHEN r < 0 THEN 'Move in opposite directions: consistent with players moving between them'
            ELSE 'Move together: shared drivers (holidays, summer, genre interest), not substitution' END
FROM pairs
UNION ALL
SELECT '3. Deadlock surges', 'Overwatch in ' || strftime(month, '%b %Y') || ' (Deadlock ' || printf('%+.0f', dl_chg) || '%)',
       ROUND(ow_chg, 1), ROUND(100 * ow_pctile), months,
       CASE WHEN ow_pctile <= 0.20 THEN 'One of Overwatch''s weaker months: consistent with losing players to Deadlock'
            WHEN ow_pctile >= 0.80 THEN 'One of Overwatch''s better months: no sign of losing players'
            ELSE 'An ordinary month for Overwatch' END
FROM surges
UNION ALL
SELECT '3. Deadlock surges', 'Marvel Rivals in ' || strftime(month, '%b %Y') || ' (Deadlock ' || printf('%+.0f', dl_chg) || '%)',
       ROUND(mr_chg, 1), ROUND(100 * mr_pctile), months,
       CASE WHEN mr_pctile <= 0.20 THEN 'One of Marvel Rivals'' weaker months: consistent with losing players to Deadlock'
            WHEN mr_pctile >= 0.80 THEN 'One of Marvel Rivals'' better months: no sign of losing players'
            ELSE 'An ordinary month for Marvel Rivals' END
FROM surges
ORDER BY test, measure;
