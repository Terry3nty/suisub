# Real-World Use Cases — suisub

This document outlines how **suisub**'s decentralized recurring payment gateway can be applied across different sectors in Web3, detailing the problems solved in each scenario.

---

## 1. Web3 SaaS & Developer APIs
* **The Opportunity**: Traditional cloud/API developer platforms charge monthly fees for infrastructure. Web3 tools (e.g., RPC providers like Triton/QuickNode, data indexers like Goldsky, or dashboards like Dune Pro) want to support native Web3 payment options.
* **suisub Solution**:
  - Developers subscribe to API tiers using stablecoins (USDC/USDT).
  - The developer pre-funds their `EscrowVault` on-chain.
  - The API service checks the `Subscription` state via Sui RPC. If the state is active, the developer's API key remains functional.
  - No database is required to track billing dates, cycles, or payment states; the blockchain handles it.

---

## 2. DeFi Auto-Investing / Dollar-Cost Average (DCA)
* **The Opportunity**: Retail investors want to invest a set amount (e.g. $50 USDC) every week into SUI or other tokens automatically without logging in to sign transactions or depositing funds into centralized exchanges.
* **suisub Solution**:
  - The subscriber sets up a subscription where the "merchant" is actually a decentralized exchange (DEX) smart contract (e.g., Cetus or Kriya).
  - Every week, the **suisub** keeper triggers the payment.
  - The contract debits the $50 USDC from the escrow and routes it directly through the DEX swap contract, purchasing SUI and transferring it back to the subscriber's wallet.
  - The user has a fully automated, self-custodial DCA program running on-chain.

---

## 3. Decentralized Physical Infrastructure Networks (DePIN)
* **The Opportunity**: Projects providing decentralized hardware services (such as VPN bandwidth, decentralized cellular networks, decentralized cloud hosting, or GPU rendering power) require ongoing payments based on consumption or billing periods.
* **suisub Solution**:
  - Users lock tokens in their personal escrow vault.
  - The DePIN nodes read the subscription status on-chain to authorize resource allocation.
  - If a user's subscription expires due to a depleted escrow, nodes automatically suspend resource delivery until the user tops up.

---

## 4. DAO Dues & Gaming Guild Memberships
* **The Opportunity**: Decentralized Autonomous Organizations (DAOs), investment clubs, and Web3 gaming guilds require recurring membership dues to keep voting rights, private Discord server access, or yield-sharing privileges active.
* **suisub Solution**:
  - Members pay automated weekly/monthly dues into the DAO's treasury.
  - The DAO's governance portal checks the membership status. If the subscription is paused or canceled, the user's voting multiplier is disabled, or their access to exclusive DAO channels is automatically revoked.

---

## 5. Web3 Gaming & Subscription MMORPGs
* **The Opportunity**: MMORPGs or online Web3 games want to sell monthly passes or battle passes. In standard Web3, players hate having to sign wallet transactions mid-game to renew their premium features or passes.
* **suisub Solution**:
  - Players approve a **suisub** plan once.
  - The keeper processes the charges silently in the background between seasons/months.
  - The game servers verify the subscription status during user login and grant access to premium servers, skins, or worlds without ever interrupting the gameplay.

---

## 6. Crypto-Native E-commerce (Physical Subscriptions)
* **The Opportunity**: Stores selling physical goods on a recurring basis (e.g. a monthly coffee club, vitamin boxes, or apparel) want to allow Web3 users to pay directly from their wallets without inputting credit cards.
* **suisub Solution**:
  - Merchants integrate **suisub** into their e-commerce store checkouts.
  - The buyer funds the escrow, and the shop's backend monitors `PaymentExecuted` events.
  - Each time a recurring charge successfully fires, the merchant's ERP/shipping system receives a webhook and automatically prints a shipping label for that month's product.
