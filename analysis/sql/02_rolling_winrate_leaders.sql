-- title: Rolling 30-day win-rate leaders by role
-- question: Right now, which heroes have the best match-weighted win rate over the last 30 days in each role? Covers every game with daily match counts.
-- techniques: window aggregates with a RANGE frame (rolling sums), JOIN, two-stage QUALIFY (latest day per game, then top 3 per role)
-- why: A rolling window smooths daily noise, and weighting by matches stops a low-volume day from swinging the number.
WITH daily AS (
    SELECT d.game, d.date, d.hero, h.role, d.wins, d.matches
    FROM hero_daily d
    JOIN heroes h USING (game, hero)
    WHERE d.game IN (SELECT game FROM games WHERE stats_format = 'matches')   -- any game with real win/match counts
),
rolling AS (
    SELECT *,
        SUM(wins)    OVER w AS wins_30d,
        SUM(matches) OVER w AS matches_30d
    FROM daily
    WINDOW w AS (PARTITION BY game, hero ORDER BY date
                 RANGE BETWEEN INTERVAL 29 DAYS PRECEDING AND CURRENT ROW)
),
latest AS (
    SELECT * FROM rolling
    QUALIFY date = MAX(date) OVER (PARTITION BY game)
)
SELECT
    game,
    role,
    hero,
    ROUND(100.0 * wins_30d / matches_30d, 2) AS win_rate_30d,
    matches_30d
FROM latest
QUALIFY ROW_NUMBER() OVER (PARTITION BY game, role ORDER BY wins_30d / matches_30d DESC) <= 3
ORDER BY game, role, win_rate_30d DESC;
