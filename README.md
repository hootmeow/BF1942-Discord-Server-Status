# BF1942 Discord Server Status Bot

A Discord bot that posts a live status embed for a BF1942 game server — map, gametype, tickets, time remaining, and a per-team scoreboard with scores, K/D, and ping. One bot instance = one game server pinned to one Discord channel, configured entirely via `.env`.

## ⚠️ Internal tool — not intended for public self-hosting

This bot connects **directly** to the private Postgres database used by [bf1942.online](https://bf1942.online) (the `bf1942-stats-engine`). Without network access and credentials to that database, the bot cannot function — there is no public API mode.

If you operate your own BF1942 stats collector with the same `servers`, `live_server_snapshot`, and `live_player_snapshot` table shapes, the bot will work against your DB too. Otherwise it's an internal-only deployment.

## Setup

See [`SETUP.md`](SETUP.md) for the full setup walkthrough (Discord application, DB migration, env vars, PM2).
