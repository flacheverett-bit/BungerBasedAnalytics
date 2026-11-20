-- title: Data quality check: do the matchup numbers agree with each other?
-- question: If hero A wins X% against hero B, then B should win (100 - X)% against A, over the same number of games. Does the matchup data pass that test?
-- techniques: self-join, symmetric pair de-duplication (a.hero < a.enemy), validation metrics
-- why: Checking a source against its own logic before trusting it is basic data-quality practice, and an easy way to catch a broken feed.
SELECT
    a.game,
    COUNT(*)                                                       AS hero_pairs_checked,
    ROUND(AVG(ABS(a.win_rate + b.win_rate - 100)), 3)              AS avg_deviation_pts,
    ROUND(MAX(ABS(a.win_rate + b.win_rate - 100)), 3)              AS max_deviation_pts,
    COUNT(*) FILTER (WHERE a.matches = b.matches)                  AS pairs_with_equal_game_counts,
    COUNT(*) FILTER (WHERE ABS(a.win_rate + b.win_rate - 100) > 0.5) AS pairs_failing_0_5pt_tolerance
FROM matchups a
JOIN matchups b
  ON a.game = b.game
 AND a.hero = b.enemy
 AND a.enemy = b.hero
WHERE a.hero < a.enemy
GROUP BY a.game
ORDER BY a.game;