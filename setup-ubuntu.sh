#!/usr/bin/env bash
# BF1942 Discord Server Status Bot — Ubuntu setup
# Run as a non-root user with sudo access:  bash setup-ubuntu.sh
#
# Safe to run on a box that already has other instances running.
# Each run creates one new instance in its own folder with its own systemd service.

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()     { echo -e "${RED}[ERR]${NC}  $*" >&2; exit 1; }
skip()    { echo -e "       ${YELLOW}skip${NC} $*"; }

prompt() {
  local var="$1" label="$2" default="${3:-}" secret="${4:-}"
  local value=""
  while [[ -z "$value" ]]; do
    if [[ -n "$default" ]]; then
      printf "%s [%s]: " "$label" "$default"
    else
      printf "%s: " "$label"
    fi
    if [[ "$secret" == "secret" ]]; then
      read -rs value; echo
    else
      read -r value
    fi
    value="${value:-$default}"
    [[ -z "$value" ]] && echo "  This field is required."
  done
  printf -v "$var" '%s' "$value"
}

prompt_optional() {
  local var="$1" label="$2" default="${3:-}"
  if [[ -n "$default" ]]; then
    printf "%s [%s]: " "$label" "$default"
  else
    printf "%s (optional — Enter to skip): " "$label"
  fi
  read -r value
  value="${value:-$default}"
  printf -v "$var" '%s' "$value"
}

yn() {
  # yn <prompt> <default Y|n> → returns 0 for yes, 1 for no
  local default="${2:-Y}"
  read -rp "$1 [${default}]: " ans
  ans="${ans:-$default}"
  [[ "$ans" =~ ^[Yy]$ ]]
}

# ── Banner ────────────────────────────────────────────────────────────────────

echo
echo -e "${BOLD}========================================================"
echo "  BF1942 Discord Server Status Bot — Instance Setup"
echo -e "========================================================${NC}"
echo
echo "This script adds ONE new bot instance. Run it again for each additional instance."
echo "Existing instances on this box are not touched."
echo
echo "You will need:"
echo "  - A Discord bot token (discord.com/developers/applications)"
echo "  - The Discord channel ID (enable Developer Mode, right-click channel)"
echo "  - PostgreSQL credentials for the bf1942-stats-engine DB"
echo
read -rp "Press Enter to begin, or Ctrl+C to cancel..."
echo

# ── Show existing instances ───────────────────────────────────────────────────

EXISTING=()
while IFS= read -r svc; do
  dir=$(systemctl show "$svc" --property=WorkingDirectory --value 2>/dev/null || true)
  EXISTING+=("  ${svc%.service}  →  ${dir:-unknown path}")
done < <(systemctl list-units --type=service --state=loaded --no-legend 2>/dev/null \
         | awk '{print $1}' | grep -E '^bf1942-' || true)

