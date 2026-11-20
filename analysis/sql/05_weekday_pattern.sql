-- title: Which days are busiest?
-- question: Relative to its own weekly average, how many more (or fewer) players does each game have on each day of the week?
-- techniques: date functions (dayname, isodow, date_trunc), window AVG per week for normalization, complete-week filter
-- why: Normalizing by week removes growth and decline trends, leaving the pure weekly rhythm. That's useful for timing events and patches.
WITH d AS (
    SELECT
        game, date, avg_players,
        AVG(avg_players) OVER (PARTITION BY game, date_trunc('week', date)) AS week_mean,
        COUNT(*)         OVER (PARTITION BY game, date_trunc('week', date)) AS days_in_week
    FROM players_daily
    WHERE date >= (SELECT MAX(date) FROM players_daily) - INTERVAL 120 DAYS
)
SELECT
    game,
    dayname(date)                                        AS weekday,
    isodow(date)                                         AS day_number,
    ROUND(100.0 * AVG(avg_players / week_mean - 1), 1)   AS pct_vs_week_average,
    COUNT(*)                                             AS weeks_used
FROM d
WHERE days_in_week = 7                                   -- complete weeks only
GROUP BY ALL
ORDER BY game, day_number;