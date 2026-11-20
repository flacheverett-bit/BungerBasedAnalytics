-- title: Rolling 30-day win-rate leaders by role (Deadlock)
-- question: Right now, which heroes have the best match-weighted win rate over the last 30 days in each role?
-- techniques: window aggregates with a RANGE frame (rolling sums), JOIN, QUALIFY + ROW_NUMBER per partition
-- why: A rolling window smooths daily noise, and weighting by matches stops a low-volume day from swinging the number.
WITH daily AS (
    SELECT d.date, d.hero, h.role, d.wins, d.matches
    FROM hero_daily d
    JOIN heroes h USING (game, hero)
    WHERE d.game = 'deadlock'
),
rolling AS (
    SELECT *,
        SUM(wins)    OVER w AS wins_30d,
        SUM(matches) OVER w AS matches_30d
    FROM daily
    WINDOW w AS (PARTITION BY hero ORDER BY date
                 RANGE BETWEEN INTERVAL 29 DAYS PRECEDING AND CURRENT ROW)
)
SELECT
    role,
    hero,
    ROUND(100.0 * wins_30d / matches_30d, 2) AS win_rate_30d,
    matches_30d
FROM rolling
WHERE date = (SELECT MAX(date) FROM daily)
QUALIFY ROW_NUMBER() OVER (PARTITION BY role ORDER BY wins_30d / matches_30d DESC) <= 3
ORDER BY role, win_rate_30d DESC;