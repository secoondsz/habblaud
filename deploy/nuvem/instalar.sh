#!/bin/bash
# Escritório de agentes na nuvem: instalação automática.
#
# Cole este texto inteiro no campo "Cloud config" / "User data" ao criar o servidor (Ubuntu 24.04, x86, 4 GB de RAM
# ou mais). Ele roda sozinho na primeira vez que o servidor liga (uns 10 minutos) e deixa tudo pronto:
#   - Node, Git, Google Chrome (navegador dos agentes, sem janela), Caddy (HTTPS automático) e o Claude Code;
#   - o escritório (fork secoondsz/habblaud) compilado e configurado como serviço, que religa sozinho;
#   - a página de primeiro acesso: https://<IP com traços>.sslip.io/?codigo=<CODIGO abaixo>
# O andamento fica em /var/log/escritorio-instalacao.log.
set -euxo pipefail
exec > >(tee -a /var/log/escritorio-instalacao.log) 2>&1

# Se algo der errado, o servidor mostra o registro da instalação (sem o código) em http://<IP>/ para o Claude ver o erro.
mostrar_erro() {
  set +e
  mkdir -p /srv/erro
  sed -e 's/codigo=[A-Za-z0-9]*/codigo=***/g; s/CODIGO=[A-Za-z0-9_]*/CODIGO=***/g; s/CONFIG_CODE=[A-Za-z0-9_]*/CONFIG_CODE=***/g' \
    /var/log/escritorio-instalacao.log > /srv/erro/index.txt
  systemctl stop caddy 2>/dev/null
  ufw allow 80/tcp 2>/dev/null
  cd /srv/erro && nohup python3 -m http.server 80 >/dev/null 2>&1 &
}
trap mostrar_erro ERR

# ---------- o que muda de uma instalação para outra ----------
CODIGO="__CODIGO__"                                   # código do primeiro acesso (vai no link)
FORK="https://github.com/secoondsz/habblaud.git"      # código do escritório
SALAS_REPO="secoondsz/escritorio-agentes"             # salas (privado; o servidor entra com a chave de deploy)
# ---------------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive
U=escritorio
CASA=/home/$U
APP=/opt/escritorio/habblaud
ETC=/etc/escritorio

timedatectl set-timezone America/Sao_Paulo || true

# Roda um comando como o usuário do escritório, com a casa e o ambiente dele.
como() { runuser -l "$U" -c "$1"; }

# Memória extra em disco: compilar e rodar vários agentes ao mesmo tempo.
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

apt-get update
apt-get install -y git curl ca-certificates gnupg build-essential python3 ufw unattended-upgrades \
  debian-keyring debian-archive-keyring apt-transport-https

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Google Chrome: o navegador que os agentes usam para ler a Shopee e outras páginas.
curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y /tmp/chrome.deb
rm -f /tmp/chrome.deb

# Caddy: HTTPS com certificado de verdade, renovado sozinho.
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# Usuário do escritório, chave para o GitHub e autor dos commits do backup.
id $U >/dev/null 2>&1 || useradd -m -s /bin/bash $U
como 'mkdir -p ~/.ssh && chmod 700 ~/.ssh'
[ -f $CASA/.ssh/id_ed25519 ] || como "ssh-keygen -t ed25519 -N '' -C escritorio-servidor -f ~/.ssh/id_ed25519"
como 'ssh-keyscan -t ed25519,rsa github.com >> ~/.ssh/known_hosts 2>/dev/null'
como 'git config --global user.name "Escritorio (servidor)"'
como 'git config --global user.email escritorio@users.noreply.github.com'
como 'git config --global pull.rebase true'

# Claude Code (instalador oficial, no usuário do escritório; atualiza sozinho).
como 'curl -fsSL https://claude.ai/install.sh | bash'
# Navegador dos agentes: Playwright MCP com o Chrome, sem janela, perfil guardado em ~/.navegador.
como "~/.local/bin/claude mcp add -s user navegador -- npx -y @playwright/mcp@latest --browser chrome --headless --user-data-dir $CASA/.navegador" || true

# Permissões do navegador na nuvem para todos os agentes: ler e clicar sozinho; digitar, enviar arquivo e rodar
# script na página pedem aprovação (as regras de cada sala continuam valendo por cima).
mkdir -p $CASA/.claude
cat > $CASA/.claude/settings.json <<'EOF'
{
  "permissions": {
    "allow": [
      "mcp__navegador__browser_navigate",
      "mcp__navegador__browser_navigate_back",
      "mcp__navegador__browser_snapshot",
      "mcp__navegador__browser_take_screenshot",
      "mcp__navegador__browser_click",
      "mcp__navegador__browser_hover",
      "mcp__navegador__browser_press_key",
      "mcp__navegador__browser_wait_for",
      "mcp__navegador__browser_tabs",
      "mcp__navegador__browser_resize",
      "mcp__navegador__browser_close"
    ],
    "ask": [
      "mcp__navegador__browser_type",
      "mcp__navegador__browser_fill_form",
      "mcp__navegador__browser_select_option",
      "mcp__navegador__browser_file_upload",
      "mcp__navegador__browser_evaluate",
      "mcp__navegador__browser_run_code",
      "mcp__navegador__browser_drag",
      "mcp__navegador__browser_handle_dialog"
    ]
  }
}
EOF
chown -R $U: $CASA/.claude

