// cspell:word viem WebAuthn
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import {
	type Address,
	type Hex,
	createPublicClient,
	createWalletClient,
	decodeAbiParameters,
	decodeFunctionData,
	encodeAbiParameters,
	encodeFunctionData,
	http,
} from "viem";
import type { PackedUserOperation } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
	accountFactoryAbi,
	accountWebAuthnAbi,
	ENTRYPOINT_ADDRESS,
	entryPointAbi,
	FACTORY_ADDRESS,
	USDC_ADDRESS,
	USDC_DECIMALS,
	usdcAbi,
} from "../../shared";

type Bindings = {
	RPC_URL: string;
	PRIVATE_KEY: string;
};

type DepositRecord = {
	sender: Address;
	amount: bigint;
	txHash: Hex;
	logIndex: number;
	blockNumber: bigint;
	blockTimestamp: number;
	ready: boolean;
	refunded: boolean;
	refundTxHash?: Hex;
};

type AccountSession = {
	credentialId: string;
	accountAddress: Address;
	deposits: DepositRecord[];
	stopWatching?: () => void;
	isWatching: boolean;
	lastSyncedBlock?: bigint;
};

type RefundDepositInput = {
	txHash: Hex;
	sender: Address;
	amount: string;
	logIndex: number;
};

type SerializedPackedUserOperation = Omit<
	PackedUserOperation,
	"nonce" | "preVerificationGas"
> & {
	nonce: string;
	preVerificationGas: string | number | bigint;
};

type RefundRequestBody = {
	accountAddress: Address;
	credentialId: string;
	metadata: {
		challengeIndex: string | number;
		typeIndex: string | number;
		authenticatorData: Hex;
		clientDataJSON: string;
	};
	rHex: Hex;
	sHex: Hex;
	userOp: SerializedPackedUserOperation;
	nonce: string;
	deposit: RefundDepositInput;
};

const MIN_USDC_DEPOSIT = 10n ** BigInt(USDC_DECIMALS);
const MAX_DEPOSITS = 20;
const DEFAULT_LOOKBACK_BLOCKS = 2_000n;
const MAX_GET_LOGS_RANGE = 10n;
const accountStore = new Map<string, AccountSession>();

const app = new Hono<{ Bindings: Bindings }>();

app.use(cors());
app.use(logger());

const normalizeAddress = (value: string) => value.toLowerCase() as Address;

const serializeDeposit = (record: DepositRecord) => ({
	sender: record.sender,
	amount: record.amount.toString(),
	txHash: record.txHash,
	logIndex: record.logIndex,
	blockNumber: record.blockNumber.toString(),
	blockTimestamp: record.blockTimestamp,
	ready: record.ready,
	refunded: record.refunded,
	refundTxHash: record.refundTxHash ?? null,
});

function upsertAccountSession(address: Address, credentialId: string) {
	const key = normalizeAddress(address);
	const existing = accountStore.get(key);
	if (existing) {
		existing.credentialId = credentialId;
		existing.accountAddress = address;
		return existing;
	}

	const session: AccountSession = {
		credentialId,
		accountAddress: address,
		deposits: [],
		isWatching: false,
	};
	accountStore.set(key, session);
	return session;
}

const getAccountSession = (address: Address) =>
	accountStore.get(normalizeAddress(address));

const recordDeposit = (session: AccountSession, record: DepositRecord) => {
	const duplicate = session.deposits.some(
		(existing) =>
			existing.txHash === record.txHash &&
			existing.logIndex === record.logIndex,
	);

	if (!duplicate) {
		session.deposits.unshift(record);
		if (session.deposits.length > MAX_DEPOSITS) {
			session.deposits.pop();
		}
	}
};

const getBlockTimestamp = async (
	publicClient: ReturnType<typeof createPublicClient>,
	blockNumber: bigint,
	cache: Map<string, number>,
) => {
	const cacheKey = blockNumber.toString();
	const cached = cache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}
	const block = await publicClient.getBlock({ blockNumber });
	const timestamp = Number(block.timestamp);
	cache.set(cacheKey, timestamp);
	return timestamp;
};

