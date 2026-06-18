import { type Db, MongoClient } from "mongodb";

// mongo-a = origem (replica set rs0, change streams). mongo-b = destino.
export const SRC_URI = "mongodb://127.0.0.1:27020/?directConnection=true";
export const DST_URI = "mongodb://127.0.0.1:27021/?directConnection=true";

export async function connect(uri: string): Promise<MongoClient> {
	return new MongoClient(uri).connect();
}

let dbCounter = 0;
/** Nome de db único por teste pra evitar colisão entre casos no mesmo cluster. */
export function uniqueDbName(prefix = "t"): string {
	dbCounter += 1;
	return `pulsar_test_${prefix}_${process.pid}_${dbCounter}`;
}

export async function dropDb(client: MongoClient, name: string): Promise<void> {
	await client.db(name).dropDatabase();
}

/** Semeia `n` docs simples numa collection: { _id: i, v: <seedValue> }. */
export async function seed(
	db: Db,
	coll: string,
	n: number,
	seedValue: (i: number) => Record<string, unknown> = (i) => ({ v: i }),
): Promise<void> {
	if (n === 0) return;
	const docs = Array.from({ length: n }, (_, i) => ({
		_id: i as any,
		...seedValue(i),
	}));
	await db.collection(coll).insertMany(docs);
}

/**
 * Abre um change stream e só resolve quando ele está REALMENTE escutando.
 * Necessário porque eventos disparados logo após `watch()` podem ser perdidos
 * até o cursor estabelecer no servidor. Faz um write-sentinela numa collection
 * separada e espera o stream não pegá-lo (ele está num namespace diferente),
 * apenas usando o tempo de ida e volta pra garantir o cursor aberto.
 */
export async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

/** Espera `fn()` retornar truthy, ou estoura após `timeoutMs`. */
export async function waitFor(
	fn: () => Promise<boolean> | boolean,
	timeoutMs = 5000,
	stepMs = 50,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await fn()) return true;
		await sleep(stepMs);
	}
	return false;
}