# Código do escritório.
mkdir -p /opt/escritorio
chown $U: /opt/escritorio
[ -d $APP/.git ] || como "git clone --depth 1 -b main $FORK $APP"
como "cd $APP && npm ci --no-audit --no-fund && npm run build"

# Endereço: o IP público vira <ip-com-tracos>.sslip.io (aponta para o próprio IP; o Caddy tira o certificado).
IP=$(curl -4 -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
DOMINIO="$(echo "$IP" | tr . -).sslip.io"

mkdir -p $ETC
chmod 755 $ETC
cat > $ETC/escritorio.env <<EOF
HABBLAUD_SALAS=$CASA/escritorio
HABBLAUD_PTY=1
HABBLAUD_CODEX=0
HABBLAUD_UPDATE_CHECK=0
HABBLAUD_WORLD=0
HABBLAUD_BACKUP_REPO=git@github.com:$SALAS_REPO.git
HABBLAUD_REMOTE_HOST=127.0.0.1
HABBLAUD_REMOTE_PORT=4748
HABBLAUD_REMOTE_INSECURE_HTTP=1
HABBLAUD_REMOTE_BEHIND_HTTPS=1
HABBLAUD_REMOTE_ALLOW=permissions,messages,terminal,spawn,pty
HABBLAUD_ALLOWED_HOSTS=$DOMINIO
HOME=$CASA
TZ=America/Sao_Paulo
PATH=$CASA/.local/bin:/usr/local/bin:/usr/bin:/bin
EOF
cat > $ETC/configurar.env <<EOF
CONFIG_CODE=$CODIGO
CONFIG_REPO=$SALAS_REPO
CONFIG_ROOMS=$CASA/escritorio
CONFIG_PUBKEY=$CASA/.ssh/id_ed25519.pub
EOF
chmod 600 $ETC/configurar.env

cat > /etc/systemd/system/escritorio.service <<EOF
[Unit]
Description=Escritorio de agentes
After=network-online.target
Wants=network-online.target
ConditionPathExists=$ETC/pronto

[Service]
User=$U
WorkingDirectory=$APP
EnvironmentFile=$ETC/escritorio.env
EnvironmentFile=$ETC/login.env
ExecStart=/usr/bin/node dist/server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/escritorio-configurar.service <<EOF
[Unit]
Description=Escritorio de agentes: primeiro acesso
After=network-online.target
ConditionPathExists=!$ETC/pronto

[Service]
EnvironmentFile=$ETC/configurar.env
ExecStart=/usr/bin/node $APP/deploy/nuvem/configurar.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

# Atualização do escritório: toda madrugada, se houver código novo no GitHub.
cat > /usr/local/bin/escritorio-atualizar <<EOF
#!/bin/bash
set -e
como() { runuser -l $U -c "cd $APP && \$1"; }
como 'git fetch --depth 1 origin main'
if [ "\$(como 'git rev-parse HEAD')" != "\$(como 'git rev-parse origin/main')" ]; then
  como 'git reset --hard origin/main && npm ci --no-audit --no-fund && npm run build'
  systemctl try-restart escritorio
fi
EOF
chmod 755 /usr/local/bin/escritorio-atualizar
cat > /etc/systemd/system/escritorio-atualizar.service <<EOF
[Unit]
Description=Escritorio de agentes: atualizar

[Service]
Type=oneshot
ExecStart=/usr/local/bin/escritorio-atualizar
EOF
cat > /etc/systemd/system/escritorio-atualizar.timer <<EOF
[Unit]
Description=Escritorio de agentes: atualizar toda madrugada

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$DOMINIO {
	encode gzip
	reverse_proxy 127.0.0.1:4748
}
EOF

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl daemon-reload
systemctl enable escritorio.service escritorio-configurar.service escritorio-atualizar.timer
systemctl restart caddy
systemctl start escritorio-atualizar.timer
if [ -f $ETC/pronto ]; then systemctl start escritorio; else systemctl start escritorio-configurar; fi

echo "Pronto. Primeiro acesso: https://$DOMINIO/?codigo=$CODIGO" | tee /root/LEIA.txt
