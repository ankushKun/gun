# gun.js peer

gun.js peer server with stats dashboard.

## local

```bash
npm install
npm start
```

dashboard at `http://localhost:8765`

## env

- `PORT` - server port (default: 8765)
- `PEERS` - comma-separated peer urls

## production

To make this gun server work on a vps with nginx, you will have to add these configs

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# ------------------------------------
# GunJS WebSocket
# ------------------------------------
server {
    listen 443 ssl;
    listen [::]:443 ssl;

    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
    
    location = /gun {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

If you want to run this with pm2

```bash
cd gun
pm2 start server.js --name "gun"
```