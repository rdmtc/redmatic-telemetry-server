-- Daily aggregate snapshots (task 11): counts only, no ids. One row per day, dimension and value.
--   active     installations seen in the 180 days before the snapshot (value '')
--   new        installations first seen on that day (value ''), exact
--   redmatic, ccu (major.minor), family, lite, platform, country: the active installations per value; values with
--              fewer than 5 installations are summed into '(other)'
-- estimated = 1: the rough backfill of the active curve from created/updated, before the first real snapshot.

CREATE TABLE IF NOT EXISTS daily_stats (
    dimension TEXT    NOT NULL,
    date      TEXT    NOT NULL,
    value     TEXT    NOT NULL,
    count     INTEGER NOT NULL,
    estimated INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dimension, date, value)
) WITHOUT ROWID;
