// cspell:word viem WebAuthn
import { useState } from "react";
import "./App.css";
import { WebAuthnP256 } from "ox";
import {
	encodeAbiParameters,
	createPublicClient,
	http,
	encodeFunctionData,
	encodePacked,
	type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import {
	ENTRYPOINT_ADDRESS,
	NFT_ADDRESS,
	entryPointAbi,
	myNftAbi,
	accountWebAuthnAbi,
} from "../../shared";
import type { PackedUserOperation } from "viem/account-abstraction";
import { serializeBigInts } from "./utils";

const SERVER_URL = "http://localhost:8787";

const publicClient = createPublicClient({
	transport: http(),
	chain: sepolia,
});

async function createCompatCredential() {
	return WebAuthnP256.createCredential({
		name: "wallet-user",
		createFn: (options) => {
			if (!options) {
				return navigator.credentials.create(
					options as CredentialCreationOptions | undefined,
				);
			}

			const normalizedOptions = options as CredentialCreationOptions;
			const publicKey = normalizedOptions.publicKey;
			if (!publicKey) {
				return navigator.credentials.create(normalizedOptions);
			}

			const pubKeyCredParams = publicKey.pubKeyCredParams ?? [];
			const hasRs256 = pubKeyCredParams.some(
				(param) => param.alg === -257,
			);

			const patchedOptions: CredentialCreationOptions = {
				...normalizedOptions,
				publicKey: {
					...publicKey,
					pubKeyCredParams: hasRs256
						? pubKeyCredParams
						: [
								...pubKeyCredParams,
								{ type: "public-key", alg: -257 },
						  ],
				},
			};

			return navigator.credentials.create(patchedOptions);
		},
	});
}

function App() {
	const [isLoading, setIsLoading] = useState(false);
	const [statusMessage, setStatusMessage] = useState("");
	const [accountAddress, setAccountAddress] = useState<string | null>(null);
	const [mintTxHash, setMintTxHash] = useState<string | null>(null);

	async function createAccount() {
		try {
			setIsLoading(true);
			setStatusMessage("Creating WebAuthn credential...");

			// Create WebAuthn credential
			const credential = await createCompatCredential();

			// Convert BigInt values to hex strings for serialization (with proper padding)
			const publicKey = {
				prefix: credential.publicKey.prefix,
				x: `0x${credential.publicKey.x.toString(16).padStart(64, "0")}`,
				y: `0x${credential.publicKey.y.toString(16).padStart(64, "0")}`,
			};

			setStatusMessage("Deploying WebAuthn account...");

			// Send credential to server for account deployment
			const response = await fetch(`${SERVER_URL}/account/create`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					credentialId: credential.id,
					publicKey,
				}),
			});

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || "Failed to create account");
			}

			const result = await response.json();

			const deployedAddress = result.accountAddress;
			setAccountAddress(deployedAddress);

			setStatusMessage("Account deployed! Preparing NFT mint transaction...");

			const nonce = await publicClient.readContract({
				address: ENTRYPOINT_ADDRESS,
				abi: entryPointAbi,
				functionName: "getNonce",
				args: [deployedAddress, 0n],
			});

			const incrementCallData = encodeFunctionData({
				abi: myNftAbi,
				functionName: "safeMint",
				args: [deployedAddress],
			});

			const mode = encodePacked(
				["bytes1", "bytes1", "bytes4", "bytes4", "bytes22"],
				[
					"0x01",
					"0x00",
					"0x00000000",
					"0x00000000",
					"0x00000000000000000000000000000000000000000000",
				],
			);

			// Encode execution data as array of (address, uint256, bytes)[]
			const executionData = encodeAbiParameters(
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
				[[[NFT_ADDRESS, 0n, incrementCallData]]],
			);

			// Encode the execute call on the account using ERC7821 format
			const callData = encodeFunctionData({
				abi: accountWebAuthnAbi,
				functionName: "execute",
				args: [mode, executionData],
			});

			const feeData = await publicClient.estimateFeesPerGas();

			const userOp: PackedUserOperation = {
				sender: deployedAddress,
				nonce, // Already a BigInt from readContract
				initCode: "0x",
				callData,
				accountGasLimits: encodePacked(
					["uint128", "uint128"],
					[
						1_000_000n, // verificationGasLimit (high for P256 verification)
						300_000n, // callGasLimit
					],
				),
				preVerificationGas: 100_000n,
				gasFees: encodePacked(
					["uint128", "uint128"],
					[
						feeData.maxPriorityFeePerGas, // maxPriorityFeePerGas (1 gwei)
						feeData.maxFeePerGas, // maxFeePerGas (2 gwei)
					],
				),
				paymasterAndData: "0x",
				signature: "0x" as Hex, // Placeholder, will be replaced
			};

			const userOpHash = await publicClient.readContract({
				address: ENTRYPOINT_ADDRESS,
				abi: entryPointAbi,
				functionName: "getUserOpHash",
				args: [userOp],
			});

			setStatusMessage("Signing transaction with WebAuthn...");

			const { signature, metadata } = await WebAuthnP256.sign({
				challenge: userOpHash,
				credentialId: credential.id,
			});

			// Encode the signature in the format expected by OpenZeppelin SignerWebAuthn
			// The contract expects an ABI-encoded WebAuthnAuth struct:
			// struct WebAuthnAuth {
			//   bytes32 r;
			//   bytes32 s;
			//   uint256 challengeIndex;
			//   uint256 typeIndex;
			//   bytes authenticatorData;
			//   string clientDataJSON;
			// }

			// Prepare signature components
			const rHex = `0x${signature.r.toString(16).padStart(64, "0")}` as Hex;
			const sHex = `0x${signature.s.toString(16).padStart(64, "0")}` as Hex;

			setStatusMessage("Submitting UserOperation to mint NFT...");

			const mintRequest = await fetch(`${SERVER_URL}/account/mint`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					rHex,
					sHex,
					metadata,
					userOp: serializeBigInts(userOp),
					nonce: nonce.toString(),
				}),
			});

			const mintResponse = await mintRequest.json();
			console.log(mintResponse);

			if (mintResponse.hash) {
				setMintTxHash(mintResponse.hash);
			}

			setStatusMessage("Success! NFT minted to your account.");
			setIsLoading(false);
		} catch (err) {
			console.error("Error creating account:", err);
			setStatusMessage(
				`Error: ${err instanceof Error ? err.message : "Unknown error occurred"}`,
			);
			setIsLoading(false);
		}
	}

	return (
		<>
			<h1>WebAuthn Account Abstraction</h1>
			<div className="card">
				<button type="button" onClick={createAccount} disabled={isLoading}>
					{isLoading ? "Processing..." : "Create Account"}
				</button>
				{statusMessage && (
					<div
						className={`status-message ${statusMessage.startsWith("Error") ? "error" : statusMessage.startsWith("Success") ? "success" : ""}`}
					>
						{isLoading && <div className="spinner" />}
						<p>{statusMessage}</p>
					</div>
				)}
				{accountAddress && (
					<div className="account-details">
						<h3>Account Details</h3>
						<div className="detail-row">
							<span className="label">Address:</span>
							<code className="value">{accountAddress}</code>
						</div>
						{mintTxHash && (
							<div className="detail-row">
								<span className="label">NFT Mint Transaction:</span>
								<a
									href={`https://sepolia.etherscan.io/tx/${mintTxHash}`}
									target="_blank"
									rel="noopener noreferrer"
									className="tx-link"
								>
									View on Etherscan ↗
								</a>
							</div>
						)}
					</div>
				)}
			</div>
		</>
	);
}
export default App;
