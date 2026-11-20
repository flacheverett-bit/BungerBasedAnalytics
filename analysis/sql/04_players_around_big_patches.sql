-- title: Do big patches bring players back?
-- question: For each big patch (10+ heroes changed), how did average Steam players in the week after compare with the week before?
-- techniques: CTEs, range join on dates, conditional aggregation, percentage change
-- why: Ties balance work to a business outcome, player engagement, which is the question a game studio actually cares about.
WITH big AS (
    SELECT game, patch_date, title, heroes_changed
    FROM patches
    WHERE heroes_changed >= 10
),
windows AS (
    SELECT
        b.game, b.patch_date, b.title, b.heroes_changed,
        AVG(p.avg_players) FILTER (WHERE p.date BETWEEN b.patch_date - 7 AND b.patch_date - 1) AS players_before,
        AVG(p.avg_players) FILTER (WHERE p.date BETWEEN b.patch_date + 1 AND b.patch_date + 7) AS players_after,
        COUNT(*) FILTER (WHERE p.date < b.patch_date) AS days_before,
        COUNT(*) FILTER (WHERE p.date > b.patch_date) AS days_after
    FROM big b
    JOIN players_daily p
      ON p.game = b.game
     AND p.date BETWEEN b.patch_date - 7 AND b.patch_date + 7
    GROUP BY ALL
)
SELECT
    game,
    patch_date,
    title,
    heroes_changed,
    ROUND(players_before)                                          AS players_before,
    ROUND(players_after)                                           AS players_after,
    ROUND(100.0 * (players_after - players_before) / players_before, 1) AS pct_change
FROM windows
WHERE days_before >= 5 AND days_after >= 5      -- skip periods where only monthly history exists
ORDER BY patch_date DESC;