const hydrateDeposits = async (
	publicClient: ReturnType<typeof createPublicClient>,
	session: AccountSession,
) => {
	const latestBlock = await publicClient.getBlockNumber();
	let fromBlock: bigint;

	if (session.lastSyncedBlock !== undefined) {
		fromBlock = session.lastSyncedBlock + 1n;
	} else if (latestBlock > DEFAULT_LOOKBACK_BLOCKS) {
		fromBlock = latestBlock - DEFAULT_LOOKBACK_BLOCKS;
	} else {
		fromBlock = 0n;
	}

	if (fromBlock > latestBlock) {
		session.lastSyncedBlock = latestBlock;
		return;
	}

	const logs = await fetchTransferLogs(
		publicClient,
		session.accountAddress,
		fromBlock,
		latestBlock,
	);

	if (!logs.length) {
		session.lastSyncedBlock = latestBlock;
		return;
	}

	const timestampCache = new Map<string, number>();

	for (const log of logs) {
		if (!log.blockNumber || log.logIndex === undefined || !log.transactionHash) {
			continue;
		}

		const sender = log.args?.from as Address | undefined;
		const value = log.args?.value as bigint | undefined;
		if (!sender || value === undefined) {
			continue;
		}

		const blockTimestamp = await getBlockTimestamp(
			publicClient,
			log.blockNumber,
			timestampCache,
		);

		const record: DepositRecord = {
			sender,
			amount: value,
			txHash: log.transactionHash,
			logIndex: Number(log.logIndex),
			blockNumber: log.blockNumber,
			blockTimestamp,
			ready: value >= MIN_USDC_DEPOSIT,
			refunded: false,
		};

		recordDeposit(session, record);
		session.lastSyncedBlock = log.blockNumber;
	}

	if (session.lastSyncedBlock === undefined || session.lastSyncedBlock < latestBlock) {
		session.lastSyncedBlock = latestBlock;
	}
};

async function ensureDepositWatcher(env: Bindings, address: Address) {
	const session = getAccountSession(address);
	if (!session || session.isWatching) {
		if (session) {
			const publicClient = createPublicClient({
				chain: sepolia,
				transport: http(env.RPC_URL),
			});
			await hydrateDeposits(publicClient, session);
		}
		return;
	}

	const publicClient = createPublicClient({
		chain: sepolia,
		transport: http(env.RPC_URL),
	});

	await hydrateDeposits(publicClient, session);

	const unwatch = publicClient.watchContractEvent({
		address: USDC_ADDRESS,
		abi: usdcAbi,
		eventName: "Transfer",
		args: { to: address },
		poll: true,
		pollingInterval: 5_000,
		async onLogs(logs) {
			const timestampCache = new Map<string, number>();

			for (const log of logs) {
				const sender = log.args?.from as Address | undefined;
				const value = log.args?.value as bigint | undefined;
				if (
					!sender ||
					value === undefined ||
					!log.transactionHash ||
					log.logIndex === undefined ||
					!log.blockNumber
				) {
					continue;
				}

				const blockTimestamp = await getBlockTimestamp(
					publicClient,
					log.blockNumber,
					timestampCache,
				);

				const record: DepositRecord = {
					sender,
					amount: value,
					txHash: log.transactionHash,
					logIndex: Number(log.logIndex),
					blockNumber: log.blockNumber,
					blockTimestamp,
					ready: value >= MIN_USDC_DEPOSIT,
					refunded: false,
				};

				recordDeposit(session, record);
				session.lastSyncedBlock = log.blockNumber;
			}
		},
		onError(error) {
			console.error(`Deposit watcher error for ${address}:`, error);
			session.isWatching = false;
			session.stopWatching = undefined;
		},
	});

	session.stopWatching = () => {
		unwatch();
		session.isWatching = false;
		session.stopWatching = undefined;
	};
	session.isWatching = true;
}

app.get("/", (c) => c.text("Hello Hono!"));

