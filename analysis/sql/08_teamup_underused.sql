-- title: Underused team-up loadouts (Marvel Rivals)
-- question: For which heroes does the less popular team-up loadout have a higher win rate with its partner than the popular one?
-- techniques: ROW_NUMBER, pivot with conditional MAX(CASE ...), derived comparison column
-- why: A gap between popularity and performance is an "insight you can act on": a free win-rate edge most players are ignoring.
WITH ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY hero ORDER BY usage_share DESC) AS rk
    FROM teamups
    WHERE usage_share IS NOT NULL
),
pivoted AS (
    SELECT
        hero,
        MAX(CASE WHEN rk = 1 THEN loadout END)          AS popular_loadout,
        MAX(CASE WHEN rk = 1 THEN usage_share END)      AS popular_share,
        MAX(CASE WHEN rk = 1 THEN wr_with_partner END)  AS popular_wr_with_partner,
        MAX(CASE WHEN rk = 2 THEN loadout END)          AS other_loadout,
        MAX(CASE WHEN rk = 2 THEN usage_share END)      AS other_share,
        MAX(CASE WHEN rk = 2 THEN wr_with_partner END)  AS other_wr_with_partner
    FROM ranked
    GROUP BY hero
)
SELECT
    hero,
    popular_loadout,
    ROUND(popular_share, 1)                                        AS popular_share_pct,
    ROUND(popular_wr_with_partner, 1)                              AS popular_wr,
    other_loadout,
    ROUND(other_share, 1)                                          AS other_share_pct,
    ROUND(other_wr_with_partner, 1)                                AS other_wr,
    ROUND(other_wr_with_partner - popular_wr_with_partner, 1)      AS other_loadout_edge
FROM pivoted
WHERE other_wr_with_partner > popular_wr_with_partner
  AND hero NOT LIKE 'Deadpool (%'          -- Deadpool's three role variants share one set of loadouts
ORDER BY other_loadout_edge DESC
LIMIT 12;