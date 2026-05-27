# Technical Architecture — suisub

This document details the software architecture, database/on-chain models, and operational sequences of **suisub**.

---

## 1. System Topology

**suisub** relies on a three-tier Web3 architecture combining on-chain state, automated background processors, and client-side interfaces.

```mermaid
graph TD
    subgraph Client [Client Tier]
        FE[React/Next.js dApp]
        SEAL[SEAL Browser SDK]
    end

    subgraph Service [Infrastructure Tier]
        KEEPER[Node.js Keeper Relayer]
        SPONSOR[Sponsorship API]
    end

    subgraph Storage [Storage Tier]
        WALRUS[Walrus Decentralized Storage]
        SEAL_KEY[SEAL Key Servers]
    end

    subgraph Blockchain [On-Chain Tier]
        CONTRACT[suisub::subscription Move Contract]
        CLK[Sui System Clock 0x6]
    end

    FE -->|Read/Write State| CONTRACT
    FE -->|Builds Sponsored Tx| SPONSOR
    FE -->|Uploads Encrypted Blobs| WALRUS
    FE -->|Requests Decryption Keys| SEAL_KEY
    KEEPER -->|Automated Charge Tx| CONTRACT
    KEEPER -->|Queries Events| CONTRACT
    CONTRACT -->|Reads Time| CLK
```

---

## 2. On-Chain Structs & Move Contracts

The core contract is `suisub::subscription`, which manages three main shared objects:

### 2.1 `SubscriptionPlan<phantom CoinType>`
Stores the configuration of a creator's subscription tier. It is generic over the `CoinType` (e.g. SUI, USDC, USDT).
* `id: UID`: On-chain object identifier.
* `merchant: address`: The creator's wallet address that receives the funds.
* `name: String`: Name of the subscription plan.
* `price: u64`: Cost per billing cycle (in base units).
* `interval_ms: u64`: Plan duration (e.g. 30 days in ms).
* `grace_period_ms: u64`: Fixed to 3 days (hardcoded).
* `retry_interval_ms: u64`: Fixed to 12 hours (hardcoded).
* `max_failures: u64`: Fixed to 3 (hardcoded).
* `active: bool`: Pause/resume toggle controlled by the merchant.

### 2.2 `EscrowVault<phantom CoinType>`
Holds the subscriber's pre-funded token balance. The keeper can only debit from this vault when payment is due.
* `id: UID`: On-chain object identifier.
* `owner: address`: The subscriber's wallet address.
* `balance: Balance<CoinType>`: Token balance.

### 2.3 `Subscription<phantom CoinType>`
Links a subscriber to a plan and tracks payment history.
* `id: UID`: On-chain object identifier.
* `plan_id: ID`: Reference to the `SubscriptionPlan`.
* `escrow_id: ID`: Reference to the `EscrowVault`.
* `subscriber: address`: Subscriber wallet.
* `merchant: address`: Creator wallet.
* `last_paid: u64`: Epoch timestamp of last successful charge.
* `next_due: u64`: Epoch timestamp of next scheduled charge.
* `grace_until: u64`: Expiration timestamp of grace period.
* `failed_attempts: u64`: Consecutive failed charge attempts.
* `status: u8`: Lifecycle status (Active: 0, Past Due: 1, Paused: 2, Canceled: 3).

---

## 3. Core Sequences

### 3.1 Subscription & Escrow Setup
When a subscriber signs up, they submit a single transaction that creates the Personal Escrow, deposits funds, and establishes the subscription state.

```mermaid
sequenceDiagram
    autonumber
    actor Subscriber
    participant Frontend
    participant Contract
    participant Merchant Wallet

    Subscriber->>Frontend: Click "Subscribe Now"
    Frontend->>Frontend: Split payment tokens from user wallet
    Frontend->>Contract: subscribe<CoinType>(plan, initial_deposit)
    Contract->>Contract: Validate plan is active & deposit >= price
    Contract->>Contract: Create EscrowVault & Subscription objects
    Contract->>Merchant Wallet: Transfer first cycle price (minus protocol fee)
    Contract->>Contract: Set status = Active, next_due = now + interval
    Contract-->>Subscriber: Return subscription ID
```

### 3.2 Automated Recurring Payment Execution
The Relayer daemon manages recurring charges by checking the next due dates.

```mermaid
sequenceDiagram
    autonumber
    participant Keeper (Relayer)
    participant Contract
    participant EscrowVault
    participant Merchant Wallet
    participant Treasury

    Note over Keeper: Runs every 60s
    Keeper->>Contract: Check next_due timestamps
    alt Current time >= next_due
        Keeper->>Contract: execute_payment(Subscription, Plan, EscrowVault)
        alt Escrow Balance >= Plan Price
            Contract->>EscrowVault: Deduct Plan Price
            Contract->>Treasury: Transfer 1% + 0.005 SUI Fee
            Contract->>Merchant Wallet: Transfer remaining balance
            Contract->>Contract: Update next_due = now + interval, failed_attempts = 0, status = Active
            Contract-->>Keeper: Emit PaymentExecuted Event
        else Escrow Balance < Plan Price
            Contract->>Contract: Increment failed_attempts
            alt failed_attempts >= max_failures
                Contract->>Contract: Update status = Paused
            else
                Contract->>Contract: Update status = Past Due, next_due = now + retry_interval
            end
            Contract-->>Keeper: Emit PaymentFailed Event
        end
    end
```

---

## 4. Decentralized Content Gating (Walrus + SEAL)

For products that gate assets, the decryption sequence involves checking subscription status cryptographically:

```mermaid
sequenceDiagram
    autonumber
    actor Subscriber
    participant Frontend
    participant Walrus
    participant SEAL Key Servers
    participant Contract

    Subscriber->>Frontend: Request gated file (e.g. PDF)
    Frontend->>Walrus: Read encrypted blob bytes
    Walrus-->>Frontend: Return encrypted bytes
    Frontend->>Contract: Build seal_approve_subscription dry-run tx
    Frontend->>SEAL Key Servers: Send user signature + dry-run tx
    SEAL Key Servers->>Contract: Simulate seal_approve_subscription on-chain
    alt Subscriber is Active & next_due >= now
        SEAL Key Servers-->>Frontend: Return Decryption Key
        Frontend->>Frontend: Decrypt file in-browser memory
        Frontend-->>Subscriber: Display file/PDF
    else Subscriber status is Paused/Expired
        SEAL Key Servers-->>Frontend: Deny key access (403)
    end
```
