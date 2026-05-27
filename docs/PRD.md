# Product Requirements Document (PRD) — suisub

This document outlines the product requirements, features, and target user profiles for **suisub**, a decentralized recurring subscription protocol built on the Sui blockchain.

---

## 1. Executive Summary
**suisub** is a decentralized, self-custodial recurring payment gateway built on the Sui Network. It brings the convenience of Stripe-style recurring billing to the Web3 ecosystem without requiring users to sacrifice control of their funds. Through a unique combination of on-chain escrow accounts, automated keepers (relayers), and decentralized storage integration (Walrus + SEAL), **suisub** enables creators, SaaS companies, and dApps to monetize their services on-chain.

---

## 2. The Problem Statement
In traditional finance, recurring billing is easy because centralized banks authorize merchants to "pull" money from credit cards. In Web3, this is difficult because:
1. **Self-Custody Constraints**: Smart contracts cannot initiate transactions or pull funds from a user's wallet without an active cryptographic signature.
2. **Subscription Fatigue**: Forcing users to log in and sign a transaction manually every month ruins user retention and convenience.
3. **Lack of Trust**: Giving a merchant full authorization to withdraw arbitrary amounts of funds from a personal wallet is a security risk.

---

## 3. User Personas

### Creator / Merchant
* **Goal**: Sell ongoing services, premium content, SaaS subscriptions, or memberships on-chain and receive predictable, recurring income.
* **Needs**: Simple plan creation interface, support for multiple stablecoins, automated collection, access controls, and the ability to pause/resume operations during incidents.

### Subscriber / Customer
* **Goal**: Subscribe to ongoing services seamlessly with a single setup step, maintaining control over how much they pay and the ability to cancel instantly.
* **Needs**: Self-custodial security, gasless subscriptions, transparent funding, and one-click cancellation with instant escrow refunding.

---

## 4. Key Features & Product Requirements

### 4.1 Subscription Plan Creation
* **Requirement**: Any merchant can create customized plans.
* **Specifications**:
  - Configurable pricing.
  - Interval-based schedules (e.g. 7, 14, 30 days).
  - Choice of payment token (SUI, USDC, USDT).
  - *Engraved Protocol Rules*: Fixed grace periods (3 days), retry intervals (12 hours), and max charge attempts (3) to ensure protocol predictability.

### 4.2 The Escrow Funding Model
* **Requirement**: Secure, self-custodial escrow balances for users.
* **Specifications**:
  - Upon subscription, the subscriber funds a dedicated on-chain **Escrow Vault**.
  - Users can top up their escrow vault at any time.
  - Users can cancel their subscription at any time, instantly retrieving all remaining uncharged funds in their vault.

### 4.3 Automated Keeper Execution (Off-Chain Relayer)
* **Requirement**: Fully automated recurring charges without requiring manual user signatures.
* **Specifications**:
  - An automated relayer (Keeper daemon) polls the blockchain for due subscriptions.
  - If the current time is past `next_due` and the user's Escrow Vault is funded, the keeper executes the contract's `execute_payment` function.
  - Debits the escrow vault, routes the payment to the creator, and records the cycle.

### 4.4 Sponsored Transactions (Gasless UX)
* **Requirement**: Eliminate the need for subscribers to purchase gas tokens (SUI) just to manage subscriptions.
* **Specifications**:
  - Integration with a gas-sponsoring API so that subscribing, canceling, and updating escrows can be executed with zero-gas cost to the subscriber.

### 4.5 Creator Controls
* **Requirement**: Creators must be able to protect their businesses.
* **Specifications**:
  - Creators can call `pause_plan` on-chain.
  - A paused plan blocks new subscribers and pauses automatic billing cycles. Creators can resume the plan once resolved.

### 4.6 Gated Content (Walrus + SEAL Integration)
* **Requirement**: Secure media files (PDFs, videos, images) so they are only readable by active plan subscribers.
* **Specifications**:
  - Encryption occurs client-side before upload.
  - Encrypted files are stored on the **Walrus** decentralized storage network.
  - Decryption keys are managed by the **SEAL** (Sui Encryption & Access Control Layer) network and are only released if the user has an active, paid subscription in the contract.

---

## 5. Non-Functional Requirements
* **Security**: The smart contract must protect user escrow funds from merchant drain attacks.
* **Gas Efficiency**: The Move contract must be optimized to keep execution costs minimal for the keeper.
* **Failsafe Relaying**: The keeper must support retry-on-failure dynamics and webhook notifications for failed charges.
