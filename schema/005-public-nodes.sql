-- The node table keeps only the modules the page shows (task 9, maintainer 2026-09-29): redmatic-*, node-red-* and
-- @scope/node-red-*. Private and self-written modules go, once; the server stores no others from now on.

DELETE FROM node
WHERE NOT (name GLOB 'redmatic-*' OR name GLOB 'node-red-*' OR name GLOB '@*/node-red-*');

-- and rows whose installation is gone (the old server ran without foreign keys)
DELETE FROM node
WHERE installation_uuid IS NULL OR installation_uuid NOT IN (SELECT uuid FROM installation);
