# opsFlow (Morniy backend)

TypeScript / Express / MongoDB API for small-business management: invoicing,
transactions, payroll, budgets, products and online orders, Nigerian tax (PIT)
calculations, bank-alert and receipt import (CSV, OCR, Gemini), and exports.

## Quick start

```bash
cp .env.example .env     # fill in MONGO_URI and JWT_SECRET at minimum
npm install
npm run dev              # nodemon + tsx on src/index.ts
```

| Script              | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Run with reload                                 |
| `npm run build`     | Install dev deps and compile to `dist/`         |
| `npm start`         | Run the compiled server                         |
| `npm test`          | Jest (ESM, in-memory MongoDB, runs serially)    |
| `npm run typecheck` | `tsc --noEmit`                                  |
| `npm run lint`      | ESLint                                          |

CI (`.github/workflows/ci.yml`) runs typecheck, lint and tests on every push and PR.

## Layout

```
src/
  index.ts          app wiring: middleware, routes, socket.io, cron
  config/           db connection, CORS origins
  routes/           URL -> controller mapping
  controllers/      HTTP layer: parse, validate, call a service
  services/         business logic (invoices, payroll, tax, imports, AI, exports)
  models/           Mongoose schemas
  middleware/       auth, rate limiting, validation (zod), sanitising, idempotency
  utils/            AppError, parsers, helpers
  __tests__/        all tests
scripts/            one-off maintenance scripts
eng.traineddata     Tesseract English model used by OCR (must stay at the root)
```

## Conventions

- Controllers stay thin; logic lives in `services/`.
- Errors: throw `AppError(message, status)`; wrap handlers with `asyncHandler`.
- Auth: `protect` (JWT bearer) then, where needed, `admin` or business-level access checks.
- Money is stored as numbers rounded to 2 decimals (`roundMoney`); Paystack amounts are converted to minor units at the boundary.
- Tests mount the Express app against `mongodb-memory-server`; `JWT_SECRET` is set in `src/testUtils/jest.setup.ts`.

## Environment

See `.env.example` for every variable (MongoDB, JWT, CORS, Brevo email,
Gemini, Paystack, Google OAuth). Never commit `.env`.
