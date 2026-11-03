# Eastmoney NAV Provider (staging)

This additive Ghostfolio provider supplies **CNY-denominated onshore public mutual
funds** using Eastmoney/Tiantian's publicly accessible, unofficial endpoints.
It is not an account sync or an order importer. It intentionally does **not**
change Ghostfolio's dividend activity import, positions, corporate actions,
carry-forward pricing, or portfolio calculations.

## Local setup

1. Check out the `staging` branch and install dependencies (`npm ci`).
2. Generate Prisma clients: `npm run database:generate-typings`.
3. Include `EASTMONEY` in the existing `DATA_SOURCES` JSON environment
   variable. Preserve your existing providers, for example:
   `DATA_SOURCES=["COINGECKO","MANUAL","YAHOO","EASTMONEY"]`.
4. Rebuild the local application image using your existing Docker build and
   deployment procedure. The existing production startup command runs
   `prisma migrate deploy`; if you use a custom startup, apply migrations
   before starting the application.
5. Run `npm run test:api -- --runInBand` or
   `npx jest apps/api/src/services/data-provider/eastmoney/eastmoney.service.spec.ts --runInBand`
   (depending on your Nx/Jest test configuration), then verify a full build.

A schema change adds only the `EASTMONEY` enum value and its SQL migration.
No other tables or portfolio accounting algorithms are modified.

## Data behavior

- The six-digit fund code is the provider symbol, and `EASTMONEY` is a
  separate source identity from `YAHOO`.
- Catalog/search: `fundcode_search.js` (cached for 6 hours in process).
- Historical unit NAV: `api.fund.eastmoney.com/f10/lsjz`, using the
  response's **FSRQ** as the market-data date and **DWJZ** as unit NAV. Never
  substitute cumulative NAV or data retrieval time.
- Quotes: latest confirmed unit NAV, marked **delayed**. Ghostfolio only
  persists quotes marked `open` to today's `INTRADAY` row, so stale NAV
  is not mislabeled as today's NAV.
- Dividend events: the public F10 dividend table is converted to
  per-share amounts on ex-dividend dates for Ghostfolio's **existing**
  manual dividend import workflow. The provider does not infer individual
  reinvestment elections or generate transactions.
- Money-market funds are excluded. On-exchange ETFs and LOFs should
  continue to use Yahoo prices; ETF *feeder mutual funds* remain eligible.
- Source HTML/API structures are unofficial and can change. This integration
  needs a runtime smoke test in your environment before relying on it.

## Smoke test

Search for `015564` and `090007` in Ghostfolio and create an asset
without a MANUAL profile. Search for `019455` to verify an offshore-market
linked QDII feeder fund. Check that historical prices are indexed by the
actual dates shown on Eastmoney, including a lagged NAV when applicable.
Try loading dividends for a fund known to have paid distributions.

## Upstream maintenance

Prefer merging Ghostfolio upstream into your fork's `main` and resolving
only the few wiring points of this provider on `staging`. Changes in this
patch are confined to a new provider directory, one new migration, one Prisma
enum member, and NestJS provider module registration. Do not deploy this
patch without a clean local build and a live endpoint smoke test.
