# suisub — Recurring Payments on Sui

**Decentralized subscription engine for Sui.**  
Stripe-like subscription rails for on-chain apps.

Anyone can create a subscription plan (weekly, biweekly, monthly).  
Users subscribe in one transaction.  
A keeper automatically executes due payments on schedule — no manual renewals.

Built during Sui Overflow 2026.

## Features

- **Creator-friendly plans**: set price + interval (7/14/30 days in current UI)
- **Creator controls**: pause plans to stop new subscriptions during incidents
- **Creator profile**: creators can view all plans they own, track status, and pause directly from UI
- **True recurring payments**: keeper executes charges when subscriptions are due
- **Protocol revenue model**: 1% + 0.005 SUI per payment routed to protocol treasury
- **Escrow model**: subscriber pre-funds balance; recurring charges pull from escrow
- **Cancel anytime**: remaining escrow is refunded on-chain
- **Composable**: other dApps can read plans/subscriptions from objects + events
- **Demo UI**: simple Next.js dashboard with Creator and Subscriber flows
- **Extensible**: designed to integrate with Walrus/SEAL content gating

## Architecture

1. **Move contract** stores plans + subscription state and enforces payment logic.
   - Plans are shared objects so subscribers can subscribe to creator plans from any wallet.
2. **Frontend** creates plans, subscribes, tops up, and cancels subscriptions.
3. **Relayer (keeper)** polls active subscriptions and calls `execute_payment` when due.
4. **Paused plan behavior**: new subscriptions are blocked; keeper skips recurring charges for paused plans.

## How suisub Works (End-to-End)

1. Creator connects wallet and creates a plan (`price`, `interval`).
2. Plan is stored on-chain with that creator wallet as `merchant`.
3. Subscriber subscribes in one transaction:
   - first cycle payment coin
   - escrow deposit coin
4. Contract sends first payment instantly to creator (`merchant` wallet).
5. Contract stores escrow inside subscription object for future cycles.
6. Relayer checks due subscriptions every 60 seconds.
7. When due and funded, relayer executes payment from escrow to creator wallet.
8. Subscriber can top up escrow or cancel anytime (remaining escrow refunded on cancel).

## Funds Flow (Where Creator Receives Money)

- **Yes:** creator receives funds in the **same wallet used to create the plan**.
- The plan stores this wallet as `merchant`.
- On subscribe:
  - `first_payment` → creator wallet immediately
  - `escrow_deposit` → subscription escrow balance
- On recurring cycles:
  - keeper calls `execute_payment`
  - escrow is debited
  - payment is transferred to creator wallet (`merchant`)

## Protocol Fee Model

- Fee formula per charge: `1% of plan price + 0.005 SUI`
- Collected on:
  - first payment at subscribe time
  - every recurring keeper execution
- Destination: protocol treasury address (on-chain constant in contract)
- Creator receives: `plan price - protocol fee`

## Project Structure

```text
suisub/
├── contract/    # Move smart contract (suisub::subscription)
├── relayer/     # Node.js keeper (auto-payments)
├── frontend/    # Next.js demo dashboard
├── package.json # root monorepo scripts
└── README.md
```

## Monorepo Commands (Root)

From `/suisub`:

- `npm run build` → build contract + frontend
- `npm run test` → run Move tests
- `npm run verify` → build + test
- `npm run audit` → run production dependency audits (frontend + relayer)
- `npm run dev:frontend` / `npm run dev:relayer` → run each service

## Notes

- Current demo flow is **SUI-first** (`0x2::sui::SUI`) in frontend + relayer.
- Move contract is generic over `CoinType`, so multi-coin support can be added in integration/UI.
- Relayer secrets must stay local: copy `relayer/.env.example` to `.env` and never commit private keys.
- Frontend env template: `frontend/.env.example`.
- After contract updates (like pause/profile support), republish and update both:
  - `frontend/.env` → `NEXT_PUBLIC_PACKAGE_ID`
  - `relayer/.env` → `PACKAGE_ID`
- Plan creation popup now shows **Plan ID** + **Digest** and supports one-click **Copy Plan ID** for integrators.

## Security (Go-Live Minimum)

1. Rotate relayer private key before public launch.
2. Keep relayer and treasury keys separate.
3. Never commit `.env`; use `.env.example` templates only.
4. Run `npm run verify` and `npm run audit` before deploys.
5. Keep relayer on a managed process (PM2/systemd) with restart + log monitoring.

## Protocol Integration (Creator Side)

If another protocol wants to gate access with suisub, integration is straightforward:

1. Track `SubscriptionCreated` events for `(subscriber, plan_id)`.
2. Fetch the `Subscription<0x2::sui::SUI>` object for that user+plan.
3. Use one of two access policies:
   - **Active mode (default):** `subscription.active == true`
   - **Strict mode:** `subscription.active == true && subscription.next_due > now`

### Contract Surfaces

- Plan object: `{PACKAGE_ID}::subscription::SubscriptionPlan<0x2::sui::SUI>`
- Subscription object: `{PACKAGE_ID}::subscription::Subscription<0x2::sui::SUI>`
- Events:
  - `PlanCreated`
  - `SubscriptionCreated`
  - `PaymentExecuted`
  - `SubscriptionCanceled`

### Helper for Integrators

For TypeScript integrations, use:

- `frontend/src/lib/subsuiProtocol.ts`
  - `getSubscriptionStatus(...)`
  - `hasActiveAccess(...)`
  - `hasStrictAccess(...)`

### Live Integration Demo (in UI)

Creator Mode now includes a **Live integration test** panel to simulate how a real protocol would gate access.

1. Open Creator Mode.
2. Paste a `planId` and `subscriber` address.
3. Click **Run protocol access check**.
4. It resolves and displays:
   - subscription object id
   - active flag
   - escrow balance
   - next due timestamp
   - policy result for `active` and `strict` modes

This is a direct demo of protocol-to-protocol verification without custom backend code.

### Example Integrator Flow (TypeScript)

```ts
import { getSubscriptionStatus, hasStrictAccess } from "@/lib/subsuiProtocol";

const status = await getSubscriptionStatus({
  client: suiClient,
  packageId: PACKAGE_ID,
  subscriber: userAddress,
  planId,
});

if (!hasStrictAccess(status)) {
  throw new Error("Subscription required");
}
```
