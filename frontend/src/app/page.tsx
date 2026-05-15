'use client';

import { useEffect, useState } from 'react';
import { ConnectButton, useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import type { SuiObjectResponse } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import Swal from 'sweetalert2';
import { getSubscriptionStatus, hasActiveAccess, hasStrictAccess } from '../lib/subsuiProtocol';

const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID?.trim() ?? '';
const MIST_PER_SUI = BigInt(1_000_000_000);
const MS_PER_DAY = BigInt(86_400_000);
const INTERVAL_OPTIONS = ["7", "14", "30"] as const;
const INITIAL_ESCROW_CYCLES = BigInt(1);
const PROTOCOL_FEE_PERCENT = 1;
const PROTOCOL_FIXED_FEE_SUI = 0.005;
type SubscriptionInfo = {
  subscriptionId: string;
  balanceMist: bigint;
  nextDueMs: bigint;
  active: boolean;
};
type CreatorPlanInfo = {
  id: string;
  name: string;
  priceMist: bigint;
  intervalMs: bigint;
  active: boolean;
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

function parseSuiToMist(input: string): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,9})?$/.test(trimmed)) return null;

  const [wholePart, fractionalPart = ""] = trimmed.split(".");
  const whole = BigInt(wholePart) * MIST_PER_SUI;
  const fractional = BigInt(fractionalPart.padEnd(9, "0"));
  return whole + fractional;
}

