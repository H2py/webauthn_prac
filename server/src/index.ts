// cspell:word viem WebAuthn
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import {
	type Hex,
	encodeFunctionData,
	createPublicClient,
	createWalletClient,
	http,
	encodeAbiParameters,
} from "viem";
import {
	accountWebAuthnAbi,
	FACTORY_ADDRESS,
	accountFactoryAbi,
	ENTRYPOINT_ADDRESS,
	entryPointAbi,
} from "../../shared";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

type Bindings = {
	RPC_URL: string;
	PRIVATE_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use(cors());
app.use(logger());

app.get("/", (c) => {
	return c.text("Hello Hono!");
});

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

		// Extract qx and qy from the public key (ensure proper padding)
		const qx = publicKey.x as Hex;
		const qy = publicKey.y as Hex;

		// Encode the initialization call
		const initCallData = encodeFunctionData({
			abi: accountWebAuthnAbi,
			functionName: "initializeWebAuthn",
			args: [qx, qy],
		});

		// Predict account address
		const predictedAddress = (await publicClient.readContract({
			address: FACTORY_ADDRESS,
			abi: accountFactoryAbi,
			functionName: "predictAddress",
			args: [initCallData],
		})) as `0x${string}`;

		// Deploy the account
		const hash = await walletClient.writeContract({
			address: FACTORY_ADDRESS,
			abi: accountFactoryAbi,
			functionName: "cloneAndInitialize",
			args: [initCallData],
		});

		// Wait for transaction
		await publicClient.waitForTransactionReceipt({ hash });

		// Fund the account with 0.005 ETH from deployer wallet
		const fundHash = await walletClient.sendTransaction({
			to: predictedAddress,
			value: 5000000000000000n, // 0.005 ETH in wei
		});

		// Wait for funding transaction
		await publicClient.waitForTransactionReceipt({ hash: fundHash });

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

app.post("/account/mint", async (c) => {
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
			metadata,
			rHex,
			sHex,
			userOp,
			nonce: serializedNonce,
		} = await c.req.json();

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
			hash: hash,
		});

		if (receipt.status === "reverted") {
			return c.json({ error: ` Failed to Mint: Reverted ` }, 500);
		}

		return c.json({
			status: "success",
			hash,
		});
	} catch (error) {
		return c.json({ error: ` Failed to Mint: ${error} ` }, 500);
	}
});

export default app;
