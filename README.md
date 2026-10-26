<div align="center">

# ⚡ opsFlow

**The backend that runs a small business — invoices, payroll, tax, orders and AI-powered bookkeeping in one API.**

[![CI](https://github.com/Em-driod/opsFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Em-driod/opsFlow/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-20-339933?logo=node.js&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose-47A248?logo=mongodb&logoColor=white)
![Tests](https://img.shields.io/badge/tests-174%20passing-brightgreen)

</div>

## ✨ What it does

| Area | Highlights |
| --- | --- |
| 💸 **Money** | Invoices, recurring invoices, proposals, payments via Paystack, multi-currency |
| 👥 **People** | Payroll and payslips, roles and per-business access control, activity log |
| 🇳🇬 **Tax** | Nigerian PIT calculations and summaries built in |
| 🤖 **AI** | Gemini-powered categorisation and natural-language entry, OCR for receipts |
| 📥 **Import / export** | Bank-alert parsing, CSV import with smart mapping, Google Sheets sync |
| 🛍️ **Storefront** | Public catalog and online orders paid by bank transfer, with live order status |
| 🔔 **Realtime** | socket.io updates and notifications, scheduled jobs for summaries and reminders |

## 🚀 Quick start

```bash
cp .env.example .env     # fill in MONGO_URI and JWT_SECRET at minimum
npm install
npm run dev              # nodemon + tsx on src/index.ts
```

| Script              | Purpose                                      |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Run with reload                              |
| `npm run build`     | Install dev deps and compile to `dist/`      |
| `npm start`         | Run the compiled server                      |
| `npm test`          | Jest (ESM, in-memory MongoDB, runs serially) |
| `npm run typecheck` | `tsc --noEmit`                               |
| `npm run lint`      | ESLint                                       |

CI runs typecheck, lint and tests on every push and PR.

## 🧱 Architecture

```
 request ──▶ middleware ──▶ routes ──▶ controllers ──▶ services ──▶ models (MongoDB)
            (helmet, CORS,   (URL →     (parse,         (business     
             rate limit,      handler)   validate)       logic, AI,   ──▶ Paystack · Gemini
             auth, zod,                                  tax, exports)     Brevo · Google Sheets
             idempotency)
```

```
src/
  index.ts          app wiring: middleware, routes, socket.io, cron
  config/           db connection, CORS origins
  routes/           URL → controller mapping
  controllers/      HTTP layer
  services/         business logic
  models/           Mongoose schemas
  middleware/       auth, rate limiting, validation, sanitising, idempotency
  utils/            AppError, logger, parsers, helpers
  __tests__/        all tests
scripts/            one-off maintenance scripts
eng.traineddata     Tesseract English model for OCR (must stay at the root)
```

## 📐 Conventions

- Controllers stay thin; logic lives in `services/`.
- Errors: throw `AppError(message, status)`; wrap handlers with `asyncHandler`.
- Auth: `protect` (JWT bearer), then `admin` or business-level access checks where needed.
- Logging: use `logger` from `utils/logger` (JSON in production, `LOG_LEVEL` to tune), not `console`.
- Money is stored as numbers rounded to 2 decimals; Paystack amounts are converted to minor units at the boundary.
- Tests run the Express app against `mongodb-memory-server`.

## 🔐 Environment

See `.env.example` for every variable (MongoDB, JWT, CORS, Brevo email, Gemini, Paystack, Google OAuth, `LOG_LEVEL`). Never commit `.env`.
