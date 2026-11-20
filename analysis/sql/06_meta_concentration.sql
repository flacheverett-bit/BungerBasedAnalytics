-- title: Is the meta getting more or less diverse?
-- question: Each month, how concentrated are hero picks? Measured as the effective number of heroes (1 / HHI), that number as a share of the roster, and the top-5 share of all picks. Covers every game with daily match counts.
-- techniques: window SUM for shares, ROW_NUMBER ranking, sum of squares (Herfindahl-Hirschman Index), monthly roll-up per game
-- why: HHI is the economist's market-concentration measure. Here it turns "is the game balanced?" into a number you can track. Dividing by the roster size controls for new heroes being added.
WITH shares AS (
    SELECT
        game, date, hero,
        matches * 1.0 / SUM(matches) OVER (PARTITION BY game, date) AS pick_share
    FROM hero_daily
    WHERE game IN (SELECT game FROM games WHERE stats_format = 'matches')
),
ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY game, date ORDER BY pick_share DESC) AS rk
    FROM shares
),
per_day AS (
    SELECT
        game, date,
        SUM(pick_share * pick_share)              AS hhi,
        SUM(pick_share) FILTER (WHERE rk <= 5)    AS top5_share,
        COUNT(*)                                  AS heroes_played
    FROM ranked
    GROUP BY game, date
)
SELECT
    game,
    strftime(date_trunc('month', date), '%Y-%m')   AS month,
    ROUND(AVG(1 / hhi), 1)                         AS effective_heroes,
    MAX(heroes_played)                             AS heroes_available,
    ROUND(100 * AVG((1 / hhi) / heroes_played), 1) AS diversity_pct_of_roster,   -- 100% = every hero picked equally
    ROUND(100 * AVG(top5_share), 1)                AS top5_pick_share_pct
FROM per_day
GROUP BY game, month
ORDER BY game, month;
