-- title: Do players ban the right heroes?
-- question: In Overwatch and Marvel Rivals, how strongly does ban rate track win rate and pick rate? Which heroes are banned the most despite a below-average win rate?
-- techniques: CORR(), arg_max, PERCENT_RANK window, latest-snapshot filter
-- why: Bans are a player perception signal. Comparing them with results shows where perception and data disagree.
WITH latest AS (
    SELECT *
    FROM hero_daily
    WHERE game IN ('overwatch', 'marvel-rivals')
      AND ban_rate IS NOT NULL
    QUALIFY date = MAX(date) OVER (PARTITION BY game)
),
ranked AS (
    SELECT *,
        PERCENT_RANK() OVER (PARTITION BY game ORDER BY ban_rate) AS ban_pctile,
        AVG(win_rate)  OVER (PARTITION BY game)                   AS game_avg_wr
    FROM latest
)
SELECT
    game,
    COUNT(*)                                         AS heroes,
    ROUND(CORR(ban_rate, win_rate), 2)               AS corr_ban_vs_win,
    ROUND(CORR(ban_rate, pick_rate), 2)              AS corr_ban_vs_pick,
    arg_max(hero, ban_rate)                          AS most_banned,
    ROUND(MAX(ban_rate), 1)                          AS top_ban_rate,
    string_agg(hero, ', ' ORDER BY ban_rate DESC)
        FILTER (WHERE ban_pctile >= 0.8 AND win_rate < game_avg_wr) AS overbanned_below_avg_wr
FROM ranked
GROUP BY game
ORDER BY game;