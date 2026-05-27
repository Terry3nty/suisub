'use client';

import { useEffect, useState } from 'react';
import { ConnectButton, useCurrentAccount, useSignAndExecuteTransaction, useSignPersonalMessage, useSignTransaction, useSuiClient, useSuiClientContext } from '@mysten/dapp-kit';
import type { SuiObjectResponse } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex, toBase64 } from '@mysten/sui/utils';
import Swal from 'sweetalert2';
import { getSubscriptionStatus, hasActiveAccess, hasStrictAccess } from '../lib/subsuiProtocol';
import {
  buildSealApprovalTransaction,
  createSealIdentity,
  createWalrusClient,
  decryptWithSeal,
  encryptWithSeal,
  getContentGateConfig,
  parseContentEvent,
  readWalrusBlob,
  type GatedContentRecord,
} from '../lib/contentGating';

const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID?.trim() ?? '';
const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL?.trim() ?? '';
const INITIAL_NOW_MS = Date.now();
const MS_PER_DAY = BigInt(86_400_000);
const MS_PER_HOUR = BigInt(3_600_000);
const INTERVAL_OPTIONS = ["7", "14", "30"] as const;
const INITIAL_ESCROW_CYCLES = BigInt(1);
const PROTOCOL_FEE_PERCENT = 1;
const PROTOCOL_FIXED_FEE = 0;
const STATUS_ACTIVE = 0;
const STATUS_PAST_DUE = 1;
const STATUS_PAUSED = 2;
const STATUS_CANCELED = 3;
type CoinConfig = {
  label: string;
  type: string;
  decimals: number;
};
const COIN_OPTIONS: CoinConfig[] = [
  { label: 'SUI', type: '0x2::sui::SUI', decimals: 9 },
];
type SubscriptionInfo = {
  subscriptionId: string;
  escrowId: string;
  balanceBase: bigint;
  nextDueMs: bigint;
  graceUntilMs: bigint;
  status: number;
  coinType: string;
  coinSymbol: string;
  coinDecimals: number;
};
type CreatorPlanInfo = {
  id: string;
  name: string;
  priceBase: bigint;
  intervalMs: bigint;
  active: boolean;
  coinType: string;
  coinSymbol: string;
  coinDecimals: number;
};
type GatedContentInfo = GatedContentRecord & {
  coinType: string;
};

function parseBalanceMist(balance: unknown): bigint {
  if (typeof balance === 'bigint') return balance;
  if (typeof balance === 'string' || typeof balance === 'number') return BigInt(balance);
  if (
    balance &&
    typeof balance === 'object' &&
    'fields' in balance &&
    (balance as { fields?: { value?: string | number | bigint } }).fields?.value !== undefined
  ) {
    return BigInt((balance as { fields: { value: string | number | bigint } }).fields.value);
  }
  return BigInt(0);
}

function parseAmountToBaseUnits(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [wholePart, fractionalPart = ""] = trimmed.split(".");
  if (fractionalPart.length > decimals) return null;
  const base = BigInt(10) ** BigInt(decimals);
  const whole = BigInt(wholePart) * base;
  const fractional = BigInt(fractionalPart.padEnd(decimals, "0"));
  return whole + fractional;
}

function parseIntervalDaysToMs(input: string): bigint | null {
  const trimmed = input.trim();
  if (!INTERVAL_OPTIONS.includes(trimmed as (typeof INTERVAL_OPTIONS)[number])) return null;
  return BigInt(trimmed) * MS_PER_DAY;
}

function parsePositiveInt(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = BigInt(trimmed);
  if (value <= BigInt(0)) return null;
  return value;
}

function parseDaysToMs(input: string): bigint | null {
  const value = parsePositiveInt(input);
  if (value === null) return null;
  return value * MS_PER_DAY;
}

function parseHoursToMs(input: string): bigint | null {
  const value = parsePositiveInt(input);
  if (value === null) return null;
  return value * MS_PER_HOUR;
}

function formatUnits(amount: bigint, decimals: number): string {
  const base = BigInt(10) ** BigInt(decimals);
  const whole = amount / base;
  const fraction = amount % base;
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fractionStr ? `${whole}.${fractionStr}` : `${whole}`;
}

function parseCoinType(typeStr: unknown): string | null {
  if (typeof typeStr !== 'string') return null;
  const match = typeStr.match(/<(.+)>/);
  return match ? match[1] : null;
}

function getCoinConfig(coinType: string | null | undefined): CoinConfig | null {
  if (!coinType) return null;
  return COIN_OPTIONS.find((coin) => coin.type === coinType) ?? null;
}

function getStatusLabel(status: number): string {
  if (status === STATUS_ACTIVE) return 'Active';
  if (status === STATUS_PAST_DUE) return 'Past due';
  if (status === STATUS_PAUSED) return 'Paused';
  if (status === STATUS_CANCELED) return 'Canceled';
  return 'Unknown';
}

function parseId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const idValue = (value as { id?: unknown }).id;
    return typeof idValue === 'string' ? idValue : null;
  }
  if (value && typeof value === 'object' && 'fields' in value) {
    const fields = (value as { fields?: { id?: unknown } }).fields;
    return typeof fields?.id === 'string' ? fields.id : null;
  }
  return null;
}

function showError(message: string) {
  return Swal.fire({
    icon: 'error',
    title: 'Oops',
    text: message,
    confirmButtonColor: '#2563eb',
  });
}

function showSuccess(message: string) {
  return Swal.fire({
    icon: 'success',
    title: 'Success',
    text: message,
    confirmButtonColor: '#2563eb',
  });
}

function showInfo(message: string) {
  return Swal.fire({
    icon: 'info',
    title: 'Heads up',
    text: message,
    confirmButtonColor: '#2563eb',
  });
}

async function showPlanCreatedResult(digest: string, planId: string | null) {
  const result = await Swal.fire({
    icon: 'success',
    title: 'Plan created',
    html: planId
      ? `<div style="text-align:left">
          <p style="margin:0 0 8px 0;"><strong>Plan ID</strong></p>
          <code style="word-break:break-all;display:block;margin-bottom:12px;">${planId}</code>
          <p style="margin:0;"><strong>Digest</strong></p>
          <code style="word-break:break-all;display:block;">${digest}</code>
        </div>`
      : `<div style="text-align:left">
          <p style="margin:0 0 8px 0;"><strong>Digest</strong></p>
          <code style="word-break:break-all;display:block;">${digest}</code>
          <p style="margin:12px 0 0 0;">Could not resolve Plan ID from this transaction.</p>
        </div>`,
    confirmButtonText: 'OK',
    showDenyButton: Boolean(planId),
    denyButtonText: 'Copy Plan ID',
    confirmButtonColor: '#2563eb',
    denyButtonColor: '#0ea5e9',
  });

  if (result.isDenied && planId) {
    await navigator.clipboard.writeText(planId);
    await showSuccess('Plan ID copied');
  }
}

