// cspell:word viem WebAuthn
import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import { WebAuthnP256 } from "ox";
import { QRCodeSVG } from "qrcode.react";
import {
	type Hex,
	createPublicClient,
	encodeAbiParameters,
	encodeFunctionData,
	encodePacked,
	formatUnits,
	http,
} from "viem";
import type { PackedUserOperation } from "viem/account-abstraction";
import { sepolia } from "viem/chains";
import {
	ENTRYPOINT_ADDRESS,
	USDC_ADDRESS,
	USDC_DECIMALS,
	accountWebAuthnAbi,
	entryPointAbi,
	usdcAbi,
} from "../../shared";
import { serializeBigInts } from "./utils";

const SERVER_URL = "http://localhost:8787";
const publicClient = createPublicClient({
	transport: http(),
	chain: sepolia,
});

const EXECUTE_MODE = encodePacked(
	["bytes1", "bytes1", "bytes4", "bytes4", "bytes22"],
	[
		"0x01",
		"0x00",
		"0x00000000",
		"0x00000000",
		"0x00000000000000000000000000000000000000000000",
	],
);

type CreatedCredential = Awaited<ReturnType<typeof createCompatCredential>>;
type DepositRecord = {
	sender: `0x${string}`;
	amount: string;
	txHash: `0x${string}`;
	logIndex: number;
	blockNumber: string;
	blockTimestamp: number;
	ready: boolean;
	refunded: boolean;
	refundTxHash?: `0x${string}` | null;
};

