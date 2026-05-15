# suisub Progress

## Current Status
**Core recurring payment flow is working end-to-end on Sui testnet, with creator pause controls now added.**

## Completed
- Fixed relayer SDK compatibility (`@mysten/sui` v2 API updates).
- Converted frontend UX to **SUI input** and **days-based intervals**.
- Added creator/subscriber flows with subscription status, top-up, and cancel actions.
- Fixed contract subscription funding path so escrow is actually funded at subscribe time.
- Published updated Move package and wired package IDs in frontend/relayer env config.
- Fixed frontend loading/state issues in subscriber mode.
- Fixed escrow balance parsing in frontend + relayer.
- Verified keeper execution with short-interval live test:
  - Auto-payment tx: `BHRhrQamWQwu2Xseo8LpHVkqWGUXRnXGGgd5y1EpubTB`
  - Auto-payment tx: `EohJEyByQU9e9qCxCrapyKJS1bzRMJ9zrKF6dVkRdDHP`
  - `PaymentExecuted` events confirmed on-chain.
- Added creator-side protocol integration surfaces:
  - Integration helper module: `frontend/src/lib/subsuiProtocol.ts`
  - Creator UI integration panel with a live access-check demo
  - README integration guide + TypeScript example
- Added creator operations + safety controls:
  - On-chain `pause_plan` support (creator-only)
  - `SubscriptionPlan.active` flow wired through contract, frontend, and relayer
  - Creator Profile UI (list owned plans, pause active plans, empty state for non-creators)
  - Plan creation popup now returns and copy-enables **Plan ID** for dApp integration
- Added protocol revenue model:
  - On-chain fee: **1% + 0.005 SUI** per payment
  - Fee applies to first payment + recurring executions
  - Fee is routed to protocol treasury address in contract
- Security/testing hardening:
  - 9 Move tests passing (plan mismatch, inactive ops, paused-plan subscribe rejection, validation guards + fee-floor guard)
- Monorepo and deploy readiness:
  - Root `package.json` now orchestrates build/test/audit across contract/frontend/relayer
  - Root `.gitignore` and env templates (`frontend/.env.example`, `relayer/.env.example`) added for secret hygiene

## Current On-Chain Snapshot
- Latest package has been republished after pause/profile changes.
- Env is expected to be updated:
  - `frontend/.env` → `NEXT_PUBLIC_PACKAGE_ID=<latest>`
  - `relayer/.env` → `PACKAGE_ID=<latest>`

## In Progress
- Hackathon delivery prep (demo + submission quality polish).
- Integrator demo polish (showing protocol-to-protocol gating path clearly).

## Next Steps
1. Record 2–3 minute demo (create plan → copy Plan ID → integration check → subscribe → keeper auto-charge).
2. Add explorer links for latest package + proof transactions to README/submission form.
3. Prepare Overflow submission copy (problem, solution, differentiation, roadmap).
4. Deploy frontend + relayer and rotate relayer key before public launch.
