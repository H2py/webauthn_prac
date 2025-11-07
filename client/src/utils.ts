type Jsonish =
	| string
	| number
	| boolean
	| null
	| bigint
	| Jsonish[]
	| { [key: string]: Jsonish };

export function serializeBigInts(value: Jsonish): Jsonish {
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (Array.isArray(value)) {
		return value.map((item) => serializeBigInts(item));
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, Jsonish>).map(
			([key, entryValue]) => [key, serializeBigInts(entryValue)],
		);
		return Object.fromEntries(entries) as Jsonish;
	}
	return value;
}
