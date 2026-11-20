-- title: This week's biggest movers, and whether a patch explains them
-- question: Which heroes' win rates changed most between the last 7 days and the 7 days before? Was each mover patched in that period? Covers every game with daily match counts.
-- techniques: per-game date bounds, conditional aggregation, ROW_NUMBER partitioned by game, LEFT JOIN with string_agg
-- why: Separating "moved because of a patch" from "moved on its own" is the first question to ask about any metric change.
WITH match_games AS (
    SELECT game FROM games WHERE stats_format = 'matches'
),
bounds AS (
    SELECT game, MAX(date) AS last_day
    FROM hero_daily
    WHERE game IN (SELECT game FROM match_games)
    GROUP BY game
),
weekly AS (
    SELECT
        d.game,
        d.hero,
        SUM(d.wins)    FILTER (WHERE d.date >  b.last_day - 7)                              AS wins_now,
        SUM(d.matches) FILTER (WHERE d.date >  b.last_day - 7)                              AS games_now,
        SUM(d.wins)    FILTER (WHERE d.date <= b.last_day - 7 AND d.date > b.last_day - 14) AS wins_prev,
        SUM(d.matches) FILTER (WHERE d.date <= b.last_day - 7 AND d.date > b.last_day - 14) AS games_prev
    FROM hero_daily d
    JOIN bounds b USING (game)
    GROUP BY d.game, d.hero
),
moves AS (
    SELECT
        game, hero,
        100.0 * wins_now / games_now   AS wr_now,
        100.0 * wins_prev / games_prev AS wr_prev,
        100.0 * wins_now / games_now - 100.0 * wins_prev / games_prev AS change_pts,
        games_now
    FROM weekly
    WHERE games_now >= 5000 AND games_prev >= 5000
),
ranked AS (
    SELECT *,
        ROW_NUMBER() OVER (PARTITION BY game ORDER BY change_pts DESC) AS up_rank,
        ROW_NUMBER() OVER (PARTITION BY game ORDER BY change_pts ASC)  AS down_rank
    FROM moves
),
patched AS (
    SELECT c.game, c.hero,
        string_agg(c.change_type || ' (' || strftime(c.patch_date, '%b %d') || ')', ', ') AS recent_patch
    FROM patch_changes c
    JOIN bounds b USING (game)
    WHERE c.patch_date > b.last_day - 14
    GROUP BY c.game, c.hero
)
SELECT
    r.game,
    CASE WHEN up_rank <= 5 THEN 'riser' ELSE 'faller' END AS direction,
    r.hero,
    ROUND(wr_prev, 2)    AS win_rate_prev_week,
    ROUND(wr_now, 2)     AS win_rate_this_week,
    ROUND(change_pts, 2) AS change_pts,
    games_now            AS games_this_week,
    COALESCE(p.recent_patch, 'no patch: moved on its own') AS explained_by
FROM ranked r
LEFT JOIN patched p USING (game, hero)
WHERE up_rank <= 5 OR down_rank <= 5
ORDER BY r.game, change_pts DESC;
