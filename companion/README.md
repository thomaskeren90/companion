# Companion — Deployment Guide

## Stack
- **Backend:** Node.js + Express + SQLite (better-sqlite3)
- **Frontend:** Single HTML file (no build step)
- **AI:** Claude claude-haiku-4-5-20251001 (cheapest, fastest — ~$0.09/user/mo)
- **Infra:** Docker Compose + Nginx + Let's Encrypt SSL

---

## Quick Start (local dev)

```bash
cd backend
cp .env.example .env
# Edit .env — add your ANTHROPIC_API_KEY and ADMIN_KEY

npm install
npm run dev
# → Backend on http://localhost:3001
# → Frontend served at http://localhost:3001 (static files in /frontend/public)
```

---

## Production Deployment (VPS — Ubuntu 22.04)

### 1. Buy a VPS
- DigitalOcean Droplet $6/mo, Hetzner CX11 €4/mo, or your existing server
- Point your domain DNS A record → server IP

### 2. Install Docker
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

### 3. Upload files
```bash
# From your local machine:
scp -r companion/ user@yourserver:/opt/companion
ssh user@yourserver
cd /opt/companion
```

### 4. Configure environment
```bash
cp backend/.env.example .env
nano .env
# Set:
#   ANTHROPIC_API_KEY=sk-ant-...
#   ADMIN_KEY=some-long-random-string
#   FRONTEND_URL=https://yourdomain.com
```

### 5. Update domain in nginx.conf
```bash
sed -i 's/yourdomain.com/companion.yourdomain.com/g' nginx.conf
```

### 6. Get SSL certificate
```bash
# Start nginx first (HTTP only for challenge)
docker-compose up -d nginx
docker-compose run certbot certonly --webroot \
  -w /var/www/certbot \
  -d yourdomain.com \
  --email you@email.com \
  --agree-tos --no-eff-email
```

### 7. Launch
```bash
docker-compose up -d
docker-compose logs -f  # watch logs
```

### 8. Renew SSL (add to cron)
```bash
# crontab -e
0 12 * * * docker-compose run certbot renew --quiet && docker-compose restart nginx
```

---

## Prompt Pricing

| Plan     | Prompts | Price | Per Prompt |
|----------|---------|-------|------------|
| Free     | 10/day  | $0    | $0         |
| Starter  | 50      | $5    | $0.10      |
| Basic    | 100     | $10   | $0.10      |
| Pro      | 1,000   | $100  | $0.10      |

**Your cost:** ~$0.001 per prompt (Claude Haiku)
**Margin:** ~99x on paid prompts

---

## Confirming Payments (manual)

Until Stripe is wired, confirm payments manually:

```bash
curl -X POST https://yourdomain.com/api/payment/confirm \
  -H "Content-Type: application/json" \
  -d '{"order_id":"ORD-xxxx","admin_key":"your-admin-key"}'
```

This adds the prompts to the user's balance instantly.

---

## Admin Stats

```bash
curl https://yourdomain.com/api/admin/stats \
  -H "x-admin-key: your-admin-key"
```

Returns: users, messages, revenue, top users.

---

## Stripe Integration (optional — for automated payments)

1. Install Stripe: `npm install stripe`
2. Add to `.env`:
   ```
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
3. In `server.js`, replace the `/api/payment/create-order` response with:
   ```js
   const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
   const session = await stripe.checkout.sessions.create({
     payment_method_types: ['card'],
     line_items: [{ price_data: { currency: 'usd', product_data: { name: plan + ' Prompts' }, unit_amount: p.usd * 100 }, quantity: 1 }],
     mode: 'payment',
     success_url: `${process.env.FRONTEND_URL}/success?order=${orderId}`,
     cancel_url: `${process.env.FRONTEND_URL}`,
     metadata: { order_id: orderId }
   });
   res.json({ checkout_url: session.url });
   ```
4. In the Stripe webhook handler, call the confirm logic on `checkout.session.completed`.

---

## Database Location
SQLite DB is at `./data/companion.db` (mounted volume — survives container restarts).

Back it up:
```bash
cp ./data/companion.db ./data/companion.db.bak
```

---

## File Structure
```
companion/
├── backend/
│   ├── server.js          ← All API logic
│   ├── package.json
│   ├── Dockerfile
│   └── .env.example
├── frontend/
│   └── public/
│       └── index.html     ← Entire frontend (landing + chat)
├── data/                  ← SQLite DB (auto-created)
├── docker-compose.yml
├── nginx.conf
└── README.md
```
