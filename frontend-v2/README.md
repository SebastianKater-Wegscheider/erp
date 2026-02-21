# Frontend v2 (minimal UX)

Goal: A minimal, precise operator UX built **in parallel** to `../frontend` (v1).

## Local dev

```bash
cd frontend-v2
cp .env.example .env # optional
npm install
npm run dev
```

Default dev URL: `http://localhost:5174`

## Docker Compose

The root `docker-compose.yml` provides a `frontend-v2` service (preview by default, dev-server opt-in):

```bash
docker compose up -d frontend-v2
```

Default URL: `http://localhost:15174`

Dev-server opt-in: set `FRONTEND_V2_DEV_SERVER=true`.
