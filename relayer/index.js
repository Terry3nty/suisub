import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import dotenv from "dotenv";
import http from "node:http";

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const PACKAGE_ID = process.env.PACKAGE_ID?.trim(); // fill after sui client publish
const CLOCK_ID   = "0x6";                           // Sui system clock object (always this)
const NETWORK    = process.env.NETWORK || "testnet";
const PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();
const POLL_MS = Number(process.env.POLL_MS ?? 60_000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 3);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS ?? 1_000);
const RETRY_MAX_MS = Number(process.env.RETRY_MAX_MS ?? 8_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 20_000);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const WEBHOOK_URLS = (process.env.WEBHOOK_URLS || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET?.trim() || "";
const SPONSOR_PORT = Number(process.env.SPONSOR_PORT ?? 0);
const SPONSOR_GAS_BUDGET = Number(process.env.SPONSOR_GAS_BUDGET ?? 50_000_000);
const STATUS_ACTIVE = 0;
const STATUS_PAST_DUE = 1;
const STATUS_PAUSED = 2;
const STATUS_CANCELED = 3;

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const CURRENT_LOG_LEVEL = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.info;

// ─── Client + Keeper Wallet ───────────────────────────────────────────────────

const client = new SuiJsonRpcClient({
  network: NETWORK,
  url: getJsonRpcFullnodeUrl(NETWORK),
});

function log(level, message, meta = {}) {
  if ((LOG_LEVELS[level] ?? LOG_LEVELS.info) < CURRENT_LOG_LEVEL) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...meta,
  };
  const output = JSON.stringify(entry);
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWebhook(url, payload) {
  const body = JSON.stringify(payload);
  const headers = {
    "content-type": "application/json",
    "user-agent": "suisub-keeper/1.0",
  };
  if (WEBHOOK_SECRET) headers["x-suisub-secret"] = WEBHOOK_SECRET;

  const response = await withTimeout(
    fetch(url, {
      method: "POST",
      headers,
      body,
    }),
    REQUEST_TIMEOUT_MS,
    "webhook",
  );
  if (!response.ok) {
    throw new Error(`webhook ${url} returned ${response.status}`);
  }
}

async function emitWebhook(type, data) {
  if (WEBHOOK_URLS.length === 0) return;
  const payload = {
    id: `${type}:${data.digest ?? ""}:${data.subscriptionId ?? data.eventSeq ?? Date.now()}`,
    type,
    network: NETWORK,
    packageId: PACKAGE_ID,
    createdAt: new Date().toISOString(),
    data,
  };
  await Promise.all(
    WEBHOOK_URLS.map((url) =>
      withRetry(() => postWebhook(url, payload), `webhook:${type}`).catch((error) => {
        log("error", "webhook.failed", { type, url, error: formatError(error) });
      }),
    ),
  );
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function withRetry(fn, label) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > MAX_RETRIES) {
        throw error;
      }
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      const jitter = Math.floor(backoff * (0.2 * Math.random()));
      const delayMs = backoff + jitter;
      log("warn", "retrying", { label, attempt, delayMs, error: formatError(error) });
      await sleep(delayMs);
    }
  }
}

function parseU64(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" || typeof value === "number") return BigInt(value);
  if (value?.fields?.value !== undefined) return BigInt(value.fields.value);
  return 0n;
}

