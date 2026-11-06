export type Doc = {
  slug: string;
  title: string;
  description: string;
  category: string;
  signature: string;
  code: string;
  returns: string;
  parameters: { name: string; type: string; description: string }[];
  notes: string[];
};

export const clientCode = `import { createPublicClient, defineChain, http } from 'viem';
import { frameActions } from '@framepay/sdk';

const chain = defineChain({
  id: 1337,
  name: 'Local frame devnet',
  nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://localhost:14337/rpc'] } },
});

const client = createPublicClient({
  chain,
  transport: http('http://localhost:14337/rpc', { retryCount: 0 }),
}).extend(frameActions({ profile: 'ethrex-eip8141-tracer' }));`;

export const docs: Doc[] = [
  {
    slug: "create-client",
    title: "Create a client",
    category: "Configuration",
    description:
      "Give your existing viem client a native frame-transaction workflow. Keep your transport, chain configuration, and familiar public actions.",
    signature: "frameActions({ profile })",
    code: clientCode,
    returns: "Your viem client, extended with six typed FramePay actions.",
    parameters: [
      {
        name: "profile",
        type: "'ethrex-eip8141-tracer'",
        description:
          "The explicitly supported workshop profile. Configure your chain with ID 1337.",
      },
    ],
    notes: [
      "createFrameClient({ chain, transport, profile }) is also available as a convenience factory.",
      "The transport must point to the gateway sidecar. The gateway forwards chain reads and routes frame submissions.",
      "The current sidecar follows the workshop’s PR #6 rules, which differ from later ERC-8421 revisions.",
    ],
  },
  {
    slug: "prepare",
    title: "Prepare a transaction",
    category: "Transaction lifecycle",
    description:
      "Build an unsigned frame transaction with explicit actions, gas limits, and fee bounds. The client checks the chain and resolves the ordinary account nonce.",
    signature: "client.prepareFrameTransaction(parameters)",
    code: `import { frame, getProfile } from '@framepay/sdk';

const profile = getProfile('ethrex-eip8141-tracer');
const transaction = await client.prepareFrameTransaction({
  sender: signer.address,
  maxFeePerGas: 2_000_000_000n,
  frames: [
    frame(profile, 'VERIFY', {
      scope: 'EXECUTION_AND_PAYMENT', execution: 30_000n,
    }),
    frame(profile, 'SENDER', {
      target: recipient, value: 1_000_000_000n,
      execution: 50_000n, state: 200_000n,
    }),
  ],
});`,
    returns: "Promise<FrameTx> — an unsigned transaction envelope.",
    parameters: [
      {
        name: "sender",
        type: "Address",
        description: "The account authorizing the transaction.",
      },
      {
        name: "frames",
        type: "Frame[]",
        description:
          "Ordered frames with explicit execution and state gas limits.",
      },
      {
        name: "maxFeePerGas",
        type: "bigint",
        description: "Maximum gas price, in wei.",
      },
      {
        name: "nonceSeq",
        type: "bigint?",
        description:
          "Read from the chain for ordinary nonces when omitted. Required for nonzero nonce keys.",
      },
      {
        name: "nonceKeys",
        type: "bigint[]?",
        description:
          "Defaults to [0n]. Keyed nonce allocation is managed by the caller.",
      },
      {
        name: "recentRootReferences",
        type: "RecentRootReference[]?",
        description: "Optional references included in the signed envelope.",
      },
    ],
    notes: [
      "Preparation is not admission simulation. Gas values in this example come from the workshop preset.",
      "A nonce read is not a reservation. Serialize ordinary-nonce sends from the same account.",
    ],
  },
  {
    slug: "sign",
    title: "Sign locally",
    category: "Transaction lifecycle",
    description:
      "Delegate authorization to your signer while preserving the transaction you prepared. FramePay rejects changes to the signed envelope.",
    signature: "client.signFrameTransaction({ transaction, signer })",
    code: `import { privateKeyToFrameSigner } from '@framepay/sdk';
import { generatePrivateKey } from 'viem/accounts';

// A disposable local-devnet account. Fund its address before sending.
const signer = privateKeyToFrameSigner(generatePrivateKey());

// Prepare the transaction with sender: signer.address first.
const signed = await client.signFrameTransaction({ transaction, signer });`,
    returns: "Promise<FrameTx> — a signed copy of the transaction.",
    parameters: [
      {
        name: "transaction",
        type: "FrameTx",
        description: "The complete prepared transaction.",
      },
      {
        name: "signer",
        type: "FrameSigner",
        description:
          "An adapter implementing address and sign({ profile, transaction }).",
      },
    ],
    notes: [
      "The included local adapter uses SECP256K1. PQ authorization and browser-wallet adapters are future integrations.",
      "Private keys should remain inside your signer. The playground generates its key in this browser tab and does not persist it.",
    ],
  },
  {
    slug: "submit",
    title: "Submit to the sidecar",
    category: "Transaction lifecycle",
    description:
      "Send a signed frame transaction through the gateway’s standard alternative-mempool path. Get the expected transaction hash without silently retrying writes.",
    signature: "client.sendFrameTransaction({ transaction })",
    code: `const hash = await client.sendFrameTransaction({
  transaction: signed,
});

// A submission hash is not a receipt.
const receipt = await client.waitForFrameReceipt({
  hash, expectedFrameCount: 2,
});`,
    returns: "Promise<Hex> — the transaction hash acknowledged by the gateway.",
    parameters: [
      {
        name: "transaction",
        type: "FrameTx",
        description: "A signed frame transaction for the configured chain.",
      },
    ],
    notes: [
      "This action uses eth_sendFrameTransaction and the upstream toWire conversion.",
      "An RPC timeout can occur after acceptance. Inspect error.context.transactionHash before trying again.",
    ],
  },
  {
    slug: "receipts",
    title: "Read frame receipts",
    category: "Transaction lifecycle",
    description:
      "Distinguish inclusion from successful execution. Inspect individual frame results or wait until every returned frame has succeeded.",
    signature: "client.waitForFrameReceipt({ hash, ...options })",
    code: `// One read: null means no receipt was returned yet.
const current = await client.getFrameReceipt({ hash });

// Poll for successful execution; throws if a frame reverts.
const receipt = await client.waitForFrameReceipt({
  hash,
  expectedFrameCount: 2,
  timeoutMs: 120_000,
  pollingIntervalMs: 2_000,
});`,
    returns:
      "getFrameReceipt: Promise<FrameReceipt | null>. waitForFrameReceipt: Promise<FrameReceipt>.",
    parameters: [
      {
        name: "hash",
        type: "Hex",
        description: "The transaction hash to inspect.",
      },
      {
        name: "expectedFrameCount",
        type: "number?",
        description: "An optional check against the expected number of frames.",
      },
      {
        name: "timeoutMs",
        type: "number?",
        description: "Maximum wait duration. Defaults to 120,000 milliseconds.",
      },
      {
        name: "signal",
        type: "AbortSignal?",
        description: "Cancel waiting. This does not cancel the transaction.",
      },
    ],
    notes: [
      "A reverted frame raises FRAME_REVERTED and identifies failed frame indices.",
      "A receipt is evidence of observed inclusion, not finality. A timeout is not proof of rejection.",
    ],
  },
  {
    slug: "admission",
    title: "Inspect admission",
    category: "Observability",
    description:
      "Read the sidecar’s retained admission decision and rule checks. Find the stage that rejected a transaction without guessing from a generic RPC error.",
    signature: "client.getFrameAdmission({ hash })",
    code: `const admission = await client.getFrameAdmission({ hash });

if (admission.available) {
  const failed = admission.checks.filter(
    (check) => check.verdict === 'fail',
  );
  console.log(admission.outcome, failed);
}`,
    returns:
      "Promise<FrameAdmission> — availability, outcome, and per-rule verdicts.",
    parameters: [
      {
        name: "hash",
        type: "Hex",
        description: "The hash known to the gateway sidecar.",
      },
    ],
    notes: [
      "Admission history is held in memory and may disappear after a restart or eviction.",
      "available: false represents an explicitly absent retained record. An unknown transaction can instead produce an RPC error.",
      "This is post-submission inspection. A pre-submission admission simulator is not implemented yet.",
    ],
  },
];

export const searchEntries = [
  {
    title: "Overview",
    description: "Start building with native frame transactions",
    href: "/",
  },
  {
    title: "Quickstart",
    description: "Set up the workspace and run a first transaction",
    href: "/docs/quickstart",
  },
  ...docs.map((doc) => ({
    title: doc.title,
    description: doc.description,
    href: `/docs/${doc.slug}`,
  })),
  {
    title: "Playground",
    description: "Create an account and test the SDK on your local devnet",
    href: "/playground",
  },
];
