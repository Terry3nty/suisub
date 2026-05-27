# Marketing Strategy & Technology Stack — suisub

This document outlines the marketing/business strategy and the complete technology stack powering **suisub**.

---

## 1. Marketing Strategy & Positioning

### 1.1 Value Proposition
* **For Merchants**: *"Retain customers automatically. Accept non-custodial recurring stablecoin payments on Sui without paying traditional 3% credit card processing fees."*
* **For Subscribers**: *"No credit cards, no logins required to renew, and total custody. Cancel and get refunded instantly on-chain."*

### 1.2 Target Market
1. **Web3 Native SaaS**: Developers building dashboards, indexers, analytics tools, and RPC nodes looking to charge other Web3 developers.
2. **DePIN Providers**: Organizations selling ongoing storage, cloud computing, and wireless resources.
3. **Crypto Media & Communities**: Content creators, research houses, and DAOs gating articles, charts, or private groups.
4. **Subscription Gaming (MMORPGs)**: Game studios selling monthly expansions or seasonal passes.

### 1.3 Key Differentiators (Why Sui?)
* **Object-Oriented Escrows**: Sui's object model allows us to store an escrow balance directly inside the subscription object itself. This makes account auditing transparent and secure.
* **Low Latency & Transaction Sponsorship**: Sui's instant block finality makes checkouts instantaneous, and native transaction sponsorship enables merchants to pay for their users' gas, creating a Web2-like user experience.

---

## 2. Technology Stack

**suisub** is built on a modern, high-performance Web3 technology stack optimized for the Sui ecosystem.

```text
┌────────────────────────────────────────────────────────┐
│                      Next.js 15                        │  Frontend Tier
│          Sui dApp Kit + Tailwind + HSL CSS             │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
               ▼                          ▼
┌────────────────────────┐      ┌────────────────────────┐
│      Node.js v20       │      │        Sui Move        │  Backend & On-Chain
│     Keeper Relayer     │      │     Smart Contract     │
└────────────────────────┘      └────────────────────────┘
```

### 2.1 Smart Contract Layer (On-Chain)
* **Language**: **Sui Move (2024 Edition)**. Utilizes modern features like struct package declarations (`public struct`) and named parameters.
* **Standards Used**:
  - `sui::coin`: Supports generic, multi-token payment standards (`phantom CoinType`).
  - `sui::balance`: Manages custody of escrow balances within the custom structs.
  - `sui::event`: Emits granular events (`PlanCreated`, `SubscriptionCreated`, `PaymentExecuted`, `PaymentFailed`, `SubscriptionCanceled`, `SubscriptionResumed`, `ContentPublished`) to feed off-chain indexers and databases.
  - `sui::clock`: Uses the global system clock (`0x6`) to securely enforce payment schedules.

### 2.2 Keeper Layer (Off-Chain Relayer)
* **Runtime**: **Node.js (ESM)**.
* **Key Library Integrations**:
  - `@mysten/sui/jsonRpc`: Connects to Sui RPC endpoints for querying event streams and resolving account/subscription object data.
  - `@mysten/sui/keypairs`: Performs signing and transaction submissions using ECDSA/Ed25519 keeper keys.
  - `@mysten/sui/transactions`: Programmatically constructs and signs Move call transactions.
* **Infrastructure**: Features automated polling loops, exponential backoff retries, webhook notifications, and transaction sponsoring server.

### 2.3 Decentralized Storage & Encryption Layer
* **Walrus Protocol**: Stores client-side encrypted media assets at low cost using erasure-coding decentralization.
* **SEAL Protocol (Sui Encryption & Access Control Layer)**:
  - `@mysten/seal` Client: Performs locally-executed payload encryption and decryption key requests.
  - Threshold Decryption: Committee of independent key servers verified on testnet to enforce access control based on subscription status.

### 2.4 Frontend Presentation Layer (dApp)
* **Framework**: **Next.js 15 + React 19** (configured with Turbopack for rapid development builds).
* **Styles**: Custom Vanilla HSL CSS variables + Tailwind CSS for a premium, dark-mode glassmorphic aesthetics.
* **Wallet Management**: `@mysten/dapp-kit` (handles wallet connections, active account context, transaction signatures, and personal message signing).
* **Notifications**: `sweetalert2` for beautiful, modern popups and checkout feedback.