function parseU8(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function parseId(value) {
  if (typeof value === "string") return value;
  if (value?.id) return value.id;
  if (value?.fields?.id) return value.fields.id;
  return value;
}

function parseCoinType(typeStr) {
  if (typeof typeStr !== "string") return null;
  const match = typeStr.match(/<(.+)>/);
  return match ? match[1] : null;
}

if (!PACKAGE_ID) {
  throw new Error("Missing PACKAGE_ID in relayer/.env");
}
if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY in relayer/.env");
}
if (!Number.isFinite(POLL_MS) || POLL_MS <= 0) {
  throw new Error("Invalid POLL_MS in relayer/.env");
}
if (!Number.isFinite(MAX_RETRIES) || MAX_RETRIES < 0) {
  throw new Error("Invalid MAX_RETRIES in relayer/.env");
}
if (!Number.isFinite(RETRY_BASE_MS) || RETRY_BASE_MS <= 0) {
  throw new Error("Invalid RETRY_BASE_MS in relayer/.env");
}
if (!Number.isFinite(RETRY_MAX_MS) || RETRY_MAX_MS <= 0) {
  throw new Error("Invalid RETRY_MAX_MS in relayer/.env");
}
if (!Number.isFinite(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS <= 0) {
  throw new Error("Invalid REQUEST_TIMEOUT_MS in relayer/.env");
}
if (!Number.isFinite(SPONSOR_GAS_BUDGET) || SPONSOR_GAS_BUDGET <= 0) {
  throw new Error("Invalid SPONSOR_GAS_BUDGET in relayer/.env");
}

const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
const KEEPER_ADDRESS = keypair.getPublicKey().toSuiAddress();

log("info", "keeper.started", {
  network: NETWORK,
  address: KEEPER_ADDRESS,
  packageId: PACKAGE_ID,
  pollMs: POLL_MS,
  retries: MAX_RETRIES,
});

// ─── Fetch all active Subscription shared objects ────────────────────────────

async function fetchActiveSubscriptions() {
  // Query all subscription creation events with pagination.
  let hasNextPage = true;
  let cursor = null;
  const subIdSet = new Set();

  while (hasNextPage) {
    const result = await withRetry(
      () =>
        withTimeout(
          client.queryEvents({
            query: {
              MoveEventType: `${PACKAGE_ID}::subscription::SubscriptionCreated`,
            },
            cursor,
            limit: 100,
            order: "descending",
          }),
          REQUEST_TIMEOUT_MS,
          "queryEvents",
        ),
      "queryEvents",
    );

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
  const objects = await withRetry(
    () =>
      withTimeout(
        client.multiGetObjects({
          ids: subIds,
          options: { showContent: true },
        }),
        REQUEST_TIMEOUT_MS,
        "multiGetObjects",
      ),
    "multiGetObjects",
  );

  return objects
    .map((obj) => {
      if (obj.error || !obj.data?.content?.fields) return null;
      const f = obj.data.content.fields;
      const type = obj.data.content.type;
      const coinType = parseCoinType(type);
      return {
        id: obj.data.objectId,
        planId: parseId(f.plan_id),
        escrowId: parseId(f.escrow_id),
        subscriber: f.subscriber,
        merchant: f.merchant,
        nextDue: parseU64(f.next_due),
        graceUntil: parseU64(f.grace_until),
        failedAttempts: parseU64(f.failed_attempts),
        status: parseU8(f.status),
        coinType,
      };
    })
    .filter((s) => s !== null && s.status !== STATUS_CANCELED);
}

// ─── Fetch the SubscriptionPlan object ───────────────────────────────────────

async function fetchPlan(planId) {
  const obj = await withRetry(
    () =>
      withTimeout(
        client.getObject({
          id: planId,
          options: { showContent: true },
        }),
        REQUEST_TIMEOUT_MS,
        "getObject",
      ),
    "getObject",
  );
  if (!obj.data?.content?.fields) return null;
  const f = obj.data.content.fields;
  return {
    id: planId,
    price: parseU64(f.price),
    intervalMs: parseU64(f.interval_ms),
    gracePeriodMs: parseU64(f.grace_period_ms),
    retryIntervalMs: parseU64(f.retry_interval_ms),
    maxFailures: parseU64(f.max_failures),
    merchant: f.merchant,
    active: f.active !== false,
  };
}

const seenWebhookEvents = new Set();
const LIFECYCLE_EVENTS = {
  SubscriptionCreated: "subscription.created",
  SubscriptionCanceled: "subscription.canceled",
  SubscriptionResumed: "subscription.resumed",
  EscrowToppedUp: "subscription.topped_up",
};

async function processLifecycleWebhooks() {
  for (const [moveEvent, webhookType] of Object.entries(LIFECYCLE_EVENTS)) {
    const result = await withRetry(
      () =>
        withTimeout(
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::subscription::${moveEvent}` },
            limit: 50,
            order: "descending",
          }),
          REQUEST_TIMEOUT_MS,
          `queryEvents:${moveEvent}`,
        ),
      `queryEvents:${moveEvent}`,
    );

    for (const event of result.data.reverse()) {
      const eventSeq = `${event.id?.txDigest ?? ""}:${event.id?.eventSeq ?? ""}:${moveEvent}`;
      if (seenWebhookEvents.has(eventSeq)) continue;
      seenWebhookEvents.add(eventSeq);
      await emitWebhook(webhookType, {
        eventSeq,
        digest: event.id?.txDigest,
        ...event.parsedJson,
      });
    }
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function sponsorTransactionKind({ transactionKindBytes, sender }) {
  const tx = Transaction.fromKind(transactionKindBytes);
  tx.setSender(sender);
  tx.setGasOwner(KEEPER_ADDRESS);
  tx.setGasBudget(SPONSOR_GAS_BUDGET);
  const bytes = await tx.build({ client });
  const { signature } = await keypair.signTransaction(bytes);
  return {
    transactionBytes: toBase64(bytes),
    sponsorSignature: signature,
  };
}

async function executeSponsoredTransaction({ transactionBytes, userSignature, sponsorSignature }) {
  const result = await client.executeTransactionBlock({
    transactionBlock: fromBase64(transactionBytes),
    signature: [userSignature, sponsorSignature],
    options: { showEffects: true, showEvents: true },
  });
  return {
    digest: result.digest,
    effects: result.effects,
    events: result.events,
  };
}

function startSponsorApi() {
  if (!SPONSOR_PORT) return;
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    try {
      if (req.method === "POST" && req.url === "/sponsor") {
        const body = await readJsonBody(req);
        const payload = await sponsorTransactionKind(body);
        sendJson(res, 200, payload);
        return;
      }
      if (req.method === "POST" && req.url === "/execute-sponsored") {
        const body = await readJsonBody(req);
        const payload = await executeSponsoredTransaction(body);
        sendJson(res, 200, payload);
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      log("error", "sponsor_api.error", { error: formatError(error) });
      sendJson(res, 500, { error: formatError(error) });
    }
  });
  server.listen(SPONSOR_PORT, () => {
    log("info", "sponsor_api.started", { port: SPONSOR_PORT, sponsor: KEEPER_ADDRESS });
  });
}

// ─── Execute a due payment ────────────────────────────────────────────────────

async function executePayment(sub, plan) {
  log("info", "payment.attempt", {
    subscriptionId: sub.id,
    subscriber: sub.subscriber,
    coinType: sub.coinType,
    escrowId: sub.escrowId,
    amount: plan.price.toString(),
  });

  const tx = new Transaction();

  tx.moveCall({
    target: `${PACKAGE_ID}::subscription::execute_payment`,
    typeArguments: [sub.coinType],
    arguments: [
      tx.object(sub.id),     // &mut Subscription
      tx.object(plan.id),    // &SubscriptionPlan
      tx.object(sub.escrowId), // &mut EscrowVault
      tx.object(CLOCK_ID),   // &Clock
    ],
  });

  try {
    const result = await withRetry(
      () =>
        withTimeout(
          client.signAndExecuteTransaction({
            signer: keypair,
            transaction: tx,
            options: { showEffects: true, showEvents: true },
          }),
          REQUEST_TIMEOUT_MS,
          "signAndExecuteTransaction",
        ),
      "signAndExecuteTransaction",
    );

    const status = result.effects?.status?.status ?? "unknown";
    const events = result.events ?? [];
    const executed = events.some((event) => event.type === `${PACKAGE_ID}::subscription::PaymentExecuted`);
    const failed = events.some((event) => event.type === `${PACKAGE_ID}::subscription::PaymentFailed`);

    if (status === "success") {
      if (executed) {
        log("info", "payment.executed", { subscriptionId: sub.id, digest: result.digest });
        await emitWebhook("payment.executed", {
          subscriptionId: sub.id,
          subscriber: sub.subscriber,
          merchant: sub.merchant,
          planId: sub.planId,
          coinType: sub.coinType,
          amount: plan.price.toString(),
          digest: result.digest,
        });
        return "executed";
      }
      if (failed) {
        log("warn", "payment.failed", { subscriptionId: sub.id, digest: result.digest });
        await emitWebhook("payment.failed", {
          subscriptionId: sub.id,
          subscriber: sub.subscriber,
          merchant: sub.merchant,
          planId: sub.planId,
          coinType: sub.coinType,
          amount: plan.price.toString(),
          digest: result.digest,
        });
        return "failed";
      }
      log("info", "payment.processed", { subscriptionId: sub.id, digest: result.digest });
      return "processed";
    }

    log("error", "payment.error", { subscriptionId: sub.id, digest: result.digest, status });
    return "error";
  } catch (err) {
    log("error", "payment.exception", { subscriptionId: sub.id, error: formatError(err) });
    return "error";
  }
}

// ─── Main keeper loop ─────────────────────────────────────────────────────────

async function keeperLoop() {
  if (!PACKAGE_ID) {
    log("warn", "keeper.missing_package");
    return;
  }

  const loopStart = Date.now();
  log("info", "keeper.poll.start");

  let subs;
  try {
    subs = await fetchActiveSubscriptions();
  } catch (err) {
    log("error", "keeper.subscriptions.fetch_failed", { error: formatError(err) });
    return;
  }

  const metrics = {
    total: subs.length,
    due: 0,
    skippedNotDue: 0,
    skippedPaused: 0,
    skippedPlanPaused: 0,
    missingCoinType: 0,
    missingEscrow: 0,
    executed: 0,
    failed: 0,
    processed: 0,
    errors: 0,
  };
  log("info", "keeper.subscriptions.found", { count: subs.length });

  try {
    await processLifecycleWebhooks();
  } catch (err) {
    log("error", "keeper.webhooks.fetch_failed", { error: formatError(err) });
  }

  const nowMs = BigInt(Date.now());
  const planCache = new Map();

  for (const sub of subs) {
    if (!sub.coinType) {
      metrics.missingCoinType += 1;
      log("warn", "subscription.missing_coin", { subscriptionId: sub.id });
      continue;
    }
    if (!sub.escrowId) {
      metrics.missingEscrow += 1;
      log("warn", "subscription.missing_escrow", { subscriptionId: sub.id });
      continue;
    }
    if (sub.status === STATUS_PAUSED) {
      metrics.skippedPaused += 1;
      log("info", "subscription.paused", { subscriptionId: sub.id });
      continue;
    }
    // Skip if not due yet
    if (nowMs < sub.nextDue) {
      const secsLeft = Number((sub.nextDue - nowMs) / 1000n);
      metrics.skippedNotDue += 1;
      log("debug", "subscription.not_due", { subscriptionId: sub.id, dueInSeconds: secsLeft });
      continue;
    }
    metrics.due += 1;

    // Fetch the associated plan
    let plan = planCache.get(sub.planId);
    if (!plan) {
      plan = await fetchPlan(sub.planId);
      if (plan) planCache.set(sub.planId, plan);
    }
    if (!plan) {
      metrics.errors += 1;
      log("warn", "plan.missing", { planId: sub.planId, subscriptionId: sub.id });
      continue;
    }
    if (!plan.active) {
      metrics.skippedPlanPaused += 1;
      log("info", "plan.paused", { planId: plan.id, subscriptionId: sub.id });
      continue;
    }

    const outcome = await executePayment(sub, plan);
    if (outcome === "executed") metrics.executed += 1;
    else if (outcome === "failed") metrics.failed += 1;
    else if (outcome === "processed") metrics.processed += 1;
    else metrics.errors += 1;
  }

  log("info", "keeper.poll.complete", {
    ...metrics,
    durationMs: Date.now() - loopStart,
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

// Run immediately, then on interval
let running = false;
async function guardedKeeperLoop() {
  if (running) {
    log("warn", "keeper.poll.skipped");
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
startSponsorApi();