function parseDaysToMs(input: string): bigint | null {
  const trimmed = input.trim();
  if (!INTERVAL_OPTIONS.includes(trimmed as (typeof INTERVAL_OPTIONS)[number])) return null;
  return BigInt(trimmed) * MS_PER_DAY;
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
  const client = useSuiClient();
  const [mode, setMode] = useState<'creator' | 'subscriber'>('creator');
  const [plans, setPlans] = useState<SuiObjectResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [subscribedPlanIds, setSubscribedPlanIds] = useState<Set<string>>(new Set());
  const [subscriptionsByPlanId, setSubscriptionsByPlanId] = useState<Record<string, SubscriptionInfo>>({});
  const [topUpSuiByPlanId, setTopUpSuiByPlanId] = useState<Record<string, string>>({});
  const [creatorPlans, setCreatorPlans] = useState<CreatorPlanInfo[]>([]);
  const [creatorPlansLoading, setCreatorPlansLoading] = useState(false);

  // Creator form
  const [planName, setPlanName] = useState('Monthly Premium Access');
  const [priceSui, setPriceSui] = useState('1');
  const [intervalDays, setIntervalDays] = useState('30');
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

  useEffect(() => {
    if (!account) {
      setCreatorPlans([]);
      return;
    }
    if (mode === 'creator') {
      void fetchCreatorPlans();
    }
    if (mode === 'subscriber') {
      void fetchAvailablePlans();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.address, mode]);

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
        active?: boolean;
        plan_id?: string;
        next_due?: string | number | bigint;
        balance?: string | number | bigint | { fields?: { value?: string | number | bigint } };
      };
      if (fields.active && fields.plan_id && obj.data.objectId) {
        nextSubscribedPlanIds.add(fields.plan_id);
        nextSubscriptionsByPlanId[fields.plan_id] = {
          subscriptionId: obj.data.objectId,
          balanceMist: parseBalanceMist(fields.balance),
          nextDueMs: BigInt(fields.next_due ?? 0),
          active: true,
        };
      }
    });
    setSubscribedPlanIds(nextSubscribedPlanIds);
    setSubscriptionsByPlanId(nextSubscriptionsByPlanId);
  };

  const fetchAvailablePlans = async () => {
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
        const owned = await client.getOwnedObjects({
          owner: account.address,
          filter: { StructType: `${PACKAGE_ID}::subscription::SubscriptionPlan<0x2::sui::SUI>` },
          options: { showContent: true },
        });
        setPlans(owned.data);
        await fetchSubscribedPlans();
      } else {
        const objects = await client.multiGetObjects({
          ids: planIds,
          options: { showContent: true },
        });
        setPlans(objects.filter((obj) => !obj.error && obj.data?.objectId));
        await fetchSubscribedPlans();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const fetchCreatorPlans = async () => {
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
          return {
            id: obj.data.objectId,
            name: fields.name ?? 'Untitled Plan',
            priceMist: BigInt(fields.price ?? 0),
            intervalMs: BigInt(fields.interval_ms ?? 0),
            active: fields.active !== false,
          } satisfies CreatorPlanInfo;
        })
        .filter((plan): plan is CreatorPlanInfo => Boolean(plan));
      setCreatorPlans(plans);
    } catch (e) {
      console.error(e);
      await showError('Failed to load creator profile plans');
    } finally {
      setCreatorPlansLoading(false);
    }
  };

  const createPlan = async () => {
    if (!account) {
      await showInfo('Connect wallet first');
      return;
    }
    if (!ensurePackageId()) return;
    const priceMist = parseSuiToMist(priceSui);
    const intervalMs = parseDaysToMs(intervalDays);
    if (priceMist === null) {
      await showError('Enter a valid price in SUI (up to 9 decimal places)');
      return;
    }
    if (intervalMs === null) {
      await showError('Choose one of the available intervals: 7, 14, or 30 days');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::subscription::create_plan`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx.pure.string(planName),
        tx.pure.u64(priceMist),
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
          change.objectType === `${PACKAGE_ID}::subscription::SubscriptionPlan<0x2::sui::SUI>`,
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

  const subscribeToPlan = async (planId: string, planPriceMist: bigint) => {
    if (!account) return;
    if (!ensurePackageId()) return;
    const tx = new Transaction();

    const escrowDepositMist = planPriceMist * INITIAL_ESCROW_CYCLES;
    const [firstPaymentCoin, escrowCoin] = tx.splitCoins(tx.gas, [planPriceMist, escrowDepositMist]);

    tx.moveCall({
      target: `${PACKAGE_ID}::subscription::subscribe`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx.object(planId),
        firstPaymentCoin,
        escrowCoin,
        tx.object('0x6'), // Clock
      ],
    });

    try {
      const result = await signAndExecuteTransaction({ transaction: tx, chain: 'sui:testnet' });
      await showSuccess(`Subscribed. Digest: ${result.digest}`);
      setSubscribedPlanIds((prev) => {
        const next = new Set(prev);
        next.add(planId);
        return next;
      });
      console.log('Subscription created — first cycle paid, and next cycle pre-funded in escrow');
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
    const amountMist = parseSuiToMist(topUpSuiByPlanId[planId] ?? '1');
    if (amountMist === null) {
      await showError('Enter a valid top-up amount in SUI');
      return;
    }

    const tx = new Transaction();
    const [coin] = tx.splitCoins(tx.gas, [amountMist]);
    tx.moveCall({
      target: `${PACKAGE_ID}::subscription::top_up`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [tx.object(subscription.subscriptionId), coin],
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

    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::subscription::cancel`,
      typeArguments: ['0x2::sui::SUI'],
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

  const pausePlan = async (planId: string) => {
    if (!account) return;
    if (!ensurePackageId()) return;
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
      typeArguments: ['0x2::sui::SUI'],
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
      const nextDueIso = new Date(Number(status.nextDueMs)).toISOString();
      const escrowSui = Number(status.escrowMist) / 1_000_000_000;

      setIntegrationResult(
        [
          `Subscription: ${status.subscriptionId}`,
          `Active flag: ${status.active}`,
          `Escrow: ${escrowSui} SUI`,
          `Next due: ${nextDueIso}`,
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
    <main className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-4xl font-bold">suisub</h1>
          <div className="flex items-center gap-4">
            <ConnectButton />
            {account && <span className="text-sm text-gray-400 truncate max-w-[180px]">{account.address}</span>}
          </div>
        </div>

        <div className="flex gap-4 mb-8 border-b border-gray-800">
          <button
            onClick={() => {
              setMode('creator');
              if (account) void fetchCreatorPlans();
            }}
            className={`px-6 py-3 font-medium ${mode === 'creator' ? 'border-b-2 border-blue-500 text-blue-400' : 'text-gray-400'}`}
          >
            Creator Mode
          </button>
          <button
            onClick={() => {
              setMode('subscriber');
              if (account) void fetchAvailablePlans();
            }}
            className={`px-6 py-3 font-medium ${mode === 'subscriber' ? 'border-b-2 border-blue-500 text-blue-400' : 'text-gray-400'}`}
          >
            Subscriber Mode
          </button>
        </div>

        {/* CREATOR MODE */}
        {mode === 'creator' && (
          <div className="space-y-6">
            <div className="bg-gray-900 rounded-3xl p-8">
              <h2 className="text-2xl mb-6">Create Subscription Plan</h2>
              <p className="text-sm text-gray-400 mb-4">
                Protocol fee: {PROTOCOL_FEE_PERCENT}% + {PROTOCOL_FIXED_FEE_SUI} SUI per payment (sent to protocol treasury).
              </p>
              <div className="space-y-6">
                <input type="text" value={planName} onChange={e => setPlanName(e.target.value)} className="w-full bg-gray-800 rounded-2xl px-4 py-4 outline-none" placeholder="Plan name" />
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm mb-2">Price (SUI)</label>
                    <input type="text" value={priceSui} onChange={e => setPriceSui(e.target.value)} className="w-full bg-gray-800 rounded-2xl px-4 py-4 outline-none" placeholder="e.g. 1" />
                  </div>
                  <div>
                    <label className="block text-sm mb-2">Interval (days)</label>
                    <select value={intervalDays} onChange={e => setIntervalDays(e.target.value)} className="w-full bg-gray-800 rounded-2xl px-4 py-4 outline-none">
                      {INTERVAL_OPTIONS.map((days) => (
                        <option key={days} value={days}>
                          Every {days} days
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <button onClick={createPlan} className="w-full bg-blue-600 hover:bg-blue-700 py-5 rounded-3xl font-semibold text-lg">Create Plan on Sui</button>
              </div>
            </div>

            <div className="bg-gray-900 rounded-3xl p-8">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-semibold">Creator Profile</h3>
                <button
                  onClick={() => void fetchCreatorPlans()}
                  className="text-sm bg-gray-800 hover:bg-gray-700 px-3 py-2 rounded-xl"
                >
                  Refresh
                </button>
              </div>
              <p className="text-sm text-gray-400 mb-4">Your plans live here. If you have not created any, this stays empty.</p>
              {creatorPlansLoading && <p className="text-sm text-gray-300">Loading your creator plans...</p>}
              {!creatorPlansLoading && creatorPlans.length === 0 && (
                <p className="text-sm text-gray-400">No creator plans found for this wallet.</p>
              )}
              {!creatorPlansLoading && creatorPlans.length > 0 && (
                <div className="space-y-3">
                  {creatorPlans.map((plan) => {
                    const priceSuiValue = Number(plan.priceMist) / 1_000_000_000;
                    const days = Number(plan.intervalMs) / 86_400_000;
                    return (
                      <div key={plan.id} className="rounded-2xl border border-gray-800 p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="font-semibold">{plan.name}</p>
                            <p className="text-sm text-gray-400">{priceSuiValue} SUI every {days} day(s)</p>
                            <p className="text-xs text-gray-500 break-all mt-2">Plan ID: {plan.id}</p>
                          </div>
                          <div className="flex flex-col items-end gap-2">
                            <span className={`text-xs px-2 py-1 rounded-full ${plan.active ? 'bg-emerald-900 text-emerald-300' : 'bg-amber-900 text-amber-300'}`}>
                              {plan.active ? 'Active' : 'Paused'}
                            </span>
                            {plan.active ? (
                              <button
                                onClick={() => void pausePlan(plan.id)}
                                className="bg-rose-700 hover:bg-rose-800 px-3 py-2 rounded-xl text-sm font-semibold"
                              >
                                Pause
                              </button>
                            ) : (
                              <button
                                disabled
                                className="bg-gray-700 px-3 py-2 rounded-xl text-sm text-gray-300 cursor-not-allowed"
                              >
                                Paused
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

            <div className="bg-gray-900 rounded-3xl p-8">
              <h3 className="text-xl font-semibold mb-4">Protocol Integration (for Creators)</h3>
              <p className="text-sm text-gray-300 mb-4">
                Share this with any Sui app that wants to gate access using your plans.
              </p>
              <div className="space-y-3 text-sm">
                <p><span className="text-gray-400">Package ID:</span> <span className="break-all">{PACKAGE_ID || 'Set NEXT_PUBLIC_PACKAGE_ID in frontend/.env'}</span></p>
                <p><span className="text-gray-400">Plan type:</span> <code>{'{PACKAGE_ID}::subscription::SubscriptionPlan<0x2::sui::SUI>'}</code></p>
                <p><span className="text-gray-400">Subscription type:</span> <code>{'{PACKAGE_ID}::subscription::Subscription<0x2::sui::SUI>'}</code></p>
                <p><span className="text-gray-400">Events:</span> <code>PlanCreated</code>, <code>SubscriptionCreated</code>, <code>PaymentExecuted</code>, <code>SubscriptionCanceled</code></p>
              </div>
              <div className="mt-4 rounded-2xl bg-gray-950 border border-gray-800 p-4 text-xs overflow-x-auto">
                <pre className="whitespace-pre-wrap">{`Integration check:
1) Find user subscription via SubscriptionCreated events (subscriber + plan_id)
2) Fetch subscription object
3) Allow access if subscription.active == true
4) Optional strict mode: also require next_due > now`}</pre>
              </div>
              <div className="mt-4 border border-gray-800 rounded-2xl p-4 space-y-3">
                <h4 className="font-semibold">Live integration test</h4>
                <input
                  type="text"
                  value={integrationPlanId}
                  onChange={(e) => setIntegrationPlanId(e.target.value)}
                  className="w-full bg-gray-800 rounded-xl px-3 py-3 outline-none text-sm"
                  placeholder="Plan ID (0x...)"
                />
                <input
                  type="text"
                  value={integrationSubscriber}
                  onChange={(e) => setIntegrationSubscriber(e.target.value)}
                  className="w-full bg-gray-800 rounded-xl px-3 py-3 outline-none text-sm"
                  placeholder="Subscriber address (0x...)"
                />
                <button
                  onClick={checkProtocolAccess}
                  disabled={integrationChecking}
                  className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-900 px-4 py-2 rounded-xl font-semibold text-sm"
                >
                  {integrationChecking ? 'Checking...' : 'Run protocol access check'}
                </button>
                {integrationResult && (
                  <pre className="text-xs bg-gray-950 border border-gray-800 rounded-xl p-3 whitespace-pre-wrap break-all">
                    {integrationResult}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )}

        {/* SUBSCRIBER MODE */}
        {mode === 'subscriber' && (
          <div className="bg-gray-900 rounded-3xl p-8">
            <h2 className="text-2xl mb-6">Available Plans</h2>
            {loading && <p>Loading your plans...</p>}
            {!loading && plans.length === 0 && <p className="text-gray-400">No plans yet. Switch to Creator Mode and create one.</p>}
            
            {plans.map((plan) => {
              const fields = (plan.data?.content && 'fields' in plan.data.content ? plan.data.content.fields : null) as {
                name?: string;
                price?: string | number | bigint;
                interval_ms?: string | number | bigint;
                active?: boolean;
              } | null;
              const priceInSui = Number(fields?.price ?? 0) / 1_000_000_000;
              const planIntervalDays = Number(fields?.interval_ms ?? 0) / 86_400_000;
              const planPriceMist = BigInt(fields?.price ?? 0);
              const planActive = fields?.active !== false;
              const planId = plan.data?.objectId;
              if (!fields || !planId) return null;
              const subscription = subscriptionsByPlanId[planId];
              const dueInDays = subscription ? Math.max(0, Math.ceil((Number(subscription.nextDueMs) - Date.now()) / 86_400_000)) : null;
              const escrowSui = subscription ? Number(subscription.balanceMist) / 1_000_000_000 : null;

              return (
                <div key={planId} className="border border-gray-700 rounded-2xl p-6 mb-6">
                  <div className="flex justify-between">
                    <div>
                      <h3 className="font-semibold text-xl">{fields.name}</h3>
                      <p className="text-gray-400 text-sm">Price: {priceInSui} SUI every {planIntervalDays} days</p>
                      <p className="text-gray-500 text-xs mt-1">Includes protocol fee: {PROTOCOL_FEE_PERCENT}% + {PROTOCOL_FIXED_FEE_SUI} SUI</p>
                      {!planActive && <p className="text-amber-400 text-sm mt-1">Plan is paused by creator (new subscriptions disabled)</p>}
                      {subscription && (
                        <p className="text-gray-300 text-sm mt-1">
                          Escrow: {escrowSui} SUI • Next charge in {dueInDays} day(s)
                        </p>
                      )}
                    </div>
                    {subscribedPlanIds.has(planId) ? (
                      <div className="flex flex-col gap-2 items-end">
                        <button
                          disabled
                          className="bg-gray-700 px-8 py-3 rounded-2xl font-semibold text-gray-300 cursor-not-allowed"
                        >
                          Subscribed
                        </button>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={topUpSuiByPlanId[planId] ?? '1'}
                            onChange={(e) =>
                              setTopUpSuiByPlanId((prev) => ({ ...prev, [planId]: e.target.value }))
                            }
                            className="w-24 bg-gray-800 rounded-xl px-3 py-2 outline-none text-sm"
                            placeholder="SUI"
                          />
                          <button
                            onClick={() => topUpSubscription(planId)}
                            className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-xl font-semibold text-sm"
                          >
                            Top up
                          </button>
                        </div>
                        <button
                          onClick={() => cancelSubscription(planId)}
                          className="bg-rose-700 hover:bg-rose-800 px-4 py-2 rounded-xl font-semibold text-sm"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : !planActive ? (
                      <button
                        disabled
                        className="bg-gray-700 px-8 py-3 rounded-2xl font-semibold text-gray-300 cursor-not-allowed"
                      >
                        Paused
                      </button>
                    ) : (
                      <button
                        onClick={() => subscribeToPlan(planId, planPriceMist)}
                        className="bg-emerald-600 hover:bg-emerald-700 px-8 py-3 rounded-2xl font-semibold"
                      >
                        Subscribe Now
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-12 text-xs text-gray-500 text-center">
          Package: {PACKAGE_ID ? `${PACKAGE_ID.slice(0, 12)}...` : 'not set'} • Relayer running • Testnet
        </div>
      </div>
    </main>
  );
}
