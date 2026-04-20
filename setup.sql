-- Run this once against your bf1942-stats-engine PostgreSQL database.
-- It adds the single table the Discord bot needs to store monitor configuration.
--
--   psql -h HOST -U USER -d DATABASE -f setup.sql

CREATE TABLE IF NOT EXISTS discord_monitors (
    id          BIGSERIAL    PRIMARY KEY,
    guild_id    TEXT         NOT NULL,
    channel_id  TEXT         NOT NULL,
    message_id  TEXT,
    label       TEXT         NOT NULL DEFAULT 'BF1942 Server Status',
    server_ids  BIGINT[]     NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (channel_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_monitors_guild ON discord_monitors(guild_id);
