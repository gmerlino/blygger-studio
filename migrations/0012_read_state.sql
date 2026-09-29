-- Owner-API extension 5 (Blygger Desktop docs/SERVER.md): per reading row, the
-- highest version the owner has read. Owner-only: no public page, feed,
-- blyg.json, item document or export reads it. Numbers only, never text.
CREATE TABLE read_state (
  subscription_id TEXT NOT NULL,
  remote_id       TEXT NOT NULL,
  read_version    INTEGER NOT NULL,
  updated         TEXT NOT NULL,
  PRIMARY KEY (subscription_id, remote_id)
);

-- A row goes away with its imported item or its subscription.
CREATE TRIGGER read_state_item_gone AFTER DELETE ON imported_items
BEGIN
  DELETE FROM read_state WHERE subscription_id = OLD.subscription_id AND remote_id = OLD.remote_id;
END;

CREATE TRIGGER read_state_sub_gone AFTER DELETE ON subscriptions
BEGIN
  DELETE FROM read_state WHERE subscription_id = OLD.id;
END;