function formatAddress(address: string) {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

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
	const [isDeploying, setIsDeploying] = useState(false);
	const [isRefunding, setIsRefunding] = useState(false);
	const [statusMessage, setStatusMessage] = useState("");
	const [pollError, setPollError] = useState<string | null>(null);
	const [accountAddress, setAccountAddress] = useState<string | null>(null);
	const [credential, setCredential] = useState<CreatedCredential | null>(null);
	const [deposits, setDeposits] = useState<DepositRecord[]>([]);
	const [selectedDeposit, setSelectedDeposit] = useState<DepositRecord | null>(
		null,
	);
	const [lastRefundTxHash, setLastRefundTxHash] = useState<string | null>(null);
	const [watching, setWatching] = useState(false);

	const readyDeposits = useMemo(
		() => deposits.filter((deposit) => deposit.ready && !deposit.refunded),
		[deposits],
	);

	useEffect(() => {
		if (readyDeposits.length > 0 && !isRefunding && !isDeploying) {
			setStatusMessage("Money arrived! You can refund it now.");
		}
	}, [isDeploying, isRefunding, readyDeposits.length]);

	useEffect(() => {
		if (!accountAddress) {
			return;
		}

		let isMounted = true;
		let intervalId: number | undefined;

		const fetchDeposits = async () => {
			try {
				const response = await fetch(
					`${SERVER_URL}/account/${accountAddress}/deposits`,
				);
				if (!response.ok) {
					throw new Error("Failed to fetch deposits");
				}
				const payload = await response.json();
				if (!isMounted) {
					return;
				}

				setDeposits(payload.deposits ?? []);
				setWatching(payload.watching ?? false);
				setPollError(null);
			} catch (error) {
				if (isMounted) {
					setPollError(
						error instanceof Error ? error.message : "Failed to poll deposits",
					);
				}
			}
		};

		void fetchDeposits();
		intervalId = window.setInterval(fetchDeposits, 5_000);

		return () => {
			isMounted = false;
			if (intervalId) {
				clearInterval(intervalId);
			}
		};
	}, [accountAddress]);

	useEffect(() => {
		if (!deposits.length) {
			setSelectedDeposit(null);
			return;
		}

		setSelectedDeposit((current) => {
			if (current) {
				const stillAvailable = deposits.find(
					(deposit) =>
						deposit.txHash === current.txHash &&
						deposit.logIndex === current.logIndex,
				);
				if (stillAvailable) {
					return stillAvailable;
				}
			}
			return (
				deposits.find((deposit) => deposit.ready && !deposit.refunded) ??
				deposits[0]
			);
		});
	}, [deposits]);

	const copyAddress = useCallback(async () => {
		if (!accountAddress) {
			return;
		}
		try {
			if (!navigator.clipboard) {
				setStatusMessage("Clipboard API unavailable.");
				return;
			}
			await navigator.clipboard.writeText(accountAddress);
			setStatusMessage("Address copied to clipboard.");
		} catch (error) {
			console.error(error);
			setStatusMessage("Unable to copy address.");
		}
	}, [accountAddress]);

	const createAccount = useCallback(async () => {
		try {
			setIsDeploying(true);
			setStatusMessage("Creating WebAuthn credential…");
			setPollError(null);
			setDeposits([]);
			setSelectedDeposit(null);
			setLastRefundTxHash(null);

			const createdCredential = await createCompatCredential();
			setCredential(createdCredential);

			const publicKey = {
				prefix: createdCredential.publicKey.prefix,
				x: `0x${createdCredential.publicKey.x.toString(16).padStart(64, "0")}`,
				y: `0x${createdCredential.publicKey.y.toString(16).padStart(64, "0")}`,
			};

			setStatusMessage("Deploying WebAuthn account…");

			const response = await fetch(`${SERVER_URL}/account/create`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					credentialId: createdCredential.id,
					publicKey,
				}),
			});

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || "Failed to create account");
			}

			const result = await response.json();
			const deployedAddress = result.accountAddress as string;
			setAccountAddress(deployedAddress);
			setStatusMessage("Account ready. Deposit at least 1 USDC (Sepolia) to continue.");
		} catch (err) {
			console.error("Error creating account:", err);
			setStatusMessage(
				`Error: ${err instanceof Error ? err.message : "Unknown error occurred"}`,
			);
		} finally {
			setIsDeploying(false);
		}
	}, []);

	const refundDeposit = useCallback(async () => {
		if (!accountAddress || !credential || !selectedDeposit) {
			return;
		}

		try {
			setIsRefunding(true);
			setStatusMessage("Preparing refund user operation…");

			const nonce = await publicClient.readContract({
				address: ENTRYPOINT_ADDRESS,
				abi: entryPointAbi,
				functionName: "getNonce",
				args: [accountAddress as `0x${string}`, 0n],
			});

			const transferCalldata = encodeFunctionData({
				abi: usdcAbi,
				functionName: "transfer",
				args: [selectedDeposit.sender, BigInt(selectedDeposit.amount)],
			});

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
				[[[USDC_ADDRESS, 0n, transferCalldata]]],
			);

			const callData = encodeFunctionData({
				abi: accountWebAuthnAbi,
				functionName: "execute",
				args: [EXECUTE_MODE, executionData],
			});

			const feeData = await publicClient.estimateFeesPerGas();

			const userOp: PackedUserOperation = {
				sender: accountAddress as `0x${string}`,
				nonce,
				initCode: "0x",
				callData,
				accountGasLimits: encodePacked(
					["uint128", "uint128"],
					[
						1_000_000n,
						300_000n,
					],
				),
				preVerificationGas: 100_000n,
				gasFees: encodePacked(
					["uint128", "uint128"],
					[feeData.maxPriorityFeePerGas, feeData.maxFeePerGas],
				),
				paymasterAndData: "0x",
				signature: "0x" as Hex,
			};

			const userOpHash = await publicClient.readContract({
				address: ENTRYPOINT_ADDRESS,
				abi: entryPointAbi,
				functionName: "getUserOpHash",
				args: [userOp],
			});

			setStatusMessage("Signing refund with WebAuthn…");

			const { signature, metadata } = await WebAuthnP256.sign({
				challenge: userOpHash,
				credentialId: credential.id,
			});

			const rHex = `0x${signature.r.toString(16).padStart(64, "0")}` as Hex;
			const sHex = `0x${signature.s.toString(16).padStart(64, "0")}` as Hex;

			setStatusMessage("Submitting refund to bundler…");

			const response = await fetch(`${SERVER_URL}/account/refund`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					accountAddress,
					credentialId: credential.id,
					rHex,
					sHex,
					metadata,
					userOp: serializeBigInts(userOp),
					nonce: nonce.toString(),
					deposit: {
						txHash: selectedDeposit.txHash,
						logIndex: selectedDeposit.logIndex,
						sender: selectedDeposit.sender,
						amount: selectedDeposit.amount,
					},
				}),
			});

			const result = await response.json();
			if (!response.ok) {
				throw new Error(result.error || "Refund failed");
			}

			if (result.hash) {
				setLastRefundTxHash(result.hash);
				setStatusMessage("Refund sent! Waiting for confirmation…");
			} else {
				setStatusMessage("Refund sent.");
			}
		} catch (error) {
			console.error("Error refunding deposit:", error);
			setStatusMessage(
				`Error: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		} finally {
			setIsRefunding(false);
		}
	}, [accountAddress, credential, selectedDeposit]);

	const minDepositDisplay = useMemo(() => {
		return formatUnits(10n ** BigInt(USDC_DECIMALS), USDC_DECIMALS);
	}, []);

	return (
		<div className="app-shell">
			<h1>WebAuthn Account Abstraction</h1>
			<p className="subtitle">
				Create an AA wallet, deposit testnet USDC, and safely refund it using WebAuthn
				signatures.
			</p>

			<div className="card">
				<div className="actions">
					<button
						type="button"
						onClick={createAccount}
						disabled={isDeploying || isRefunding}
					>
						{isDeploying ? "Deploying…" : "Create / Restore Account"}
					</button>
					{statusMessage && (
						<div
							className={`status-message ${
								statusMessage.startsWith("Error")
									? "error"
									: statusMessage.startsWith("Success") ||
											statusMessage.startsWith("Refund sent")
										? "success"
										: ""
							}`}
						>
							{(isDeploying || isRefunding) && <div className="spinner" />}
							<p>{statusMessage}</p>
						</div>
					)}
				</div>

				{accountAddress && (
					<>
						<section className="account-panel">
							<div className="qr-section">
								<QRCodeSVG value={accountAddress} size={180} />
								<p>Scan or copy the AA address to send ≥ {minDepositDisplay} USDC.</p>
								<button type="button" onClick={copyAddress}>
									Copy Address
								</button>
							</div>
							<div className="details">
								<h3>Account Address</h3>
								<code>{accountAddress}</code>
								<p className="hint">
									Fund this account with Sepolia USDC (Circle faucet) from another wallet,
									then return here to trigger a refund.
								</p>
							</div>
						</section>

						<section className="deposits-panel">
							<header>
								<h3>Incoming Deposits</h3>
								<span
									className={`badge ${pollError ? "badge-error" : watching ? "badge-live" : "badge-idle"}`}
								>
									{pollError ? "Polling error" : watching ? "Watching" : "Idle"}
								</span>
							</header>

							{pollError && <p className="error-text">{pollError}</p>}

							{deposits.length === 0 ? (
								<p className="hint">Waiting for the first USDC transfer…</p>
							) : (
								<ul className="deposit-list">
									{deposits.map((deposit) => {
										const isSelected =
											selectedDeposit &&
											deposit.txHash === selectedDeposit.txHash &&
											deposit.logIndex === selectedDeposit.logIndex;
										const amountDisplay = formatUnits(
											BigInt(deposit.amount),
											USDC_DECIMALS,
										);

										return (
											<li key={`${deposit.txHash}-${deposit.logIndex}`}>
												<button
													type="button"
													className={`deposit-card ${
														isSelected ? "selected" : ""
													}`}
													onClick={() => setSelectedDeposit(deposit)}
												>
													<div className="deposit-row">
														<span className="label">Amount</span>
														<strong>{amountDisplay} USDC</strong>
													</div>
													<div className="deposit-row">
														<span className="label">Sender</span>
														<span>{formatAddress(deposit.sender)}</span>
													</div>
													<div className="deposit-row">
														<span className="label">Status</span>
														<span
															className={`pill ${
																deposit.refunded
																	? "pill-muted"
																	: deposit.ready
																		? "pill-ready"
																		: "pill-pending"
															}`}
														>
															{deposit.refunded
																? "Refunded"
																: deposit.ready
																	? "Ready"
																	: "Pending"}
														</span>
													</div>
													<div className="deposit-row">
														<span className="label">Received</span>
														<time>
															{new Date(
																deposit.blockTimestamp * 1000,
															).toLocaleString()}
														</time>
													</div>
												</button>
											</li>
										);
									})}
								</ul>
							)}
						</section>

						<section className="refund-panel">
							<h3>Refund Funds</h3>
							<p className="hint">
								Select a ready deposit and trigger a WebAuthn-signed refund to the original sender.
							</p>
							<button
								type="button"
								onClick={refundDeposit}
								disabled={
									!selectedDeposit ||
									!selectedDeposit.ready ||
									selectedDeposit.refunded ||
									isRefunding ||
									isDeploying
								}
							>
								{isRefunding ? "Submitting…" : "Refund Selected Deposit"}
							</button>
							{lastRefundTxHash && (
								<p className="tx-link">
									<a
										href={`https://sepolia.etherscan.io/tx/${lastRefundTxHash}`}
										target="_blank"
										rel="noopener noreferrer"
									>
										View refund transaction ↗
									</a>
								</p>
							)}
						</section>
					</>
				)}
			</div>
		</div>
	);
}

export default App;
