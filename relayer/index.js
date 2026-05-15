import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import dotenv from "dotenv";

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const PACKAGE_ID = process.env.PACKAGE_ID?.trim(); // fill after sui client publish
const CLOCK_ID   = "0x6";                           // Sui system clock object (always this)
const POLL_MS    = 60_000;                          // check every 60 seconds
const NETWORK    = process.env.NETWORK || "testnet";
const PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();
const COIN_TYPE  = PACKAGE_ID
  ? `${PACKAGE_ID}::subscription::Subscription<0x2::sui::SUI>`
  : "";

// ─── Client + Keeper Wallet ───────────────────────────────────────────────────

const client = new SuiJsonRpcClient({
  network: NETWORK,
  url: getJsonRpcFullnodeUrl(NETWORK),
});

function parseBalanceMist(balance) {
  if (typeof balance === "bigint") return balance;
  if (typeof balance === "string" || typeof balance === "number") return BigInt(balance);
  if (balance?.fields?.value !== undefined) return BigInt(balance.fields.value);
  return 0n;
}

if (!PACKAGE_ID) {
  throw new Error("Missing PACKAGE_ID in relayer/.env");
}
if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY in relayer/.env");
}

const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
const KEEPER_ADDRESS = keypair.getPublicKey().toSuiAddress();

console.log(`\n suisub Keeper started`);
console.log(`   Network  : ${NETWORK}`);
console.log(`   Address  : ${KEEPER_ADDRESS}`);
console.log(`   Package  : ${PACKAGE_ID ?? "⚠️  not set — add PACKAGE_ID to .env"}`);
console.log(`   Polling  : every ${POLL_MS / 1000}s\n`);

// ─── Fetch all active Subscription shared objects ────────────────────────────

async function fetchActiveSubscriptions() {
  // Query all subscription creation events with pagination.
  let hasNextPage = true;
  let cursor = null;
  const subIdSet = new Set();

  while (hasNextPage) {
    const result = await client.queryEvents({
      query: {
        MoveEventType: `${PACKAGE_ID}::subscription::SubscriptionCreated`,
      },
      cursor,
      limit: 100,
      order: "descending",
    });

    for (const e of result.data) {
      const subId = e.parsedJson?.subscription_id;
      if (subId) subIdSet.add(subId);
    }

    hasNextPage = result.hasNextPage;
    cursor = result.nextCursor ?? null;
  }

  const subIds = Array.from(subIdSet);

  if (subIds.length === 0) return [];

  // Fetch the actual objects
  const objects = await client.multiGetObjects({
    ids: subIds,
    options: { showContent: true },
  });

  return objects
    .map((obj) => {
      if (obj.error || !obj.data?.content?.fields) return null;
      const f = obj.data.content.fields;
      return {
        id: obj.data.objectId,
        planId: f.plan_id,
        subscriber: f.subscriber,
        merchant: f.merchant,
        balance: parseBalanceMist(f.balance),
        nextDue: BigInt(f.next_due),
        active: f.active,
      };
    })
    .filter((s) => s !== null && s.active);
}

// ─── Fetch the SubscriptionPlan object ───────────────────────────────────────

async function fetchPlan(planId) {
  const obj = await client.getObject({
    id: planId,
    options: { showContent: true },
  });
  if (!obj.data?.content?.fields) return null;
  const f = obj.data.content.fields;
  return {
    id: planId,
    price: BigInt(f.price),
    intervalMs: BigInt(f.interval_ms),
    merchant: f.merchant,
    active: f.active !== false,
  };
}

// ─── Execute a due payment ────────────────────────────────────────────────────

async function executePayment(sub, plan) {
  console.log(`\n💸 Executing payment`);
  console.log(`   Subscription : ${sub.id}`);
  console.log(`   Subscriber   : ${sub.subscriber}`);
  console.log(`   Amount       : ${plan.price} MIST`);

  const tx = new Transaction();

  tx.moveCall({
    target: `${PACKAGE_ID}::subscription::execute_payment`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      tx.object(sub.id),     // &mut Subscription
      tx.object(plan.id),    // &SubscriptionPlan
      tx.object(CLOCK_ID),   // &Clock
    ],
  });

  try {
    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true },
    });

    if (result.effects?.status?.status === "success") {
      console.log(`    Payment success | tx: ${result.digest}`);
    } else {
      console.error(`    Payment failed  | ${JSON.stringify(result.effects?.status)}`);
    }
  } catch (err) {
    console.error(`    Error: ${err.message}`);
  }
}

// ─── Main keeper loop ─────────────────────────────────────────────────────────

async function keeperLoop() {
  if (!PACKAGE_ID) {
    console.warn("⚠️  PACKAGE_ID not set. Deploy your contract first then add it to .env");
    return;
  }

  console.log("🔍 Checking subscriptions...");

let subs;
  try {
    subs = await fetchActiveSubscriptions();
  } catch (err) {
    console.error(`Failed to fetch subscriptions: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  console.log(`   Found ${subs.length} active subscription(s)`);

  const nowMs = BigInt(Date.now());

  for (const sub of subs) {
    // Skip if not due yet
    if (nowMs < sub.nextDue) {
      const secsLeft = Number((sub.nextDue - nowMs) / 1000n);
      console.log(`   ⏳ ${sub.id.slice(0, 10)}... due in ${secsLeft}s`);
      continue;
    }

    // Fetch the associated plan
    const plan = await fetchPlan(sub.planId);
    if (!plan) {
      console.warn(`   ⚠️  Could not fetch plan ${sub.planId}`);
      continue;
    }
    if (!plan.active) {
      console.warn(`   ⏸️  Plan paused for ${sub.id.slice(0, 10)}...`);
      continue;
    }

    // Check subscriber has enough balance in escrow
    if (sub.balance < plan.price) {
      console.warn(`   ⚠️  Insufficient escrow balance for ${sub.id.slice(0, 10)}... | balance: ${sub.balance} < price: ${plan.price}`);
      continue;
    }

    await executePayment(sub, plan);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

// Run immediately, then on interval
let running = false;
async function guardedKeeperLoop() {
  if (running) {
    console.warn("⏭️  Previous poll still running, skipping this interval");
    return;
  }
  running = true;
  try {
    await keeperLoop();
  } finally {
    running = false;
  }
}

guardedKeeperLoop();
setInterval(guardedKeeperLoop, POLL_MS);
