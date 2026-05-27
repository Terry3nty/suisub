import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex, toHex } from '@mysten/sui/utils';

export type ContentGateConfig = {
  network: 'testnet' | 'mainnet';
  packageId: string;
  keyServers: string[];
  threshold: number;
  uploadRelayUrl: string;
};

export type PublishedContentEvent = {
  content_id?: string;
  creator?: string;
  plan_id?: string;
  walrus_blob_id?: string;
  walrus_object_id?: string;
  seal_id?: number[] | string;
  content_type?: string;
};

export type GatedContentRecord = {
  contentId: string;
  planId: string;
  walrusBlobId: string;
  walrusObjectId: string;
  sealIdHex: string;
  contentType: string;
};

export function getContentGateConfig(packageId: string): ContentGateConfig {
  const network = (process.env.NEXT_PUBLIC_SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet') as 'testnet' | 'mainnet';
  const keyServers = (process.env.NEXT_PUBLIC_SEAL_KEY_SERVERS ?? '')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
  return {
    network,
    packageId,
    keyServers,
    threshold: Number(process.env.NEXT_PUBLIC_SEAL_THRESHOLD ?? 1),
    uploadRelayUrl:
      process.env.NEXT_PUBLIC_WALRUS_UPLOAD_RELAY ??
      (network === 'mainnet' ? 'https://upload-relay.mainnet.walrus.space' : 'https://upload-relay.testnet.walrus.space'),
  };
}

export function createGrpcClient(config: ContentGateConfig) {
  const fullnodeUrl =
    config.network === 'mainnet' ? 'https://fullnode.mainnet.sui.io:443' : 'https://fullnode.testnet.sui.io:443';
  return new SuiGrpcClient({
    network: config.network,
    baseUrl: fullnodeUrl,
  });
}

export async function createWalrusClient(config: ContentGateConfig) {
  const { walrus } = await import('@mysten/walrus');
  return createGrpcClient(config).$extend(
    walrus({
      uploadRelay: {
        host: config.uploadRelayUrl,
        sendTip: { max: 1_000 },
      },
    }),
  );
}

export async function createSealClient(config: ContentGateConfig) {
  if (config.keyServers.length === 0) {
    throw new Error('Set NEXT_PUBLIC_SEAL_KEY_SERVERS to at least one Seal key server object id.');
  }
  const { SealClient } = await import('@mysten/seal');
  return new SealClient({
    suiClient: createGrpcClient(config),
    serverConfigs: config.keyServers.map((objectId) => ({ objectId, weight: 1 })),
    verifyKeyServers: false,
  });
}

export async function createSealIdentity(planId: string, fileName: string): Promise<string> {
  const source = new TextEncoder().encode(`${planId}:${fileName}:${crypto.randomUUID()}`);
  const digest = await crypto.subtle.digest('SHA-256', source);
  return toHex(new Uint8Array(digest));
}

export async function encryptWithSeal(params: {
  config: ContentGateConfig;
  sealIdHex: string;
  bytes: Uint8Array;
}) {
  const client = await createSealClient(params.config);
  return client.encrypt({
    threshold: params.config.threshold,
    packageId: params.config.packageId,
    id: params.sealIdHex,
    data: params.bytes,
  });
}

export function buildSealApprovalTransaction(params: {
  packageId: string;
  coinType: string;
  sealIdHex: string;
  contentId: string;
  subscriptionId: string;
}) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::subscription::seal_approve_subscription`,
    typeArguments: [params.coinType],
    arguments: [
      tx.pure.vector('u8', Array.from(fromHex(params.sealIdHex))),
      tx.object(params.contentId),
      tx.object(params.subscriptionId),
      tx.object('0x6'),
    ],
  });
  return tx;
}

export async function decryptWithSeal(params: {
  config: ContentGateConfig;
  accountAddress: string;
  signPersonalMessage: (input: { message: Uint8Array }) => Promise<{ signature: string }>;
  encryptedBytes: Uint8Array;
  approvalTx: Transaction;
}) {
  const suiClient = createGrpcClient(params.config);
  const { SessionKey } = await import('@mysten/seal');
  const sessionKey = await SessionKey.create({
    address: params.accountAddress,
    packageId: params.config.packageId,
    ttlMin: 10,
    suiClient,
  });
  const { signature } = await params.signPersonalMessage({ message: sessionKey.getPersonalMessage() });
  await sessionKey.setPersonalMessageSignature(signature);
  const txBytes = await params.approvalTx.build({ client: suiClient, onlyTransactionKind: true });
  return (await createSealClient(params.config)).decrypt({
    data: params.encryptedBytes,
    sessionKey,
    txBytes,
  });
}

export async function readWalrusBlob(config: ContentGateConfig, blobId: string) {
  const testnetAggregators = [
    `https://aggregator.testnet.walrus.space/v1/blobs/${blobId}`,
    `https://wal-aggregator-testnet.staketab.org/v1/blobs/${blobId}`,
    `https://walrus-testnet-aggregator.nodes.guru/v1/blobs/${blobId}`,
  ];
  
  const mainnetAggregators = [
    `https://aggregator.mainnet.walrus.space/v1/blobs/${blobId}`,
  ];

  const urls = config.network === 'mainnet' ? mainnetAggregators : testnetAggregators;

  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      console.log(`Attempting to fetch Walrus blob from aggregator: ${url}`);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      console.log(`Successfully fetched Walrus blob from aggregator: ${url}`);
      return new Uint8Array(arrayBuffer);
    } catch (err) {
      console.warn(`Failed to fetch blob from aggregator ${url}:`, err);
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError || new Error(`Failed to read Walrus blob ${blobId} from all aggregators`);
}

export function parseContentEvent(event: PublishedContentEvent): GatedContentRecord | null {
  if (!event.content_id || !event.plan_id || !event.walrus_blob_id) return null;
  const sealIdHex = Array.isArray(event.seal_id)
    ? toHex(new Uint8Array(event.seal_id))
    : typeof event.seal_id === 'string'
      ? event.seal_id
      : '';
  return {
    contentId: event.content_id,
    planId: event.plan_id,
    walrusBlobId: event.walrus_blob_id,
    walrusObjectId: event.walrus_object_id ?? '',
    sealIdHex,
    contentType: event.content_type ?? 'application/octet-stream',
  };
}
