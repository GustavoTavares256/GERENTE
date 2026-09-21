#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy do Gerente CODXIS em VPS (Ubuntu/Debian) — roda via hPanel → Terminal
# -----------------------------------------------------------------------------
# Como usar:
#   1. no Terminal do hPanel (entra como root, sem precisar de SSH):
#        git clone https://github.com/GustavoTavares256/GERENTE.git /opt/gerente-codxis
#        cd /opt/gerente-codxis
#        bash deploy-vps.sh
#   2. Responda as perguntas (IDs da gestão/colaboradores, token UAZAPI, etc.).
#   3. Pronto: o bot roda 24/7 via systemd e reinicia sozinho se cair.
# -----------------------------------------------------------------------------
set -euo pipefail

APP_DIR=/opt/gerente-codxis
GIT_URL=https://github.com/GustavoTavares256/GERENTE.git

DB_USER=codxis
DB_PASS=codxis
DB_NAME=codxis
DB_PORT=5432

export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

say "1/8 Atualizando o sistema"
apt-get update -y
apt-get upgrade -y

say "2/8 Instalando Node.js 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

say "3/8 Instalando PostgreSQL 16"
apt-get install -y postgresql postgresql-contrib
systemctl enable --now postgresql

if ! su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'\"" | grep -q 1; then
  su - postgres -c "psql -c \"CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';\""
fi
if ! su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\"" | grep -q 1; then
  su - postgres -c "psql -c \"CREATE DATABASE $DB_NAME OWNER $DB_USER;\""
fi
echo "PostgreSQL pronto: postgres://$DB_USER:***@localhost:$DB_PORT/$DB_NAME"

say "4/8 Clonando/atualizando o repositório"
mkdir -p "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$GIT_URL" "$APP_DIR"
fi
cd "$APP_DIR"
git pull --ff-only || true

say "5/8 Instalando dependências"
npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

say "6/8 Configurando .env"
if [ ! -f .env ]; then
  cp .env.example .env
fi

echo ""
echo "Agora responda as configurações (ENTER mantém o valor atual)."
echo "----------------------------------------------------------------"

prompt() {
  local var="$1" hint="$2" current="${3:-}"
  local answer
  printf '%s' "${hint}${current:+ [atual: ${current}]}: "
  read -r answer
  if [ -n "$answer" ]; then
    if grep -q "^${var}=" .env; then
      sed -i "s|^${var}=.*|${var}=${answer}|" .env
    else
      echo "${var}=${answer}" >> .env
    fi
  fi
}

GESTAO_CUR=$(grep -E '^GESTAO_IDS=' .env | head -1 | cut -d= -f2-)
FUNC_CUR=$(grep -E '^FUNCIONARIOS_IDS=' .env | head -1 | cut -d= -f2-)
UAZAPI_CUR=$(grep -E '^UAZAPI_TOKEN=' .env | head -1 | cut -d= -f2-)
OPENAI_CUR=$(grep -E '^OPENAI_API_KEY=' .env | head -1 | cut -d= -f2-)

prompt GESTAO_IDS "IDs da gestão (separados por vírgula)" "$GESTAO_CUR"
prompt FUNCIONARIOS_IDS "IDs dos colaboradores (separados por vírgula)" "$FUNC_CUR"
prompt UAZAPI_TOKEN "Token da instância UAZAPI (produção)" "$UAZAPI_CUR"
prompt OPENAI_API_KEY "Chave da OpenAI (opcional, ENTER para fallback por regras)" "$OPENAI_CUR"

# DATABASE_URL aponta para o PostgreSQL local da VPS
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://$DB_USER:$DB_PASS@localhost:$DB_PORT/$DB_NAME|" .env

say "7/8 Criando serviço systemd (auto-reinício 24/7)"
cat > /etc/systemd/system/gerente-bot.service <<EOF
[Unit]
Description=Gerente CODXIS Bot (UAZAPI)
After=network.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/node_modules/.bin/tsx src/index-uazapi.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now gerente-bot.service

say "8/8 Estado do bot"
sleep 3
systemctl status gerente-bot.service --no-pager || true
journalctl -u gerente-bot.service -n 20 --no-pager || true

cat <<'EOF'

─────────────────────────────────────────────────────────────────────────
  Deploy concluído! Comandos úteis:
    systemctl status gerente-bot        # ver status
    journalctl -u gerente-bot -f        # ver logs ao vivo
    systemctl restart gerente-bot       # reiniciar o bot
    systemctl stop gerente-bot          # parar o bot
─────────────────────────────────────────────────────────────────────────
EOF