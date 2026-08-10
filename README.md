# HRMS Backend API

Express + MongoDB (Mongoose) REST API for the HRMS system.

## Local Setup

```bash
npm install
cp .env.example .env   # then fill in MONGODB_URI, JWT_SECRET
npm run dev            # http://localhost:5001
```

Required environment variables (see `.env.example`):

| Variable          | Description                                        |
|-------------------|----------------------------------------------------|
| `MONGODB_URI`     | MongoDB connection string (Atlas `mongodb+srv://…`) |
| `JWT_SECRET`      | Secret used to sign auth tokens                    |
| `MONGODB_DB_NAME` | Database name (defaults to `NewHRMS`)              |
| `PORT`            | Port for local dev (defaults to `5001`)            |
| `NODE_ENV`        | `development` / `production`                       |

## Vercel Deployment

This repo is configured for serverless deployment via `vercel.json`
(all traffic is routed to `server.js`, which exports the Express app).

1. Import this repo into Vercel (framework: **Other** — `vercel.json` handles the rest).
2. In **Project → Settings → Environment Variables**, add:
   - `MONGODB_URI` (your Atlas connection string)
   - `JWT_SECRET` (use the same value as local)
   - `MONGODB_DB_NAME` (e.g. `NewHRMS`)
3. Deploy. The API will be live at `https://<your-project>.vercel.app`.

> Note: serverless functions use an ephemeral filesystem — files uploaded via
> `/api/...` upload endpoints and files written to `uploads/` or `exports/`
> are not persisted between requests. Everything else (DB-driven data, PDF/salary
> generation) works as-is.

## Health Check

`GET /health` → `{ "ok": true, "db": "<db name>" }`
