export * from "./EntrypointV08";
export const FACTORY_ADDRESS =
	"0x7F3505c23FD8ef643447D528E34beb3aF90C4A47" as const;
export const ENTRYPOINT_ADDRESS =
	"0x4337084d9e255ff0702461cf8895ce9e3b5ff108" as const;
export const USDC_ADDRESS =
	"0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
export const USDC_DECIMALS = 6;
export const usdcAbi = [
	{
		type: "event",
		name: "Transfer",
		anonymous: false,
		inputs: [
			{ indexed: true, name: "from", type: "address" },
			{ indexed: true, name: "to", type: "address" },
			{ indexed: false, name: "value", type: "uint256" },
		],
	},
	{
		type: "function",
		stateMutability: "view",
		name: "balanceOf",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ type: "uint256" }],
	},
	{
		type: "function",
		stateMutability: "view",
		name: "decimals",
		inputs: [],
		outputs: [{ type: "uint8" }],
	},
	{
		type: "function",
		stateMutability: "nonpayable",
		name: "transfer",
		inputs: [
			{ name: "recipient", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ type: "bool" }],
	},
] as const;
export { abi as accountWebAuthnAbi } from "../contract/out/AccountWebAuthn.sol/AccountWebAuthn.json";
export { abi as accountFactoryAbi } from "../contract/out/AccountFactory.sol/AccountFactory.json";
