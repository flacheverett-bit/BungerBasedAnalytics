-- title: Patch whiplash: buffed, then nerfed within a month
-- question: How often does a hero get changed one way and then reversed within 30 days?
-- techniques: LAG() over an ordered partition, date arithmetic, filtering on window results
-- why: Quick reversals point to over-corrections, a balance process that's reacting instead of predicting.
WITH ordered AS (
    SELECT
        game, hero, patch_date, change_type,
        LAG(change_type) OVER w AS previous_change,
        LAG(patch_date)  OVER w AS previous_date
    FROM patch_changes
    WHERE change_type IN ('buff', 'nerf')
    WINDOW w AS (PARTITION BY game, hero ORDER BY patch_date)
)
SELECT
    game,
    hero,
    previous_date,
    previous_change,
    patch_date                    AS reversed_on,
    change_type                   AS reversed_with,
    patch_date - previous_date    AS days_between
FROM ordered
WHERE previous_change IS NOT NULL
  AND previous_change <> change_type
  AND patch_date - previous_date <= 30
ORDER BY reversed_on DESC, game, hero;   -- tie-breakers keep the output order stable between runs