-- title: Which heroes do developers touch the most?
-- question: Per game, which heroes were changed most often, and are they mostly being buffed or nerfed?
-- techniques: conditional aggregation (FILTER), window ranking, QUALIFY
-- why: Frequent changes signal a hero the developers can't get right, a design problem rather than a numbers problem.
SELECT
    game,
    hero,
    COUNT(*)                                          AS total_changes,
    COUNT(*) FILTER (WHERE change_type = 'buff')      AS buffs,
    COUNT(*) FILTER (WHERE change_type = 'nerf')      AS nerfs,
    COUNT(*) FILTER (WHERE change_type IN ('rework', 'adjustment')) AS reworks_or_adjustments,
    COUNT(*) FILTER (WHERE change_type = 'buff')
      - COUNT(*) FILTER (WHERE change_type = 'nerf')  AS net_direction,   -- >0 = mostly buffed
    MIN(patch_date)                                   AS first_change,
    MAX(patch_date)                                   AS last_change
FROM patch_changes
WHERE change_type <> 'new'
GROUP BY game, hero
QUALIFY ROW_NUMBER() OVER (PARTITION BY game ORDER BY total_changes DESC, hero) <= 5
ORDER BY game, total_changes DESC;