app.post("/account/create", async (c) => {
	try {
		const publicClient = createPublicClient({
			chain: sepolia,
			transport: http(c.env.RPC_URL),
		});

		const account = privateKeyToAccount(c.env.PRIVATE_KEY as `0x${string}`);

		const walletClient = createWalletClient({
			chain: sepolia,
			transport: http(c.env.RPC_URL),
			account,
		});

		const {
			credentialId, // Can be used to store accounts for future logins
			publicKey,
		} = await c.req.json();

		const qx = publicKey.x as Hex;
		const qy = publicKey.y as Hex;

		const initCallData = encodeFunctionData({
			abi: accountWebAuthnAbi,
			functionName: "initializeWebAuthn",
			args: [qx, qy],
		});

		const predictedAddress = (await publicClient.readContract({
			address: FACTORY_ADDRESS,
			abi: accountFactoryAbi,
			functionName: "predictAddress",
			args: [initCallData],
		})) as Address;

		const hash = await walletClient.writeContract({
			address: FACTORY_ADDRESS,
			abi: accountFactoryAbi,
			functionName: "cloneAndInitialize",
			args: [initCallData],
		});

		await publicClient.waitForTransactionReceipt({ hash });

		const fundHash = await walletClient.sendTransaction({
			to: predictedAddress,
			value: 5_000_000_000_000_000n,
		});

		await publicClient.waitForTransactionReceipt({ hash: fundHash });

		upsertAccountSession(predictedAddress, credentialId);
		await ensureDepositWatcher(c.env, predictedAddress);

		return c.json({
			success: true,
			accountAddress: predictedAddress,
			transactionHash: hash,
			fundingTransactionHash: fundHash,
			publicKey: { qx, qy },
		});
	} catch (error) {
		return c.json({ error: ` Failed to create account: ${error} ` }, 500);
	}
});

app.get("/account/:address/deposits", async (c) => {
	const addressParam = c.req.param("address");
	if (!addressParam || !addressParam.startsWith("0x")) {
		return c.json({ error: "Invalid account address" }, 400);
	}

	const accountAddress = addressParam as Address;
	const session = getAccountSession(accountAddress);
	if (session) {
		await ensureDepositWatcher(c.env, session.accountAddress);
		return c.json({
			deposits: session.deposits.map(serializeDeposit),
			minDeposit: MIN_USDC_DEPOSIT.toString(),
			decimals: USDC_DECIMALS,
			watching: session.isWatching,
		});
	}

	return c.json({
		deposits: [],
		minDeposit: MIN_USDC_DEPOSIT.toString(),
		decimals: USDC_DECIMALS,
		watching: false,
	});
});