export default function Home() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecuteTransaction } = useSignAndExecuteTransaction();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const { mutateAsync: signTransaction } = useSignTransaction();
  const client = useSuiClient();
  const { network } = useSuiClientContext();
  const [mode, setMode] = useState<'creator' | 'subscriber'>('creator');
  const [plans, setPlans] = useState<SuiObjectResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [subscribedPlanIds, setSubscribedPlanIds] = useState<Set<string>>(new Set());
  const [subscriptionsByPlanId, setSubscriptionsByPlanId] = useState<Record<string, SubscriptionInfo>>({});
  const [topUpAmountByPlanId, setTopUpAmountByPlanId] = useState<Record<string, string>>({});
  const [creatorPlans, setCreatorPlans] = useState<CreatorPlanInfo[]>([]);
  const [creatorPlansLoading, setCreatorPlansLoading] = useState(false);
  const [contentPlanId, setContentPlanId] = useState('');
  const [contentFile, setContentFile] = useState<File | null>(null);
  const [contentType, setContentType] = useState('application/octet-stream');
  const [walrusEpochs, setWalrusEpochs] = useState('3');
  const [contentPublishing, setContentPublishing] = useState(false);
  const [gatedContent, setGatedContent] = useState<GatedContentInfo[]>([]);
  const [contentLoading, setContentLoading] = useState(false);
  const [nowMs, setNowMs] = useState(INITIAL_NOW_MS);

  // Creator form
  const [planName, setPlanName] = useState('Monthly Premium Access');
  const [priceAmount, setPriceAmount] = useState('1');
  const [intervalDays, setIntervalDays] = useState('30');
  const [planCoinType, setPlanCoinType] = useState(COIN_OPTIONS[0]?.type ?? '0x2::sui::SUI');
  const [integrationPlanId, setIntegrationPlanId] = useState('');
  const [integrationSubscriber, setIntegrationSubscriber] = useState('');
  const [integrationResult, setIntegrationResult] = useState('');
  const [integrationChecking, setIntegrationChecking] = useState(false);

  const ensurePackageId = () => {
    if (!PACKAGE_ID) {
      void showError('Missing NEXT_PUBLIC_PACKAGE_ID in frontend/.env');
      return false;
    }
    return true;
  };

  const buildPaymentCoin = async (amountBase: bigint, coinType: string, tx: Transaction, avoidGasCoin = false) => {
    if (!account) throw new Error('Connect wallet first');
    
    // Add detailed diagnostics
    console.log("buildPaymentCoin diagnostic - network:", network);
    try {
      const allCoins = await client.getAllCoins({ owner: account.address });
      console.log("buildPaymentCoin diagnostic - ALL COINS:", allCoins.data.map(c => ({ coinType: c.coinType, balance: c.balance })));
    } catch (e) {
      console.error("buildPaymentCoin diagnostic - failed to fetch all coins:", e);
    }

    if (coinType === '0x2::sui::SUI' && !avoidGasCoin) {
      const [coin] = tx.splitCoins(tx.gas, [amountBase]);
      return coin;
    }

    const coins = await client.getCoins({
      owner: account.address,
      coinType,
      limit: 50,
    });
    const balances = coins.data.map((coin) => BigInt(coin.balance));
    const total = balances.reduce((sum, value) => sum + value, BigInt(0));
    console.log("buildPaymentCoin debug:", {
      owner: account.address,
      requestedCoinType: coinType,
      amountNeeded: amountBase.toString(),
      returnedCoins: coins.data,
      totalBalance: total.toString()
    });
    if (total < amountBase) {
      throw new Error('Insufficient balance for selected coin');
    }

    const sorted = coins.data.sort((a, b) => {
      const aBalance = BigInt(a.balance);
      const bBalance = BigInt(b.balance);
      if (aBalance === bBalance) return 0;
      return bBalance > aBalance ? 1 : -1;
    });
    const primary = sorted[0];
    const primaryCoin = tx.object(primary.coinObjectId);
    if (sorted.length > 1) {
      const mergeCoins = sorted.slice(1).map((coin) => tx.object(coin.coinObjectId));
      tx.mergeCoins(primaryCoin, mergeCoins);
    }
    const [coin] = tx.splitCoins(primaryCoin, [amountBase]);
    return coin;
  };

  useEffect(() => {
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  const fetchSubscribedPlans = async () => {
    if (!account) return;
    if (!ensurePackageId()) return;

    const createdEvents = [];
    let hasNextPage = true;
    let cursor: Awaited<ReturnType<typeof client.queryEvents>>['nextCursor'] = null;
    while (hasNextPage) {
      const created = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::subscription::SubscriptionCreated`,
        },
        cursor,
        limit: 200,
        order: 'descending',
      });
      createdEvents.push(...created.data);
      hasNextPage = created.hasNextPage;
      cursor = created.nextCursor ?? null;
    }

    const mySubscriptionIds = createdEvents
      .filter((evt) => {
        const subscriber = (evt.parsedJson as { subscriber?: string } | null)?.subscriber;
        return subscriber?.toLowerCase() === account.address.toLowerCase();
      })
      .map((evt) => (evt.parsedJson as { subscription_id?: string } | null)?.subscription_id)
      .filter((id): id is string => Boolean(id));

    if (mySubscriptionIds.length === 0) {
      setSubscribedPlanIds(new Set());
      setSubscriptionsByPlanId({});
      return;
    }

    const subscriptions = await client.multiGetObjects({
      ids: mySubscriptionIds,
      options: { showContent: true },
    });

    const nextSubscribedPlanIds = new Set<string>();
    const nextSubscriptionsByPlanId: Record<string, SubscriptionInfo> = {};
    subscriptions.forEach((obj) => {
      if (obj.error || !obj.data?.content || !('fields' in obj.data.content)) return;
      const fields = obj.data.content.fields as {
        plan_id?: string;
        escrow_id?: string;
        next_due?: string | number | bigint;
        grace_until?: string | number | bigint;
        status?: string | number | bigint;
        balance?: string | number | bigint | { fields?: { value?: string | number | bigint } };
      };
      const status = fields.status !== undefined ? Number(fields.status) : STATUS_ACTIVE;
      if (status === STATUS_CANCELED) return;
      const coinType = parseCoinType(obj.data.content.type);
      const coinConfig = getCoinConfig(coinType);
      const planId = parseId(fields.plan_id);
      if (planId && obj.data.objectId) {
        nextSubscribedPlanIds.add(planId);
        nextSubscriptionsByPlanId[planId] = {
          subscriptionId: obj.data.objectId,
          escrowId: fields.escrow_id ?? '',
          balanceBase: parseBalanceMist(fields.balance),
          nextDueMs: BigInt(fields.next_due ?? 0),
          graceUntilMs: BigInt(fields.grace_until ?? 0),
          status,
          coinType: coinType ?? '',
          coinSymbol: coinConfig?.label ?? 'UNKNOWN',
          coinDecimals: coinConfig?.decimals ?? 9,
        };
      }
    });
    setSubscribedPlanIds(nextSubscribedPlanIds);
    setSubscriptionsByPlanId(nextSubscriptionsByPlanId);
  };

  async function fetchAvailablePlans() {
    if (!account) return;
    if (!ensurePackageId()) return;
    setLoading(true);
    try {
      const createdEvents = [];
      let hasNextPage = true;
      let cursor: Awaited<ReturnType<typeof client.queryEvents>>['nextCursor'] = null;
      while (hasNextPage) {
        const created = await client.queryEvents({
          query: {
            MoveEventType: `${PACKAGE_ID}::subscription::PlanCreated`,
          },
          cursor,
          limit: 200,
          order: 'descending',
        });
        createdEvents.push(...created.data);
        hasNextPage = created.hasNextPage;
        cursor = created.nextCursor ?? null;
      }
      const planIds = Array.from(
        new Set(
          createdEvents
            .map((evt) => (evt.parsedJson as { plan_id?: string } | null)?.plan_id)
            .filter((id): id is string => Boolean(id)),
        ),
      );
      if (planIds.length === 0) {
        // Fallback for older deployments that don't emit PlanCreated yet.
        const ownedResults = await Promise.all(
          COIN_OPTIONS.map((coin) =>
            client.getOwnedObjects({
              owner: account.address,
              filter: { StructType: `${PACKAGE_ID}::subscription::SubscriptionPlan<${coin.type}>` },
              options: { showContent: true },
            }),
          ),
        );
        const owned = ownedResults.flatMap((result) => result.data);
        setPlans(owned);
        await fetchSubscribedPlans();
        await fetchGatedContent(
          owned
            .map((obj) => {
              const coinType = parseCoinType(obj.data?.content && 'type' in obj.data.content ? obj.data.content.type : null);
              return obj.data?.objectId
                ? ({
                    id: obj.data.objectId,
                    coinType: coinType ?? '',
                  } as CreatorPlanInfo)
                : null;
            })
            .filter((plan): plan is CreatorPlanInfo => Boolean(plan)),
        );
      } else {
        const objects = await client.multiGetObjects({
          ids: planIds,
          options: { showContent: true },
        });
        const available = objects.filter((obj) => !obj.error && obj.data?.objectId);
        setPlans(available);
        await fetchSubscribedPlans();
        await fetchGatedContent(
          available
            .map((obj) => {
              const coinType = parseCoinType(obj.data?.content && 'type' in obj.data.content ? obj.data.content.type : null);
              return obj.data?.objectId
                ? ({
                    id: obj.data.objectId,
                    coinType: coinType ?? '',
                  } as CreatorPlanInfo)
                : null;
            })
            .filter((plan): plan is CreatorPlanInfo => Boolean(plan)),
        );
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function fetchCreatorPlans() {
    if (!account) {
      setCreatorPlans([]);
      return;
    }
    if (!ensurePackageId()) return;
    setCreatorPlansLoading(true);
    try {
      const createdEvents = [];
      let hasNextPage = true;
      let cursor: Awaited<ReturnType<typeof client.queryEvents>>['nextCursor'] = null;
      while (hasNextPage) {
        const created = await client.queryEvents({
          query: {
            MoveEventType: `${PACKAGE_ID}::subscription::PlanCreated`,
          },
          cursor,
          limit: 200,
          order: 'descending',
        });
        createdEvents.push(...created.data);
        hasNextPage = created.hasNextPage;
        cursor = created.nextCursor ?? null;
      }

      const myPlanIds = Array.from(
        new Set(
          createdEvents
            .filter((evt) => {
              const merchant = (evt.parsedJson as { merchant?: string } | null)?.merchant;
              return merchant?.toLowerCase() === account.address.toLowerCase();
            })
            .map((evt) => (evt.parsedJson as { plan_id?: string } | null)?.plan_id)
            .filter((id): id is string => Boolean(id)),
        ),
      );

      if (myPlanIds.length === 0) {
        setCreatorPlans([]);
        return;
      }

      const planObjects = await client.multiGetObjects({
        ids: myPlanIds,
        options: { showContent: true },
      });
      const plans = planObjects
        .map((obj) => {
          if (!obj.data?.content || !('fields' in obj.data.content) || !obj.data.objectId) return null;
          const fields = obj.data.content.fields as {
            name?: string;
            price?: string | number | bigint;
            interval_ms?: string | number | bigint;
            active?: boolean;
          };
          const coinType = parseCoinType(obj.data.content.type);
          const coinConfig = getCoinConfig(coinType);
          return {
            id: obj.data.objectId,
            name: fields.name ?? 'Untitled Plan',
            priceBase: BigInt(fields.price ?? 0),
            intervalMs: BigInt(fields.interval_ms ?? 0),
            active: fields.active !== false,
            coinType: coinType ?? '',
            coinSymbol: coinConfig?.label ?? 'UNKNOWN',
            coinDecimals: coinConfig?.decimals ?? 9,
          } satisfies CreatorPlanInfo;
        })
        .filter((plan): plan is CreatorPlanInfo => Boolean(plan));
      setCreatorPlans(plans);
      if (!contentPlanId && plans[0]) setContentPlanId(plans[0].id);
      await fetchGatedContent(plans);
    } catch (e) {
      console.error(e);
      await showError('Failed to load creator profile plans');
    } finally {
      setCreatorPlansLoading(false);
    }
  }

  useEffect(() => {
    if (mode === 'creator') {
      queueMicrotask(() => {
        void fetchCreatorPlans();
      });
    }
    if (mode === 'subscriber') {
      queueMicrotask(() => {
        void fetchAvailablePlans();
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.address, mode]);

  async function fetchGatedContent(knownPlans?: CreatorPlanInfo[]) {
    if (!ensurePackageId()) return;
    setContentLoading(true);
    try {
      const planById = new Map((knownPlans ?? creatorPlans).map((plan) => [plan.id, plan]));
      const events = [];
      let hasNextPage = true;
      let cursor: Awaited<ReturnType<typeof client.queryEvents>>['nextCursor'] = null;
      while (hasNextPage) {
        const page = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::subscription::ContentPublished` },
          cursor,
          limit: 200,
          order: 'descending',
        });
        events.push(...page.data);
        hasNextPage = page.hasNextPage;
        cursor = page.nextCursor ?? null;
      }
      const parsed = events
        .map((evt) => parseContentEvent(evt.parsedJson as Parameters<typeof parseContentEvent>[0]))
        .filter((content): content is GatedContentRecord => Boolean(content))
        .filter((content) => planById.has(content.planId))
        .map((content) => ({ ...content, coinType: planById.get(content.planId)?.coinType ?? '' }));
      setGatedContent(parsed);
    } catch (error) {
      console.error(error);
    } finally {
      setContentLoading(false);
    }
  }

  const publishGatedContent = async () => {
    if (!account) {
      await showInfo('Connect wallet first');
      return;
    }
    if (!ensurePackageId()) return;
    if (!contentPlanId) {
      await showInfo('Choose a plan for this content');
      return;
    }
    if (!contentFile) {
      await showInfo('Choose a file to encrypt and upload');
      return;
    }
    const plan = creatorPlans.find((item) => item.id === contentPlanId);
    if (!plan?.coinType) {
      await showError('Missing coin type for selected plan');
      return;
    }
    const epochs = Number(walrusEpochs);
    if (!Number.isSafeInteger(epochs) || epochs <= 0) {
      await showError('Enter a valid Walrus storage duration in epochs');
      return;
    }

    setContentPublishing(true);
    try {
      const config = getContentGateConfig(PACKAGE_ID);
      const bytes = new Uint8Array(await contentFile.arrayBuffer());
      const sealIdHex = await createSealIdentity(contentPlanId, contentFile.name);
      const { encryptedObject } = await encryptWithSeal({ config, sealIdHex, bytes });
      const walrusClient = await createWalrusClient(config);
      const flow = walrusClient.walrus.writeBlobFlow({ blob: encryptedObject });
      await flow.encode();
      const registerTx = flow.register({ epochs, owner: account.address, deletable: false });
      const registered = await signAndExecuteTransaction({ transaction: registerTx, chain: `sui:${config.network}` });
      await flow.upload({ digest: registered.digest });
      const certifyTx = flow.certify();
      await signAndExecuteTransaction({ transaction: certifyTx, chain: `sui:${config.network}` });
      const certified = await flow.getBlob();

      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::subscription::publish_content`,
        typeArguments: [plan.coinType],
        arguments: [
          tx.object(contentPlanId),
          tx.pure.string(certified.blobId),
          tx.pure.string(certified.blobObjectId),
          tx.pure.vector('u8', Array.from(fromHex(sealIdHex))),
          tx.pure.string(contentType || contentFile.type || 'application/octet-stream'),
        ],
      });
      const result = await signAndExecuteTransaction({ transaction: tx, chain: `sui:${config.network}` });
      await showSuccess(`Content published. Digest: ${result.digest}`);
      await fetchGatedContent();
    } catch (error) {
      console.error(error);
      await showError(error instanceof Error ? error.message : 'Content publishing failed');
    } finally {
      setContentPublishing(false);
    }
  };

  const executeSponsoredTransaction = async (tx: Transaction) => {
    if (!account) throw new Error('Connect wallet first');
    if (!SPONSOR_URL) throw new Error('Missing NEXT_PUBLIC_SPONSOR_URL');
    tx.setSender(account.address);
    const transactionKindBytes = toBase64(await tx.build({ client, onlyTransactionKind: true }));
    const sponsorResponse = await fetch(`${SPONSOR_URL}/sponsor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: account.address, transactionKindBytes }),
    });
    if (!sponsorResponse.ok) throw new Error('Sponsor service rejected transaction');
    const sponsored = (await sponsorResponse.json()) as {
      transactionBytes: string;
      sponsorSignature: string;
    };
    const signed = await signTransaction({ transaction: sponsored.transactionBytes, chain: 'sui:testnet' });
    const executeResponse = await fetch(`${SPONSOR_URL}/execute-sponsored`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transactionBytes: sponsored.transactionBytes,
        userSignature: signed.signature,
        sponsorSignature: sponsored.sponsorSignature,
      }),
    });
    if (!executeResponse.ok) throw new Error('Sponsored transaction execution failed');
    return (await executeResponse.json()) as { digest: string };
  };

  const unlockGatedContent = async (content: GatedContentInfo) => {
    if (!account) return;
    if (!ensurePackageId()) return;
    const subscription = subscriptionsByPlanId[content.planId];
    if (!subscription) {
      await showInfo('Subscribe to this plan before opening the content');
      return;
    }

    // Pre-open a blank tab synchronously to bypass browser popup blockers
    const newTab = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    if (newTab) {
      newTab.document.write(`
        <html>
          <head>
            <title>Decrypting Vault Item...</title>
            <style>
              body {
                background-color: #000000;
                color: #fafafa;
                font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
              }
              .spinner {
                border: 2px solid #1f1f23;
                border-top: 2px solid #fafafa;
                border-radius: 50%;
                width: 24px;
                height: 24px;
                animation: spin 1s linear infinite;
                margin-bottom: 16px;
              }
              @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
              }
              .text {
                font-size: 11px;
                font-family: monospace;
                text-transform: uppercase;
                letter-spacing: 0.1em;
                color: #a1a1aa;
              }
            </style>
          </head>
          <body>
            <div class="spinner"></div>
            <div class="text">Decrypting vault item from Walrus...</div>
          </body>
        </html>
      `);
    }

    try {
      const config = getContentGateConfig(PACKAGE_ID);
      const encryptedBytes = await readWalrusBlob(config, content.walrusBlobId);
      const approvalTx = buildSealApprovalTransaction({
        packageId: PACKAGE_ID,
        coinType: subscription.coinType,
        sealIdHex: content.sealIdHex,
        contentId: content.contentId,
        subscriptionId: subscription.subscriptionId,
      });
      const plain = await decryptWithSeal({
        config,
        accountAddress: account.address,
        signPersonalMessage,
        encryptedBytes,
        approvalTx,
      });
      const blob = new Blob([new Uint8Array(plain)], { type: content.contentType });
      const url = URL.createObjectURL(blob);

      if (newTab) {
        newTab.location.href = url;
      } else {
        // Fallback to direct download if tab was blocked/not created
        const a = document.createElement('a');
        a.href = url;
        const extension = content.contentType.split('/')[1] || 'bin';
        a.download = `gated-content-${content.contentId.slice(0, 8)}.${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (error) {
      console.error(error);
      if (newTab) newTab.close();
      await showError('Access denied or decrypt failed. Confirm your subscription is active.');
    }
  };

  const createPlan = async () => {
    if (!account) {
      await showInfo('Connect wallet first');
      return;
    }
    if (!ensurePackageId()) return;
    const coinConfig = getCoinConfig(planCoinType);
    if (!coinConfig) {
      await showError('Select a valid coin type for this plan');
      return;
    }
    const priceBase = parseAmountToBaseUnits(priceAmount, coinConfig.decimals);
    const intervalMs = parseIntervalDaysToMs(intervalDays);
    if (priceBase === null) {
      await showError(`Enter a valid price in ${coinConfig.label} (up to ${coinConfig.decimals} decimals)`);
      return;
    }
    if (intervalMs === null) {
      await showError('Choose one of the available intervals: 7, 14, or 30 days');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::subscription::create_plan`,
      typeArguments: [coinConfig.type],
      arguments: [
        tx.pure.string(planName),
        tx.pure.u64(priceBase),
        tx.pure.u64(intervalMs),
      ],
    });

    try {
      const result = await signAndExecuteTransaction({ transaction: tx, chain: 'sui:testnet' });
      const txBlock = await client.getTransactionBlock({
        digest: result.digest,
        options: { showObjectChanges: true },
      });
      const createdPlan = txBlock.objectChanges?.find(
        (change) =>
          change.type === 'created' &&
          change.objectType === `${PACKAGE_ID}::subscription::SubscriptionPlan<${coinConfig.type}>`,
      );
      const planId = createdPlan && 'objectId' in createdPlan ? createdPlan.objectId : null;
      if (planId) setIntegrationPlanId(planId);
      await showPlanCreatedResult(result.digest, planId);
      await fetchCreatorPlans();
      if (mode === 'subscriber') fetchAvailablePlans();
    } catch (e) {
      await showError('Transaction failed while creating plan');
      console.error(e);
    }
  };

  const subscribeToPlan = async (planId: string, planPriceBase: bigint, coinType: string, coinSymbol: string) => {
    if (!account) return;
    if (!ensurePackageId()) return;
    if (!coinType) {
      await showError('Missing coin type for this plan');
      return;
    }
    const tx = new Transaction();

    const escrowDepositBase = planPriceBase * INITIAL_ESCROW_CYCLES;
    let escrowCoin;
    try {
      escrowCoin = await buildPaymentCoin(escrowDepositBase, coinType, tx, Boolean(SPONSOR_URL));
    } catch (error) {
      await showError(`Unable to prepare ${coinSymbol} for escrow: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return;
    }

    tx.moveCall({
      target: `${PACKAGE_ID}::subscription::subscribe`,
      typeArguments: [coinType],
      arguments: [
        tx.object(planId),
        escrowCoin,
        tx.object('0x6'), // Clock
      ],
    });

    try {
      const result = SPONSOR_URL
        ? await executeSponsoredTransaction(tx)
        : await signAndExecuteTransaction({ transaction: tx, chain: 'sui:testnet' });
      await showSuccess(`${SPONSOR_URL ? 'Subscribed with 0 gas' : 'Subscribed'}. Digest: ${result.digest}`);
      setSubscribedPlanIds((prev) => {
        const next = new Set(prev);
        next.add(planId);
        return next;
      });
      console.log('Subscription created — escrow funded, keeper will execute payments on schedule');
      await fetchSubscribedPlans();
    } catch (e) {
      await showError('Subscribe failed');
      console.error(e);
    }
  };

  const topUpSubscription = async (planId: string) => {
    if (!account) return;
    if (!ensurePackageId()) return;
    const subscription = subscriptionsByPlanId[planId];
    if (!subscription) return;
    if (!subscription.coinType) {
      await showError('Missing coin type for this subscription');
      return;
    }
    if (!subscription.escrowId) {
      await showError('Missing escrow vault for this subscription');
      return;
    }
    const amountBase = parseAmountToBaseUnits(topUpAmountByPlanId[planId] ?? '1', subscription.coinDecimals);
    if (amountBase === null) {
      await showError(`Enter a valid top-up amount in ${subscription.coinSymbol}`);
      return;
    }

    const tx = new Transaction();
    let coin;
    try {
      coin = await buildPaymentCoin(amountBase, subscription.coinType, tx);
    } catch (error) {
      await showError(`Unable to prepare ${subscription.coinSymbol} for top up: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return;
    }
    tx.moveCall({
      target: `${PACKAGE_ID}::subscription::top_up_escrow`,
      typeArguments: [subscription.coinType],
      arguments: [tx.object(subscription.escrowId), coin],
    });

    try {
      const result = await signAndExecuteTransaction({ transaction: tx, chain: 'sui:testnet' });
      await showSuccess(`Top up successful. Digest: ${result.digest}`);
      await fetchSubscribedPlans();
    } catch (e) {
      await showError('Top up failed');
      console.error(e);
    }
  };

  const cancelSubscription = async (planId: string) => {
    if (!account) return;
    if (!ensurePackageId()) return;
    const subscription = subscriptionsByPlanId[planId];
    if (!subscription) return;
    if (!subscription.coinType) {
      await showError('Missing coin type for this subscription');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::subscription::cancel`,
      typeArguments: [subscription.coinType],
      arguments: [tx.object(subscription.subscriptionId)],
    });

    try {
      const result = await signAndExecuteTransaction({ transaction: tx, chain: 'sui:testnet' });
      await showSuccess(`Subscription canceled. Digest: ${result.digest}`);
      await fetchSubscribedPlans();
    } catch (e) {
      await showError('Cancel failed');
      console.error(e);
    }
  };

  const resumeSubscription = async (planId: string) => {
    if (!account) return;
    if (!ensurePackageId()) return;
    const subscription = subscriptionsByPlanId[planId];
    if (!subscription) return;
    if (!subscription.coinType) {
      await showError('Missing coin type for this subscription');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::subscription::resume`,
      typeArguments: [subscription.coinType],
      arguments: [tx.object(subscription.subscriptionId), tx.object(planId), tx.object('0x6')],
    });

    try {
      const result = await signAndExecuteTransaction({ transaction: tx, chain: 'sui:testnet' });
      await showSuccess(`Subscription resumed. Digest: ${result.digest}`);
      await fetchSubscribedPlans();
    } catch (e) {
      await showError('Resume failed');
      console.error(e);
    }
  };

  const pausePlan = async (planId: string, coinType: string) => {
    if (!account) return;
    if (!ensurePackageId()) return;
    if (!coinType) {
      await showError('Missing coin type for this plan');
      return;
    }
    const confirmed = await Swal.fire({
      icon: 'warning',
      title: 'Pause this plan?',
      text: 'New subscriptions will be blocked. Existing subscribers can still cancel and withdraw remaining escrow.',
      showCancelButton: true,
      confirmButtonText: 'Pause plan',
      confirmButtonColor: '#dc2626',
      cancelButtonColor: '#374151',
    });
    if (!confirmed.isConfirmed) return;

    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::subscription::pause_plan`,
      typeArguments: [coinType],
      arguments: [tx.object(planId)],
    });

    try {
      const result = await signAndExecuteTransaction({ transaction: tx, chain: 'sui:testnet' });
      await showSuccess(`Plan paused. Digest: ${result.digest}`);
      await fetchCreatorPlans();
      if (mode === 'subscriber') await fetchAvailablePlans();
    } catch (e) {
      await showError('Pause plan failed');
      console.error(e);
    }
  };

  const checkProtocolAccess = async () => {
    if (!ensurePackageId()) return;
    const planId = integrationPlanId.trim();
    const subscriber = integrationSubscriber.trim();
    if (!planId) {
      await showInfo('Enter a plan ID to test protocol integration');
      return;
    }
    if (!subscriber) {
      await showInfo('Enter a subscriber address to test protocol integration');
      return;
    }

    setIntegrationChecking(true);
    try {
      const status = await getSubscriptionStatus({
        client,
        packageId: PACKAGE_ID,
        subscriber,
        planId,
      });

      if (!status) {
        setIntegrationResult('No subscription found for this user + plan.');
        return;
      }

      const activeAccess = hasActiveAccess(status) ? 'ALLOW' : 'DENY';
      const strictAccess = hasStrictAccess(status) ? 'ALLOW' : 'DENY';
      const statusLabel =
        status.status === STATUS_ACTIVE
          ? 'ACTIVE'
          : status.status === STATUS_PAST_DUE
            ? 'PAST_DUE'
            : status.status === STATUS_PAUSED
              ? 'PAUSED'
              : 'CANCELED';
      const nextDueIso = new Date(Number(status.nextDueMs)).toISOString();
      const graceIso = new Date(Number(status.graceUntilMs)).toISOString();
      const escrowBase = status.escrowBase.toString();

      setIntegrationResult(
        [
          `Subscription: ${status.subscriptionId}`,
          `Status: ${statusLabel}`,
          `Escrow (base units): ${escrowBase}`,
          `Next due: ${nextDueIso}`,
          `Grace until: ${graceIso}`,
          `Policy(active): ${activeAccess}`,
          `Policy(strict): ${strictAccess}`,
        ].join('\n'),
      );
    } catch (error) {
      setIntegrationResult('Failed to resolve subscription status. Check Package ID, Plan ID, and subscriber address.');
      console.error(error);
    } finally {
      setIntegrationChecking(false);
    }
  };

  return (
    <main className="min-h-screen bg-black text-zinc-50 pb-16">
      {/* Elegant Header */}
      <header className="border-b border-zinc-900 bg-black/80 backdrop-blur-md sticky top-0 z-50 mb-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="SuiSub Logo" className="w-10 h-10 object-contain" />
            <span className="text-lg font-semibold tracking-tight text-zinc-100">suisub</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-400 font-mono">1.0.0</span>
          </div>
          <div className="flex items-center gap-4">
            {account && (
              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span>{account.address.slice(0, 6)}...{account.address.slice(-4)}</span>
              </div>
            )}
            <ConnectButton />
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4">
        {/* Mode Selector - Sliding Pill Segmented Control */}
        <div className="flex justify-between items-center mb-8 gap-4 flex-wrap">
          <div className="relative p-1 bg-zinc-950 border border-zinc-850 rounded-xl flex w-full sm:w-[320px]">
            <div
              className="absolute top-1 bottom-1 rounded-lg bg-zinc-800 transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{
                left: mode === 'creator' ? '4px' : 'calc(50% + 2px)',
                width: 'calc(50% - 6px)',
              }}
            />
            <button
              onClick={() => {
                setMode('creator');
                if (account) void fetchCreatorPlans();
              }}
              className={`relative z-10 flex-1 py-2 text-xs font-semibold tracking-tight transition-colors duration-200 zinc-btn ${
                mode === 'creator' ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Creator Studio
            </button>
            <button
              onClick={() => {
                setMode('subscriber');
                if (account) void fetchAvailablePlans();
              }}
              className={`relative z-10 flex-1 py-2 text-xs font-semibold tracking-tight transition-colors duration-200 zinc-btn ${
                mode === 'subscriber' ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Subscriber Dashboard
            </button>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-zinc-550 font-mono">
            <span className={`w-1.5 h-1.5 rounded-full ${network === 'testnet' ? 'bg-zinc-700 animate-pulse' : 'bg-red-500 animate-pulse'}`} />
            <span>SUI {network?.toUpperCase() || 'UNKNOWN'} ACTIVE</span>
          </div>
        </div>

        {/* CREATOR MODE */}
        {mode === 'creator' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Left Column: Form Controls */}
            <div className="lg:col-span-6 space-y-8 animate-slide-up-fade" style={{ animationDelay: '0ms' }}>
              {/* Create Subscription Plan */}
              <div className="zinc-card p-6 md:p-8">
                <div className="flex items-center gap-2.5 mb-2">
                  <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  <h2 className="text-base font-semibold tracking-tight">Create Subscription Plan</h2>
                </div>
                <p className="text-xs text-zinc-400 mb-6">
                  Define the pricing model and token type for your premium tiers. Protocol fee is {PROTOCOL_FEE_PERCENT}% per cycle.
                </p>

                <div className="space-y-4">
                  <div>
                    <label className="block text-[10px] text-zinc-500 font-mono uppercase tracking-wider mb-1.5 font-medium">Plan Name</label>
                    <input
                      type="text"
                      value={planName}
                      onChange={(e) => setPlanName(e.target.value)}
                      className="w-full zinc-input rounded-lg px-3.5 py-2.5 outline-none text-xs"
                      placeholder="Plan name (e.g. Monthly Premium Access)"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-1">
                      <label className="block text-[10px] text-zinc-500 font-mono uppercase tracking-wider mb-1.5 font-medium">Price</label>
                      <input
                        type="text"
                        value={priceAmount}
                        onChange={(e) => setPriceAmount(e.target.value)}
                        className="w-full zinc-input rounded-lg px-3.5 py-2.5 outline-none text-xs"
                        placeholder="e.g. 1"
                      />
                    </div>
                    <div className="col-span-1">
                      <label className="block text-[10px] text-zinc-500 font-mono uppercase tracking-wider mb-1.5 font-medium">Coin</label>
                      <select
                        value={planCoinType}
                        onChange={(e) => setPlanCoinType(e.target.value)}
                        className="w-full zinc-input rounded-lg px-3.5 py-2.5 outline-none text-xs bg-zinc-950"
                      >
                        {COIN_OPTIONS.map((coin) => (
                          <option key={coin.type} value={coin.type}>
                            {coin.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-1">
                      <label className="block text-[10px] text-zinc-500 font-mono uppercase tracking-wider mb-1.5 font-medium">Interval</label>
                      <select
                        value={intervalDays}
                        onChange={(e) => setIntervalDays(e.target.value)}
                        className="w-full zinc-input rounded-lg px-3.5 py-2.5 outline-none text-xs bg-zinc-950"
                      >
                        {INTERVAL_OPTIONS.map((days) => (
                          <option key={days} value={days}>
                            {days} days
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <button
                    onClick={createPlan}
                    className="zinc-btn w-full bg-zinc-50 hover:bg-zinc-200 text-zinc-950 py-2.5 rounded-lg font-semibold text-xs border border-zinc-200/20 mt-2"
                  >
                    Create Plan on {COIN_OPTIONS.find((c) => c.type === planCoinType)?.label ?? 'Sui'}
                  </button>
                </div>
              </div>

              {/* Gate Gated Content */}
              <div className="zinc-card p-6 md:p-8">
                <div className="flex items-center gap-2.5 mb-2">
                  <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <h2 className="text-base font-semibold tracking-tight">Gate Premium Content</h2>
                </div>
                <p className="text-xs text-zinc-400 mb-6">
                  Upload and encrypt digital items via Walrus and SEAL. Only active subscribers to the selected plan can access it.
                </p>

                <div className="space-y-4">
                  <div>
                    <label className="block text-[10px] text-zinc-500 font-mono uppercase tracking-wider mb-1.5 font-medium">Select Plan Link</label>
                    <select
                      value={contentPlanId}
                      onChange={(e) => setContentPlanId(e.target.value)}
                      className="w-full zinc-input rounded-lg px-3.5 py-2.5 outline-none text-xs bg-zinc-950"
                    >
                      <option value="">Choose plan</option>
                      {creatorPlans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.name} ({plan.coinSymbol})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] text-zinc-500 font-mono uppercase tracking-wider mb-1.5 font-medium">Storage Duration (Epochs)</label>
                      <input
                        type="number"
                        min="1"
                        value={walrusEpochs}
                        onChange={(e) => setWalrusEpochs(e.target.value)}
                        className="w-full zinc-input rounded-lg px-3.5 py-2.5 outline-none text-xs"
                        placeholder="e.g. 3"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 font-mono uppercase tracking-wider mb-1.5 font-medium">MIME Content Type</label>
                      <input
                        type="text"
                        value={contentType}
                        onChange={(e) => setContentType(e.target.value)}
                        className="w-full zinc-input rounded-lg px-3.5 py-2.5 outline-none text-xs"
                        placeholder="application/octet-stream"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] text-zinc-500 font-mono uppercase tracking-wider mb-1.5 font-medium">Content File</label>
                    <label className="group relative flex flex-col items-center justify-center border border-dashed border-zinc-800 hover:border-zinc-700 bg-zinc-950 hover:bg-zinc-900/60 rounded-lg p-5 cursor-pointer transition-all duration-200">
                      <input
                        type="file"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0] ?? null;
                          setContentFile(file);
                          if (file?.type) setContentType(file.type);
                        }}
                      />
                      <svg className="w-6 h-6 text-zinc-550 group-hover:text-zinc-400 mb-2 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                      </svg>
                      <span className="text-xs text-zinc-300 font-medium truncate max-w-full">
                        {contentFile ? contentFile.name : 'Select content file to encrypt'}
                      </span>
                      <span className="text-[10px] text-zinc-550 mt-1 font-mono">
                        {contentFile ? `${(contentFile.size / 1024).toFixed(1)} KB` : 'Drag and drop or click to browse'}
                      </span>
                    </label>
                  </div>

                  <button
                    onClick={publishGatedContent}
                    disabled={contentPublishing}
                    className="zinc-btn w-full bg-zinc-50 hover:bg-zinc-200 disabled:bg-zinc-950 disabled:text-zinc-650 disabled:border-zinc-900 disabled:cursor-not-allowed text-zinc-950 py-2.5 rounded-lg font-semibold text-xs border border-zinc-200/20 mt-2"
                  >
                    {contentPublishing ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="animate-spin h-3.5 w-3.5 text-zinc-600" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Encrypting & Uploading to Walrus...
                      </span>
                    ) : (
                      'Encrypt with SEAL and Publish'
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Right Column: Display Information */}
            <div className="lg:col-span-6 space-y-8 animate-slide-up-fade" style={{ animationDelay: '100ms' }}>
              {/* Creator Active Plans */}
              <div className="zinc-card p-6 md:p-8">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-2.5">
                    <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                    <h3 className="text-base font-semibold tracking-tight">Active Plans</h3>
                  </div>
                  <button
                    onClick={() => void fetchCreatorPlans()}
                    className="zinc-btn flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg text-[10px] font-mono tracking-tight"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                    </svg>
                    SYNC
                  </button>
                </div>

                {creatorPlansLoading && (
                  <div className="space-y-3 py-2">
                    <div className="h-14 bg-zinc-900/60 rounded-lg animate-pulse" />
                    <div className="h-14 bg-zinc-900/60 rounded-lg animate-pulse" style={{ animationDelay: '50ms' }} />
                  </div>
                )}

                {!creatorPlansLoading && creatorPlans.length === 0 && (
                  <div className="border border-dashed border-zinc-850 rounded-lg p-6 text-center">
                    <p className="text-xs text-zinc-500 font-mono">No subscription tiers registered yet.</p>
                  </div>
                )}

                {!creatorPlansLoading && creatorPlans.length > 0 && (
                  <div className="space-y-3">
                    {creatorPlans.map((plan) => {
                      const priceDisplay = formatUnits(plan.priceBase, plan.coinDecimals);
                      const days = Number(plan.intervalMs) / 86_400_000;
                      return (
                        <div key={plan.id} className="rounded-lg border border-zinc-850 bg-zinc-900/40 p-4 hover:border-zinc-800 transition-all duration-250">
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <p className="font-semibold text-xs text-zinc-200">{plan.name}</p>
                              <p className="text-[11px] text-zinc-400 mt-1 font-mono">
                                {priceDisplay} {plan.coinSymbol} every {days} days
                              </p>
                              <div className="flex items-center gap-1.5 mt-2.5">
                                <span className="text-[9px] text-zinc-600 font-mono uppercase tracking-wider">Plan ID:</span>
                                <code className="text-[9px] text-zinc-400 font-mono bg-zinc-900 px-1.5 py-0.5 rounded border border-zinc-800/40 break-all select-all">{plan.id}</code>
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-2.5">
                              <span className={`text-[9px] font-mono tracking-wider px-2 py-0.5 rounded ${
                                plan.active 
                                  ? 'bg-zinc-900 text-zinc-300 border border-zinc-800' 
                                  : 'bg-rose-950/20 text-rose-450 border border-rose-900/30'
                              }`}>
                                {plan.active ? 'ACTIVE' : 'PAUSED'}
                              </span>
                              {plan.active && (
                                <button
                                  onClick={() => void pausePlan(plan.id, plan.coinType)}
                                  className="zinc-btn bg-transparent hover:bg-rose-950/10 border border-zinc-850 hover:border-rose-900/30 text-rose-400 px-2 py-1 rounded text-[10px] font-semibold"
                                >
                                  Pause
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Gated Content Records */}
              <div className="zinc-card p-6 md:p-8">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-2.5">
                    <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    <h3 className="text-base font-semibold tracking-tight">Gated Cryptographic Blobs</h3>
                  </div>
                  <button
                    onClick={() => void fetchGatedContent()}
                    className="zinc-btn flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg text-[10px] font-mono tracking-tight"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                    </svg>
                    SYNC
                  </button>
                </div>

                <div className="space-y-3">
                  {contentLoading && (
                    <div className="h-14 bg-zinc-900/60 rounded-lg animate-pulse" />
                  )}
                  {!contentLoading && gatedContent.length === 0 && (
                    <div className="border border-dashed border-zinc-850 rounded-lg p-6 text-center">
                      <p className="text-xs text-zinc-500 font-mono">No cryptographic uploads detected.</p>
                    </div>
                  )}
                  {!contentLoading && gatedContent.map((content) => (
                    <div key={content.contentId} className="rounded-lg border border-zinc-850 bg-zinc-900/40 p-4">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-[10px] font-mono font-semibold text-zinc-400">Walrus Blob ID:</span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 font-mono truncate max-w-[150px]">
                          {content.contentType}
                        </span>
                      </div>
                      <code className="text-[10px] text-zinc-350 font-mono break-all block bg-zinc-900/50 p-2 rounded border border-zinc-850 select-all">
                        {content.walrusBlobId}
                      </code>
                      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[9px] text-zinc-500 font-mono">
                        <span>Content ID: {content.contentId.slice(0, 10)}...</span>
                        <span>SEAL ID: {content.sealIdHex.slice(0, 10)}...</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Protocol Integration & Live Simulator */}
              <div className="zinc-card p-6 md:p-8">
                <div className="flex items-center gap-2.5 mb-2">
                  <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 17 12 22 22 17" />
                    <polyline points="2 12 12 17 22 12" />
                  </svg>
                  <h3 className="text-base font-semibold tracking-tight">Protocol Integration</h3>
                </div>
                <p className="text-xs text-zinc-400 mb-6">
                  Integrate recurring payments into external Sui applications to gate pages, APIs, or assets.
                </p>

                <div className="space-y-2 text-[10px] font-mono bg-zinc-900/50 p-4 rounded-lg border border-zinc-850 text-zinc-400">
                  <div><span className="text-zinc-600">PACKAGE_ID =</span> <span className="break-all text-zinc-300 font-semibold select-all">{PACKAGE_ID || 'Unconfigured'}</span></div>
                  <div className="h-px bg-zinc-900 my-2" />
                  <div><span className="text-zinc-600">PLAN_TYPE  =</span> <code className="text-zinc-400 break-all">{PACKAGE_ID || '0x...' }::subscription::SubscriptionPlan&lt;COIN_TYPE&gt;</code></div>
                  <div><span className="text-zinc-600">SUB_TYPE   =</span> <code className="text-zinc-400 break-all">{PACKAGE_ID || '0x...' }::subscription::Subscription&lt;COIN_TYPE&gt;</code></div>
                </div>

                <div className="mt-6 border border-zinc-850 bg-zinc-900/30 rounded-lg p-5 space-y-4">
                  <div className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                    <h4 className="font-semibold text-xs tracking-tight text-zinc-300">Live Integration Simulator</h4>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label className="block text-[9px] text-zinc-500 font-mono uppercase tracking-wider mb-1">Plan Object ID</label>
                      <input
                        type="text"
                        value={integrationPlanId}
                        onChange={(e) => setIntegrationPlanId(e.target.value)}
                        className="w-full zinc-input rounded-lg px-3 py-2 outline-none text-xs"
                        placeholder="0x..."
                      />
                    </div>
                    <div>
                      <label className="block text-[9px] text-zinc-500 font-mono uppercase tracking-wider mb-1">Subscriber Address</label>
                      <input
                        type="text"
                        value={integrationSubscriber}
                        onChange={(e) => setIntegrationSubscriber(e.target.value)}
                        className="w-full zinc-input rounded-lg px-3 py-2 outline-none text-xs"
                        placeholder="0x..."
                      />
                    </div>

                    <button
                      onClick={checkProtocolAccess}
                      disabled={integrationChecking}
                      className="zinc-btn w-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-200 py-2 rounded-lg text-xs font-semibold"
                    >
                      {integrationChecking ? 'Checking status...' : 'Run Access Verification'}
                    </button>

                    {integrationResult && (
                      <pre className="text-[10px] font-mono bg-zinc-950 border border-zinc-900 rounded-lg p-3.5 whitespace-pre-wrap break-all text-zinc-400">
                        {integrationResult}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SUBSCRIBER MODE */}
        {mode === 'subscriber' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Left Column: Tiers */}
            <div className="lg:col-span-7 space-y-6 animate-slide-up-fade" style={{ animationDelay: '0ms' }}>
              <div className="zinc-card p-6 md:p-8">
                <div className="flex items-center gap-2.5 mb-6">
                  <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="9" />
                    <rect x="14" y="3" width="7" height="5" />
                    <rect x="14" y="12" width="7" height="9" />
                    <rect x="3" y="16" width="7" height="5" />
                  </svg>
                  <h2 className="text-base font-semibold tracking-tight">Available Subscription Tiers</h2>
                </div>

                {loading && (
                  <div className="space-y-4 py-2">
                    <div className="h-20 bg-zinc-900/60 rounded-lg animate-pulse" />
                    <div className="h-20 bg-zinc-900/60 rounded-lg animate-pulse" style={{ animationDelay: '50ms' }} />
                  </div>
                )}

                {!loading && plans.length === 0 && (
                  <div className="border border-dashed border-zinc-850 rounded-lg p-8 text-center">
                    <p className="text-xs text-zinc-400">No active tiers published by creators.</p>
                    <p className="text-[10px] text-zinc-500 mt-2 font-mono">Create a tier under Creator Studio first.</p>
                  </div>
                )}

                {!loading && plans.map((plan) => {
                  const fields = (plan.data?.content && 'fields' in plan.data.content ? plan.data.content.fields : null) as {
                    name?: string;
                    price?: string | number | bigint;
                    interval_ms?: string | number | bigint;
                    active?: boolean;
                  } | null;
                  const coinType = parseCoinType(plan.data?.content && 'type' in plan.data.content ? plan.data.content.type : null);
                  const coinConfig = getCoinConfig(coinType);
                  const coinSymbol = coinConfig?.label ?? 'UNKNOWN';
                  const coinDecimals = coinConfig?.decimals ?? 9;
                  const planIntervalDays = Number(fields?.interval_ms ?? 0) / 86_400_000;
                  const planPriceBase = BigInt(fields?.price ?? 0);
                  const priceDisplay = formatUnits(planPriceBase, coinDecimals);
                  const planActive = fields?.active !== false;
                  const planId = plan.data?.objectId;
                  if (!fields || !planId) return null;

                  const canSubscribe = Boolean(coinType);
                  const activeSub = subscribedPlanIds.has(planId);

                  return (
                    <div key={planId} className="border border-zinc-850 bg-zinc-900/30 rounded-xl p-5 mb-4 hover:border-zinc-800 transition-all duration-200">
                      <div className="flex flex-col sm:flex-row justify-between sm:items-start gap-4">
                        <div>
                          <h3 className="font-semibold text-sm text-zinc-200">{fields.name}</h3>
                          <p className="text-zinc-400 text-xs mt-1.5">
                            Price: <span className="text-zinc-100 font-semibold">{priceDisplay} {coinSymbol}</span> every {planIntervalDays} days
                          </p>
                          <p className="text-[9px] text-zinc-500 mt-1 font-mono">
                            Includes 1% fee • Protocol Rules (3d Grace, 12h Retry, 3 Max Failures)
                          </p>
                          {!planActive && (
                            <span className="inline-block mt-2 text-[10px] text-amber-500 bg-amber-950/10 border border-amber-900/30 px-2 py-0.5 rounded font-mono">
                              PAUSED BY CREATOR
                            </span>
                          )}
                        </div>

                        <div className="shrink-0 sm:text-right">
                          {activeSub ? (
                            <span className="inline-flex items-center gap-1.5 text-[9px] font-semibold bg-zinc-900 text-zinc-300 border border-zinc-800 px-2.5 py-1 rounded-md font-mono">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              SUBSCRIBED
                            </span>
                          ) : !planActive ? (
                            <button disabled className="bg-zinc-950 text-zinc-650 border border-zinc-900 px-4 py-1.5 rounded-lg text-xs font-medium cursor-not-allowed">
                              Paused
                            </button>
                          ) : (
                            <button
                              onClick={() => subscribeToPlan(planId, planPriceBase, coinType ?? '0x2::sui::SUI', coinSymbol)}
                              disabled={!canSubscribe}
                              className="zinc-btn px-4 py-1.5 rounded-lg text-xs font-semibold bg-zinc-50 hover:bg-zinc-200 text-zinc-950 border border-zinc-200/10"
                            >
                              Subscribe
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right Column: Subscriber Details */}
            <div className="lg:col-span-5 space-y-6 animate-slide-up-fade" style={{ animationDelay: '100ms' }}>
              {/* Active Escrows */}
              <div className="zinc-card p-6 md:p-8">
                <div className="flex items-center gap-2.5 mb-6">
                  <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <h2 className="text-base font-semibold tracking-tight">Active Subscriptions</h2>
                </div>

                {Object.keys(subscriptionsByPlanId).length === 0 ? (
                  <div className="border border-dashed border-zinc-850 rounded-lg p-6 text-center">
                    <p className="text-xs text-zinc-500 font-mono">No active subscriptions found.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {plans.map((plan) => {
                      const planId = plan.data?.objectId;
                      if (!planId) return null;
                      const subscription = subscriptionsByPlanId[planId];
                      if (!subscription) return null;

                      const dueInDays = Math.max(0, Math.ceil((Number(subscription.nextDueMs) - nowMs) / 86_400_000));
                      const graceDaysLeft = Math.max(0, Math.ceil((Number(subscription.graceUntilMs) - nowMs) / 86_400_000));
                      const escrowDisplay = formatUnits(subscription.balanceBase, subscription.coinDecimals);
                      const statusLabel = getStatusLabel(subscription.status);
                      const fields = (plan.data?.content && 'fields' in plan.data.content ? plan.data.content.fields : null) as {
                        name?: string;
                      } | null;

                      return (
                        <div key={subscription.subscriptionId} className="border border-zinc-850 bg-zinc-900/40 p-4 rounded-lg space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-xs text-zinc-200">{fields?.name ?? 'Plan'}</span>
                            <span className={`text-[9px] font-mono px-2 py-0.5 rounded ${
                              subscription.status === STATUS_ACTIVE 
                                ? 'bg-zinc-900 text-zinc-300 border border-zinc-800' 
                                : 'bg-rose-950/20 text-rose-450 border border-rose-900/30'
                            }`}>
                              {statusLabel.toUpperCase()}
                            </span>
                          </div>

                          <div className="text-[11px] space-y-1.5 text-zinc-400 border-t border-zinc-900 pt-2.5">
                            <div className="flex justify-between">
                              <span className="text-zinc-500">Escrow Balance:</span>
                              <span className="font-mono text-zinc-200 font-semibold">{escrowDisplay} {subscription.coinSymbol}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-zinc-500">Next Cycle:</span>
                              <span className="font-mono text-zinc-200">{dueInDays} day(s)</span>
                            </div>
                            {subscription.status === STATUS_PAST_DUE && (
                              <div className="flex justify-between text-rose-400">
                                <span>Grace ends in:</span>
                                <span className="font-mono font-semibold">{graceDaysLeft} day(s)</span>
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-2 border-t border-zinc-900 pt-2.5">
                            <input
                              type="text"
                              value={topUpAmountByPlanId[planId] ?? '1'}
                              onChange={(e) =>
                                setTopUpAmountByPlanId((prev) => ({ ...prev, [planId]: e.target.value }))
                              }
                              className="w-16 zinc-input rounded px-2 py-1 outline-none text-[11px] bg-zinc-900"
                              placeholder={subscription.coinSymbol}
                            />
                            <button
                              onClick={() => topUpSubscription(planId)}
                              className="zinc-btn bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-200 px-2.5 py-1 rounded text-[10px] font-medium"
                            >
                              Top up
                            </button>
                            {subscription.status === STATUS_PAUSED && (
                              <button
                                onClick={() => resumeSubscription(planId)}
                                className="zinc-btn bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-200 px-2.5 py-1 rounded text-[10px] font-medium ml-auto"
                              >
                                Resume
                              </button>
                            )}
                            <button
                              onClick={() => cancelSubscription(planId)}
                              className="zinc-btn bg-transparent hover:bg-zinc-900 border border-zinc-900 text-zinc-500 hover:text-zinc-400 px-2.5 py-1 rounded text-[10px] font-medium ml-auto"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Decrypted Vault Items */}
              <div className="zinc-card p-6 md:p-8">
                <div className="flex items-center gap-2.5 mb-6">
                  <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <h2 className="text-base font-semibold tracking-tight">Decrypted Vault Items</h2>
                </div>

                <div className="space-y-3">
                  {Object.keys(subscriptionsByPlanId).length === 0 ? (
                    <div className="border border-dashed border-zinc-850 rounded-lg p-6 text-center">
                      <p className="text-xs text-zinc-500 font-mono">Subscribe to unlock premium files.</p>
                    </div>
                  ) : (
                    plans.map((plan) => {
                      const planId = plan.data?.objectId;
                      if (!planId) return null;
                      const contentForPlan = gatedContent.filter((content) => content.planId === planId);
                      if (contentForPlan.length === 0) return null;
                      const fields = (plan.data?.content && 'fields' in plan.data.content ? plan.data.content.fields : null) as {
                        name?: string;
                      } | null;

                      return (
                        <div key={planId} className="border border-zinc-850 bg-zinc-900/40 p-4 rounded-lg space-y-2">
                          <span className="font-semibold text-[10px] text-zinc-500 uppercase tracking-wider block font-mono">{fields?.name} Content</span>
                          <div className="space-y-2">
                            {contentForPlan.map((content) => (
                              <div key={content.contentId} className="flex items-center justify-between gap-3 text-xs bg-zinc-900/40 border border-zinc-900 rounded-lg p-3">
                                <span className="break-all font-mono text-[10px] text-zinc-400">{content.walrusBlobId.slice(0, 18)}...</span>
                                <button
                                  onClick={() => void unlockGatedContent(content)}
                                  className="zinc-btn shrink-0 bg-zinc-50 hover:bg-zinc-200 text-zinc-950 px-3 py-1 rounded-md text-[10px] font-semibold"
                                >
                                  Decrypt & Open
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mt-20 mb-8 text-[9px] text-zinc-600 text-center font-mono uppercase tracking-widest">
          Package: {PACKAGE_ID ? `${PACKAGE_ID.slice(0, 12)}...` : 'not set'} • Relayer Active • Network: {network ? network.charAt(0).toUpperCase() + network.slice(1) : (process.env.NEXT_PUBLIC_SUI_NETWORK || 'Testnet')}
        </div>
      </div>
    </main>
  );
}
