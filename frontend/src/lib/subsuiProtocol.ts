import type { SuiObjectResponse, SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

type SubscriptionEvent = {
  subscriber?: string;
  plan_id?: string;
  subscription_id?: string;
};

export type ProtocolSubscriptionStatus = {
  subscriptionId: string;
  planId: string;
  active: boolean;
  nextDueMs: bigint;
  escrowMist: bigint;
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

function parseSubscriptionObject(obj: SuiObjectResponse): ProtocolSubscriptionStatus | null {
  if (obj.error || !obj.data?.content || !('fields' in obj.data.content) || !obj.data.objectId) return null;
  const fields = obj.data.content.fields as {
    plan_id?: string;
    active?: boolean;
    next_due?: string | number | bigint;
    balance?: string | number | bigint | { fields?: { value?: string | number | bigint } };
  };

  if (!fields.plan_id) return null;
  return {
    subscriptionId: obj.data.objectId,
    planId: fields.plan_id,
    active: Boolean(fields.active),
    nextDueMs: BigInt(fields.next_due ?? 0),
    escrowMist: parseBalanceMist(fields.balance),
  };
}

export async function getSubscriptionStatus(params: {
  client: SuiJsonRpcClient;
  packageId: string;
  subscriber: string;
  planId: string;
}): Promise<ProtocolSubscriptionStatus | null> {
  const { client, packageId, subscriber, planId } = params;
  const subIds: string[] = [];
  let hasNextPage = true;
  let cursor: Awaited<ReturnType<SuiJsonRpcClient['queryEvents']>>['nextCursor'] = null;

  while (hasNextPage) {
    const created = await client.queryEvents({
      query: { MoveEventType: `${packageId}::subscription::SubscriptionCreated` },
      cursor,
      limit: 200,
      order: 'descending',
    });

    const pageSubIds = created.data
      .map((evt) => evt.parsedJson as SubscriptionEvent | null)
      .filter((evt): evt is SubscriptionEvent => Boolean(evt))
      .filter(
        (evt) =>
          evt.subscriber?.toLowerCase() === subscriber.toLowerCase() &&
          evt.plan_id?.toLowerCase() === planId.toLowerCase() &&
          Boolean(evt.subscription_id),
      )
      .map((evt) => evt.subscription_id as string);
    subIds.push(...pageSubIds);

    hasNextPage = created.hasNextPage;
    cursor = created.nextCursor ?? null;
  }

  if (subIds.length === 0) return null;

  const objects = await client.multiGetObjects({
    ids: subIds,
    options: { showContent: true },
  });

  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const parsed = parseSubscriptionObject(objects[i]);
    if (parsed) return parsed;
  }
  return null;
}

export function hasActiveAccess(status: ProtocolSubscriptionStatus | null): boolean {
  if (!status || !status.active) return false;
  return true;
}

export function hasStrictAccess(status: ProtocolSubscriptionStatus | null, nowMs: number = Date.now()): boolean {
  if (!status || !status.active) return false;
  return status.nextDueMs > BigInt(nowMs);
}
