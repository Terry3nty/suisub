# Developer Integration Guide — suisub

This guide explains how to integrate **suisub** as a recurring payment gateway into your own decentralized application (dApp) or service.

---

## 1. Setup Your Subscription Plan
Before you can accept payments, you must publish your subscription plan on the Sui blockchain.

1. Connect to the **suisub** dashboard.
2. Under **Creator Mode**, fill in the Plan Name, Price, and select the Coin Type (SUI, USDC, or USDT).
3. Click **Create Plan** and approve the transaction.
4. Copy the generated **Plan ID** (e.g. `0x123...abc`). You will use this ID in your frontend configuration.

---

## 2. Implement the Checkout Button
To enroll users, you need to trigger the `subscribe` function on the **suisub** smart contract.

Import the Sui SDK and use the following transaction builder in your frontend code:

```typescript
import { Transaction } from '@mysten/sui/transactions';
import { useSignAndExecuteTransaction } from '@mysten/dapp-kit';

// The published suisub package address on Sui Testnet
const SUISUB_PACKAGE_ID = "0x974259b502e443559b4fbd6093d478ca74ab4bbbc986d13d8c44128f8be615f8";
const MERCHANT_PLAN_ID = "0xYOUR_PLAN_ID"; // Replace with your Plan ID
const COIN_TYPE = "0x2::sui::SUI";          // Or USDC/USDT depending on the plan type

export function SubscribeButton() {
  const { mutateAsync: signAndExecuteTransaction } = useSignAndExecuteTransaction();

  const handleSubscribe = async () => {
    const tx = new Transaction();

    // 1. Split the initial deposit coin from the user's gas coin / wallet balance
    // E.g., if plan price is 1 SUI, we split 1 SUI (1,000,000,000 MIST)
    const [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(1_000_000_000)]);

    // 2. Call the subscribe function
    tx.moveCall({
      target: `${SUISUB_PACKAGE_ID}::subscription::subscribe`,
      typeArguments: [COIN_TYPE],
      arguments: [
        tx.object(MERCHANT_PLAN_ID), // Plan Object
        depositCoin,                 // Funding Coin Object
        tx.object('0x6'),            // Clock system object (always 0x6)
      ],
    });

    try {
      const result = await signAndExecuteTransaction({ transaction: tx, chain: 'sui:testnet' });
      console.log("Subscription success! Tx Digest:", result.digest);
    } catch (error) {
      console.error("Subscription failed:", error);
    }
  };

  return (
    <button onClick={handleSubscribe} className="checkout-btn">
      Subscribe for 1 SUI/month
    </button>
  );
}
```

---

## 3. Verify Subscription Status On-Chain
To authorize access (e.g. log the user in, open premium dashboard, allow API queries), query the subscription state directly from the blockchain.

### 3.1 Install Dependencies
Make sure you have `@mysten/sui` installed in your project:
```bash
npm install @mysten/sui
```

### 3.2 Implement Verification Logic
Copy the helper file `frontend/src/lib/subsuiProtocol.ts` to your project and use it like this:

```typescript
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { getSubscriptionStatus, hasActiveAccess, hasStrictAccess } from './subsuiProtocol';

// 1. Initialize the client
const client = new SuiJsonRpcClient({
  network: 'testnet',
  url: 'https://fullnode.testnet.sui.io:443',
});

const SUISUB_PACKAGE_ID = "0x974259b502e443559b4fbd6093d478ca74ab4bbbc986d13d8c44128f8be615f8";

/**
 * Checks if a wallet address has premium access
 * @param subscriberAddress The user's wallet address
 * @param planId The merchant's plan ID
 */
async function checkUserSubscription(subscriberAddress: string, planId: string): Promise<boolean> {
  try {
    // 2. Fetch the subscription status from on-chain events & objects
    const status = await getSubscriptionStatus({
      client,
      packageId: SUISUB_PACKAGE_ID,
      subscriber: subscriberAddress,
      planId: planId,
    });

    // 3. Apply the authorization policy
    // - Option A: hasActiveAccess(status) — Allows users in the 3-day grace period to view content
    // - Option B: hasStrictAccess(status) — Strictly requires next_due to be in the future
    const isAuthorized = hasActiveAccess(status);
    
    return isAuthorized;
  } catch (error) {
    console.error("Error checking subscription:", error);
    return false;
  }
}
```

---

## 4. Setting up Webhook Integration (Optional)
If your app runs a backend server, you can listen to payment execution webhooks sent by the **suisub** keeper (relayer).

1. Add your endpoint to `WEBHOOK_URLS` in the relayer's config (`relayer/.env`).
2. Listen to post requests. The relayer will send a payload like:

```json
{
  "id": "payment.executed:digest:sub_id",
  "type": "payment.executed",
  "network": "testnet",
  "packageId": "0x974259b502e443559b4fbd6093d478ca74ab4bbbc986d13d8c44128f8be615f8",
  "createdAt": "2026-05-26T17:00:00.000Z",
  "data": {
    "subscriptionId": "0x555...666",
    "subscriber": "0xabc...123",
    "merchant": "0xmerchant...456",
    "planId": "0xYOUR_PLAN_ID",
    "coinType": "0x2::sui::SUI",
    "amount": "1000000000",
    "digest": "BHRhrQamWQwu2Xseo8LpHVkqWGUXRnXGGgd5y1EpubTB"
  }
}
```

3. Update your local database when the webhook fires.
