# Recipe d — Bare VPS without Docker (systemd + nginx/Caddy)

Node 22 LTS, a local PostgreSQL, systemd units for the two roles, and a reverse
proxy for HTTPS. No Docker required.

## 1. System packages

```bash
sudo apt update
sudo apt install -y curl postgresql nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # v22.x
```

## 2. PostgreSQL

```bash
sudo -u postgres createuser devsentinel --pwprompt   # set a strong password
sudo -u postgres createdb devsentinel -O devsentinel
```

## 3. Application

```bash
sudo useradd --system --home /opt/devsentinel --shell /usr/sbin/nologin devsentinel
sudo mkdir -p /opt/devsentinel && sudo chown devsentinel:devsentinel /opt/devsentinel
sudo -u devsentinel git clone https://github.com/festac-dev/devsentinel-ai.git /opt/devsentinel/app
cd /opt/devsentinel/app
sudo -u devsentinel npm ci
sudo -u devsentinel npm run build
```

Create `/opt/devsentinel/app/.env` (mode 600, owner devsentinel) from
`.env.example`, with:

- `APP_ROLE` left unset here; the systemd units set it per service
- `DATABASE_URL=postgresql://devsentinel:<password>@127.0.0.1:5432/devsentinel`
- `DIRECT_URL=` same value
- `APP_BASE_URL=https://devsentinel.example.com`
- `ENCRYPTION_KEY=<openssl rand -base64 32>` (both services share this file, so
  the values match by construction)

## 4. Migration release step (run per release, never on web boot)

```bash
cd /opt/devsentinel/app && sudo -u devsentinel npx prisma migrate deploy
```

## 5. systemd units

Install [`devsentinel-web.service`](./devsentinel-web.service) and
[`devsentinel-worker.service`](./devsentinel-worker.service):

```bash
sudo cp deploy/bare-vps/devsentinel-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now devsentinel-web devsentinel-worker
```

Both units run as the `devsentinel` user, restart on failure, and stop
gracefully (SIGTERM → the app drains in-flight work and closes its DB pool).

## 6. HTTPS reverse proxy

Caddy (automatic certificates) — [`Caddyfile`](./Caddyfile):

```bash
sudo apt install -y caddy
sudo cp deploy/bare-vps/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

nginx (you manage certificates, e.g. certbot) —
[`nginx.conf.example`](./nginx.conf.example):

```bash
sudo cp deploy/bare-vps/nginx.conf.example /etc/nginx/sites-available/devsentinel
sudo ln -s /etc/nginx/sites-available/devsentinel /etc/nginx/sites-enabled/
sudo certbot --nginx -d devsentinel.example.com
sudo systemctl reload nginx
```

## 7. pm2 alternative (instead of systemd)

```bash
sudo npm i -g pm2
APP_ROLE=web    pm2 start npm --name devsentinel-web    -- run start
APP_ROLE=worker pm2 start npm --name devsentinel-worker -- run worker
pm2 save && pm2 startup   # follow the printed command to enable boot startup
```

The `EnvironmentFile` equivalent with pm2: export the variables in the shell
profile pm2 inherits, or use `pm2 start ecosystem.config.js` with an `env`
block. SIGTERM is pm2's default shutdown signal, so the graceful shutdown
paths are the same.

## 8. Verify

```bash
curl -f https://devsentinel.example.com/api/health
curl -f https://devsentinel.example.com/api/health/ready   # worker: live
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://devsentinel.example.com/api/webhooks/github \
  -H 'content-type: application/json' -d '{}'               # 401
systemctl status devsentinel-worker                          # active (running)
```

Integrations page → "Background worker: running".

## 9. Releases & rollback

```bash
cd /opt/devsentinel/app
sudo -u devsentinel git fetch && sudo -u devsentinel git checkout <tag>
sudo -u devsentinel npm ci && sudo -u devsentinel npm run build
sudo -u devsentinel npx prisma migrate deploy     # release step
sudo systemctl restart devsentinel-web devsentinel-worker
# rollback: repeat with the previous tag
```

## 10. Backups

```bash
sudo -u postgres pg_dump devsentinel | gzip > /var/backups/devsentinel-$(date +%F).sql.gz
```