app.post("/account/refund", async (c) => {
	const publicClient = createPublicClient({
		chain: sepolia,
		transport: http(c.env.RPC_URL),
	});

	const account = privateKeyToAccount(c.env.PRIVATE_KEY as `0x${string}`);

	const walletClient = createWalletClient({
		chain: sepolia,
		transport: http(c.env.RPC_URL),
		account,
	});

	try {
		const {
			accountAddress,
			credentialId,
			metadata,
			rHex,
			sHex,
			userOp,
			nonce: serializedNonce,
			deposit,
		} = (await c.req.json()) as RefundRequestBody;

		const session = getAccountSession(accountAddress);
		if (!session) {
			return c.json({ error: "Account session not found" }, 404);
		}

		if (session.credentialId !== credentialId) {
			return c.json({ error: "Credential mismatch" }, 403);
		}

		const depositAmount = BigInt(deposit.amount);

		const storedDeposit = session.deposits.find(
			(entry) =>
				entry.txHash === deposit.txHash &&
				entry.logIndex === deposit.logIndex &&
				entry.sender.toLowerCase() === deposit.sender.toLowerCase() &&
				entry.amount === depositAmount,
		);

		if (!storedDeposit) {
			return c.json({ error: "Deposit record not found" }, 404);
		}

		if (storedDeposit.refunded) {
			return c.json({ error: "Deposit already refunded" }, 400);
		}

		if (!storedDeposit.ready) {
			return c.json({ error: "Deposit below minimum amount" }, 400);
		}

		const challengeIndex = BigInt(metadata.challengeIndex);
		const typeIndex = BigInt(metadata.typeIndex);
		const authenticatorDataHex = metadata.authenticatorData;
		const clientDataJSON = metadata.clientDataJSON;
		const nonce = BigInt(serializedNonce);

		const encodedSignature = encodeAbiParameters(
			[
				{ name: "r", type: "bytes32" },
				{ name: "s", type: "bytes32" },
				{ name: "challengeIndex", type: "uint256" },
				{ name: "typeIndex", type: "uint256" },
				{ name: "authenticatorData", type: "bytes" },
				{ name: "clientDataJSON", type: "string" },
			],
			[
				rHex,
				sHex,
				challengeIndex,
				typeIndex,
				authenticatorDataHex,
				clientDataJSON,
			],
		);

		if (userOp.sender.toLowerCase() !== accountAddress.toLowerCase()) {
			return c.json({ error: "UserOperation sender mismatch" }, 400);
		}

		const decodedAccountCall = decodeFunctionData({
			abi: accountWebAuthnAbi,
			data: userOp.callData as Hex,
		});

		if (decodedAccountCall.functionName !== "execute") {
			return c.json({ error: "Invalid callData function" }, 400);
		}

		const [, executionData] = decodedAccountCall.args as [Hex, Hex];
		const decodedExecution = decodeAbiParameters(
			[
				{
					type: "tuple[]",
					components: [
						{ type: "address" },
						{ type: "uint256" },
						{ type: "bytes" },
					],
				},
			],
			executionData,
		);

		const calls = decodedExecution[0] as [Address, bigint, Hex][];
		if (!calls.length) {
			return c.json({ error: "Missing execution calls" }, 400);
		}

		const [target, value, tokenCallData] = calls[0];
		if (target.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
			return c.json({ error: "Execution target must be USDC" }, 400);
		}
		if (value !== 0n) {
			return c.json({ error: "USDC transfer cannot include ETH value" }, 400);
		}

		const decodedTokenCall = decodeFunctionData({
			abi: usdcAbi,
			data: tokenCallData,
		});

		if (decodedTokenCall.functionName !== "transfer") {
			return c.json({ error: "USDC call must be transfer" }, 400);
		}

		const [recipient, transferAmount] = decodedTokenCall.args as [
			Address,
			bigint,
		];

		if (recipient.toLowerCase() !== storedDeposit.sender.toLowerCase()) {
			return c.json({ error: "Transfer recipient mismatch" }, 400);
		}

		if (transferAmount !== storedDeposit.amount) {
			return c.json({ error: "Transfer amount mismatch" }, 400);
		}

		const fullUserOp = {
			...userOp,
			nonce,
			preVerificationGas: BigInt(userOp.preVerificationGas),
			signature: encodedSignature,
		};

		const { request } = await publicClient.simulateContract({
			address: ENTRYPOINT_ADDRESS,
			abi: entryPointAbi,
			functionName: "handleOps",
			args: [[fullUserOp], walletClient.account.address],
			account: walletClient.account,
		});

		const hash = await walletClient.writeContract(request);

		const receipt = await publicClient.waitForTransactionReceipt({
			hash,
		});

		if (receipt.status === "reverted") {
			return c.json({ error: ` Failed to Refund: Reverted ` }, 500);
		}

		storedDeposit.refunded = true;
		storedDeposit.refundTxHash = hash;

		return c.json({
			status: "success",
			hash,
		});
	} catch (error) {
		return c.json({ error: ` Failed to refund: ${error} ` }, 500);
	}
});

export default app;
const fetchTransferLogs = async (
	publicClient: ReturnType<typeof createPublicClient>,
	account: Address,
	start: bigint,
	end: bigint,
) => {
	const logs = [];
	let cursor = start;

	while (cursor <= end) {
		const chunkEnd = cursor + MAX_GET_LOGS_RANGE - 1n;
		const toBlock = chunkEnd > end ? end : chunkEnd;

		const chunk = await publicClient.getLogs({
			address: USDC_ADDRESS,
			abi: usdcAbi,
			eventName: "Transfer",
			args: { to: account },
			fromBlock: cursor,
			toBlock,
		});

		logs.push(...chunk);
		cursor = toBlock + 1n;
	}

	return logs;
};