if [[ ${#EXISTING[@]} -gt 0 ]]; then
  echo -e "${CYAN}Existing bf1942 services on this box:${NC}"
  for e in "${EXISTING[@]}"; do echo "$e"; done
  echo
fi

# ── Instance name ─────────────────────────────────────────────────────────────

echo "--- Instance Name & Folder ---"
echo "Give this instance a short unique name. It becomes:"
echo "  • the folder under /opt/  (e.g. /opt/bf1942-status-au)"
echo "  • the systemd service name (e.g. bf1942-status-au)"
echo

prompt INSTANCE_NAME "Instance name" "bf1942-status"

INSTALL_PATH="/opt/${INSTANCE_NAME}"

if [[ -d "$INSTALL_PATH" ]]; then
  warn "Folder $INSTALL_PATH already exists."
  if systemctl is-active --quiet "$INSTANCE_NAME" 2>/dev/null; then
    die "Service '$INSTANCE_NAME' is already running. Choose a different name or stop it first."
  fi
  if ! yn "Continue and overwrite the .env in $INSTALL_PATH?" "n"; then
    die "Aborted."
  fi
fi

echo

# ── Node.js (skip if already ok) ─────────────────────────────────────────────

NODE_MIN=18
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(process.version.replace('v','').split('.')[0])")
  if [[ "$NODE_VER" -ge "$NODE_MIN" ]]; then
    skip "Node.js $(node --version) already installed — nothing to do."
  else
    warn "Node.js $(node --version) is below v${NODE_MIN}. Upgrading to v20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    success "Node.js $(node --version) installed."
  fi
else
  info "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  success "Node.js $(node --version) installed."
fi

# ── psql client (for migration, skip if already present) ─────────────────────

if command -v psql &>/dev/null; then
  skip "postgresql-client already installed."
else
  info "Installing postgresql-client..."
  sudo apt-get install -y postgresql-client
fi

# ── Clone repo into the new folder ───────────────────────────────────────────

REPO_URL="https://github.com/hootmeow/BF1942-Discord-Server-Status.git"

if [[ -d "$INSTALL_PATH/.git" ]]; then
  info "Repo already cloned at $INSTALL_PATH — pulling latest..."
  sudo git -C "$INSTALL_PATH" pull --ff-only
else
  info "Cloning repo to $INSTALL_PATH ..."
  sudo git clone "$REPO_URL" "$INSTALL_PATH"
fi

sudo chown -R "$USER:$USER" "$INSTALL_PATH"

# Only run npm install if node_modules is missing or package.json changed
if [[ ! -d "$INSTALL_PATH/node_modules" ]]; then
  info "Installing npm dependencies..."
  npm --prefix "$INSTALL_PATH" install --omit=dev
  success "Dependencies installed."
else
  skip "node_modules already present — skipping npm install."
fi

# ── Credentials ───────────────────────────────────────────────────────────────

echo
echo "--- Discord ---"
echo "Bot token → discord.com/developers/applications → your app → Bot → Reset Token"
echo

prompt DISCORD_TOKEN "Bot token" "" "secret"

echo
echo "Channel ID → Discord → User Settings → Advanced → Developer Mode ON"
echo "            then right-click the target channel → Copy Channel ID"
echo

prompt BF1942_CHANNEL_ID "Channel ID (18-digit number)"

echo
echo "--- BF1942 Game Server ---"
echo "Must match a row in the bf1942-stats-engine 'servers' table."
echo "Format:  ip:query_port   e.g.  203.0.113.10:23000"
echo

prompt BF1942_SERVER_ADDRESS "Server address (ip:port)"

echo
prompt_optional BF1942_LABEL "Embed title override (blank = use live server name)"
echo

echo
echo "--- PostgreSQL ---"
echo "Same DB used by the bf1942-stats-engine. Only one instance needs to run"
echo "the migration (setup.sql) — it's safe to skip if already done."
echo

prompt    DB_HOST     "DB host"     "localhost"
prompt    DB_PORT     "DB port"     "5432"
prompt    DB_NAME     "DB name"     "bf1942"
prompt    DB_USER     "DB user"     "postgres"
prompt    DB_PASSWORD "DB password" "" "secret"

echo
echo "--- Polling Interval ---"
prompt POLL_INTERVAL_MS "Refresh interval ms (min 15000)" "60000"
if [[ "$POLL_INTERVAL_MS" -lt 15000 ]]; then
  warn "Below 15000ms — the bot will clamp it automatically."
fi

# ── Write .env ────────────────────────────────────────────────────────────────

ENV_FILE="$INSTALL_PATH/.env"
info "Writing $ENV_FILE ..."

cat > "$ENV_FILE" <<ENVEOF
# Generated by setup-ubuntu.sh — $(date -u +"%Y-%m-%d %H:%M UTC")
# Instance: ${INSTANCE_NAME}

DISCORD_TOKEN=${DISCORD_TOKEN}

DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}

BF1942_SERVER_ADDRESS=${BF1942_SERVER_ADDRESS}
BF1942_CHANNEL_ID=${BF1942_CHANNEL_ID}
${BF1942_LABEL:+BF1942_LABEL=${BF1942_LABEL}
}POLL_INTERVAL_MS=${POLL_INTERVAL_MS}
ENVEOF

chmod 600 "$ENV_FILE"
success ".env written (mode 600)."

# ── Database migration ────────────────────────────────────────────────────────

echo
echo "--- Database Migration ---"
echo "Creates the 'discord_monitors' table. Safe to skip if already run for another instance"
echo "(all instances share the same table in the same DB)."
echo

if yn "Run migration now?" "n"; then
  info "Running setup.sql against ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME} ..."
  PGPASSWORD="$DB_PASSWORD" psql \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -f "$INSTALL_PATH/setup.sql" \
    && success "Migration complete." \
    || warn "Migration failed — run manually if needed: psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f $INSTALL_PATH/setup.sql"
else
  skip "Migration skipped."
fi

# ── systemd service ───────────────────────────────────────────────────────────

echo
echo "--- systemd Service ---"

SERVICE_FILE="/etc/systemd/system/${INSTANCE_NAME}.service"
NODE_BIN=$(command -v node)

info "Writing $SERVICE_FILE ..."

sudo tee "$SERVICE_FILE" > /dev/null <<SVCEOF
[Unit]
Description=BF1942 Discord Status Bot — ${INSTANCE_NAME}
After=network.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${INSTALL_PATH}
EnvironmentFile=${INSTALL_PATH}/.env
ExecStart=${NODE_BIN} src/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

sudo systemctl daemon-reload
sudo systemctl enable "$INSTANCE_NAME"
sudo systemctl restart "$INSTANCE_NAME"

sleep 2

# ── Done ─────────────────────────────────────────────────────────────────────

echo
echo -e "${BOLD}${GREEN}========================================================"
echo "  Done!  Instance '${INSTANCE_NAME}' is live."
echo -e "========================================================${NC}"
echo
echo "Folder:   $INSTALL_PATH"
echo "Service:  $INSTANCE_NAME"
echo
echo "Commands:"
echo "  sudo systemctl status  ${INSTANCE_NAME}"
echo "  journalctl -u ${INSTANCE_NAME} -f"
echo "  sudo systemctl restart ${INSTANCE_NAME}"
echo "  nano ${INSTALL_PATH}/.env  &&  sudo systemctl restart ${INSTANCE_NAME}"
echo
echo "Run this script again to add another instance."
echo
