#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/meteo-sunucu
SERVICE_NAME=meteo-sunucu

sudo apt-get update
sudo apt-get install -y curl nginx rsync

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

sudo mkdir -p "$APP_DIR"
sudo rsync -av --delete ./ "$APP_DIR"/ \
  --exclude node_modules \
  --exclude dist \
  --exclude .git

cd "$APP_DIR"
npm install
npm run build

sudo cp deploy/meteo-sunucu.service /etc/systemd/system/${SERVICE_NAME}.service
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl restart ${SERVICE_NAME}

sudo cp deploy/nginx-meteo.conf /etc/nginx/sites-available/${SERVICE_NAME}
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/${SERVICE_NAME} /etc/nginx/sites-enabled/${SERVICE_NAME}
sudo nginx -t
sudo systemctl reload nginx

echo "Kurulum tamamlandi. Servis durumu:"
sudo systemctl --no-pager --full status ${SERVICE_NAME}