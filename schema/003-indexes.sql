-- /data filters by created/updated and joins node on the installation.

CREATE INDEX IF NOT EXISTS installation_created ON installation (created);
CREATE INDEX IF NOT EXISTS installation_updated ON installation (updated);
CREATE INDEX IF NOT EXISTS node_installation_uuid ON node (installation_uuid);
