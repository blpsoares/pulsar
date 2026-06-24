# Comando `ttl` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar o comando standalone `pulsar ttl` que cria índices TTL em massa em várias collections, via YAML granular ou flags CLI uniformes.

**Architecture:** Comando novo isolado em `commands/ttl.ts` que reusa `db/conn.ts`, `functions/getCollections.ts` e `utils/parseYml.ts`. A lógica fica em funções puras pequenas (`parseDuration`, `resolveTtlEntry`) + funções de banco (`deriveCreated`, `applyTtl`). TTL só funciona em campo BSON `Date`; quando a collection não tem campo de data, materializamos `_created` a partir do `_id` via `updateMany` com pipeline.

**Tech Stack:** Bun, TypeScript, mongodb v6, commander, Zod, Biome. Testes com `bun:test` contra Mongo real (`mongo-a`/`mongo-b` dos containers).

## Global Constraints

- **TTL só em campo `Date`.** `_id` direto é impossível (Mongo recusa o índice + ObjectId não expira). Sem campo `Date` → materializar `_created` via `updateMany` pipeline.
- **Campo derivado chama-se `_created`** (não `_ttl`).
- **Nada implícito:** derivar do `_id` exige `deriveFromId: true` (yml) ou `--derive-from-id` (CLI). Sem `field` nem `deriveFromId` resolvidos → erro, não executa.
- **`field` e `deriveFromId` são mutuamente exclusivos.** `--collections` e `--all` são mutuamente exclusivos.
- **Duração:** `30d`/`1h`/`3mo` → segundos. Unidades: `s/sec/seconds`, `min/minutes`, `h/hours`, `d/days`, `w/weeks`, `mo/months`(30d), `y/years`(365d). `m` sozinho é **proibido**. Mês=30d, ano=365d.
- **Segurança:** nenhuma URI/credencial real em código, testes, docs ou exemplos. Só placeholders (`mongodb://...`) ou containers locais (`127.0.0.1:27020/27021`). Conferir `git diff --staged` antes de cada commit.
- **Rodar testes:** `bun test` (containers de pé: `bun run test:up`). Helpers de teste em `test/helpers.ts` (`connect`, `DST_URI`, `uniqueDbName`, `dropDb`, `waitFor`).
- **Lint:** `bun run check` (Biome) antes de cada commit, se existir; senão pular.

---

### Task 1: `parseDuration` — duração humana → segundos

Função pura, sem banco. Base de tudo.

**Files:**
- Create: `src/core/ttl/parseDuration.ts`
- Test: `test/parseDuration.test.ts`

**Interfaces:**
- Produces: `parseDuration(input: string | number): number` — recebe `"30d"`, `"1h"`, `"3mo"`, ou um número (já em segundos) e retorna segundos. Lança `Error` em unidade inválida, `m` sozinho, ou formato inválido.

- [ ] **Step 1: Write the failing test**

```ts
// test/parseDuration.test.ts
import { describe, expect, test } from "bun:test";
import { parseDuration } from "../src/core/ttl/parseDuration";

describe("parseDuration", () => {
	test("converte cada unidade pra segundos", () => {
		expect(parseDuration("30s")).toBe(30);
		expect(parseDuration("30sec")).toBe(30);
		expect(parseDuration("30seconds")).toBe(30);
		expect(parseDuration("5min")).toBe(300);
		expect(parseDuration("5minutes")).toBe(300);
		expect(parseDuration("2h")).toBe(7200);
		expect(parseDuration("2hours")).toBe(7200);
		expect(parseDuration("1d")).toBe(86400);
		expect(parseDuration("1days")).toBe(86400);
		expect(parseDuration("1w")).toBe(604800);
		expect(parseDuration("1weeks")).toBe(604800);
		expect(parseDuration("1mo")).toBe(2592000); // 30 dias
		expect(parseDuration("3months")).toBe(7776000); // 90 dias
		expect(parseDuration("1y")).toBe(31536000); // 365 dias
		expect(parseDuration("2years")).toBe(63072000);
	});

	test("aceita número cru como segundos", () => {
		expect(parseDuration(86400)).toBe(86400);
	});

	test("proíbe 'm' sozinho (ambíguo minuto/mês)", () => {
		expect(() => parseDuration("5m")).toThrow();
	});

	test("rejeita unidade inválida", () => {
		expect(() => parseDuration("5x")).toThrow();
	});

	test("rejeita formato inválido", () => {
		expect(() => parseDuration("abc")).toThrow();
		expect(() => parseDuration("d")).toThrow();
		expect(() => parseDuration("30 d")).toThrow();
	});

	test("rejeita zero ou negativo", () => {
		expect(() => parseDuration("0d")).toThrow();
		expect(() => parseDuration(-5)).toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/parseDuration.test.ts`
Expected: FAIL — `Cannot find module '../src/core/ttl/parseDuration'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/ttl/parseDuration.ts

const UNIT_SECONDS: Record<string, number> = {
	s: 1,
	sec: 1,
	seconds: 1,
	min: 60,
	minutes: 60,
	h: 3600,
	hours: 3600,
	d: 86400,
	days: 86400,
	w: 604800,
	weeks: 604800,
	mo: 2592000, // 30 dias
	months: 2592000,
	y: 31536000, // 365 dias
	years: 31536000,
};

/**
 * Converte duração humana ("30d", "1h", "3mo") em segundos pro expireAfterSeconds.
 * Aceita também um número (já em segundos). 'm' sozinho é proibido por ser ambíguo
 * (minuto vs mês): use 'min' ou 'mo'. Mês = 30d, ano = 365d.
 */
export function parseDuration(input: string | number): number {
	if (typeof input === "number") {
		if (!Number.isFinite(input) || input <= 0) {
			throw new Error(`Duração inválida: ${input} (precisa ser > 0)`);
		}
		return Math.floor(input);
	}

	const match = input.trim().match(/^(\d+)(s|sec|seconds|min|minutes|h|hours|d|days|w|weeks|mo|months|y|years)$/);
	if (!match) {
		throw new Error(
			`Duração inválida: "${input}". Use <número><unidade>, ex.: 30d, 1h, 3mo. ` +
				`Unidades: s/sec/seconds, min/minutes, h/hours, d/days, w/weeks, mo/months, y/years. ` +
				`'m' sozinho é proibido (ambíguo minuto/mês): use 'min' ou 'mo'.`,
		);
	}

	const value = Number(match[1]);
	if (value <= 0) {
		throw new Error(`Duração inválida: "${input}" (precisa ser > 0)`);
	}
	return value * UNIT_SECONDS[match[2]];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/parseDuration.test.ts`
Expected: PASS (todos os casos)

- [ ] **Step 5: Commit**

```bash
git add src/core/ttl/parseDuration.ts test/parseDuration.test.ts
git commit -m "feat: parseDuration — duração humana para segundos no comando ttl"
```

---

### Task 2: Schema YAML + `resolveTtlEntry` — precedência defaults/override

Define o tipo do yml (Zod) e a função pura que resolve cada collection.

**Files:**
- Modify: `src/types/parseYml.ts` (adicionar `ttlYmlSchema`, tipos)
- Create: `src/core/ttl/resolveTtlEntry.ts`
- Test: `test/resolveTtlEntry.test.ts`

**Interfaces:**
- Consumes: `parseDuration` (Task 1).
- Produces:
  - Em `types/parseYml.ts`: `ttlYmlSchema`, `type TtlYmlOptions`, `type TtlCollectionEntry`, `type TtlDefaults`.
  - `resolveTtlEntry(entry: TtlCollectionEntry, defaults?: TtlDefaults): ResolvedTtl` onde `type ResolvedTtl = { name: string; field: string; deriveFromId: boolean; expireAfterSeconds: number }`. Lança `Error` quando não resolve campo, quando `field`+`deriveFromId` colidem, ou quando falta `expire`.

- [ ] **Step 1: Write the failing test**

```ts
// test/resolveTtlEntry.test.ts
import { describe, expect, test } from "bun:test";
import { resolveTtlEntry } from "../src/core/ttl/resolveTtlEntry";

describe("resolveTtlEntry", () => {
	test("string herda field e expire dos defaults", () => {
		const r = resolveTtlEntry("orders", { deriveFromId: true, expire: "30d" });
		expect(r).toEqual({
			name: "orders",
			field: "_created",
			deriveFromId: true,
			expireAfterSeconds: 2592000,
		});
	});

	test("override de field e expire na collection", () => {
		const r = resolveTtlEntry(
			{ name: "sessions", field: "lastActivity", expire: "1h" },
			{ deriveFromId: true, expire: "30d" },
		);
		expect(r).toEqual({
			name: "sessions",
			field: "lastActivity",
			deriveFromId: false,
			expireAfterSeconds: 3600,
		});
	});

	test("expireAfterSeconds cru também funciona", () => {
		const r = resolveTtlEntry({ name: "x", field: "ts", expireAfterSeconds: 10 }, undefined);
		expect(r.expireAfterSeconds).toBe(10);
	});

	test("erro quando não há field nem deriveFromId", () => {
		expect(() => resolveTtlEntry({ name: "x", expire: "1d" }, undefined)).toThrow(/sem campo de TTL/);
	});

	test("erro quando field e deriveFromId colidem", () => {
		expect(() =>
			resolveTtlEntry({ name: "x", field: "ts", deriveFromId: true, expire: "1d" }, undefined),
		).toThrow(/mutuamente exclusivos|field.*deriveFromId/);
	});

	test("erro quando falta expire", () => {
		expect(() => resolveTtlEntry({ name: "x", field: "ts" }, undefined)).toThrow(/expire/);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/resolveTtlEntry.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3a: Adicionar schema em `src/types/parseYml.ts`**

Adicionar ao final do arquivo (antes/junto dos `export type`):

```ts
const ttlCollectionEntrySchema = z.union([
	z.string(),
	z
		.object({
			name: z.string(),
			field: z.string().optional(),
			deriveFromId: z.boolean().optional(),
			expire: z.union([z.string(), z.number()]).optional(),
			expireAfterSeconds: z.number().int().positive().optional(),
		})
		.refine((d) => !(d.field && d.deriveFromId), {
			message: 'Use "field" ou "deriveFromId", não os dois',
		}),
]);

const ttlDefaultsSchema = z.object({
	field: z.string().optional(),
	deriveFromId: z.boolean().optional(),
	expire: z.union([z.string(), z.number()]).optional(),
	expireAfterSeconds: z.number().int().positive().optional(),
});

export const ttlYmlSchema = z.object({
	command: z.object({
		ttl: z.object({
			source: z.object({
				uri: z.string(),
				db: z.string(),
			}),
			defaults: ttlDefaultsSchema.optional(),
			collections: z.array(ttlCollectionEntrySchema).optional(),
		}),
	}),
});

export type TtlCollectionEntry = z.infer<typeof ttlCollectionEntrySchema>;
export type TtlDefaults = z.infer<typeof ttlDefaultsSchema>;
export type TtlYmlOptions = z.infer<typeof ttlYmlSchema>;
```

- [ ] **Step 3b: Implementar `src/core/ttl/resolveTtlEntry.ts`**

```ts
// src/core/ttl/resolveTtlEntry.ts
import { parseDuration } from "./parseDuration";
import type { TtlCollectionEntry, TtlDefaults } from "../../types/parseYml";

export type ResolvedTtl = {
	name: string;
	field: string;
	deriveFromId: boolean;
	expireAfterSeconds: number;
};

/** Nome do campo materializado a partir do _id quando deriveFromId está ligado. */
export const DERIVED_FIELD = "_created";

/**
 * Resolve uma entrada de collection contra os defaults, aplicando precedência:
 * o que a collection define ganha; senão herda do default. Lança erro quando
 * não dá pra resolver um campo de TTL (nada implícito).
 */
export function resolveTtlEntry(entry: TtlCollectionEntry, defaults?: TtlDefaults): ResolvedTtl {
	const obj = typeof entry === "string" ? { name: entry } : entry;
	const d = defaults ?? {};

	const field = obj.field ?? d.field;
	const deriveFromId = obj.deriveFromId ?? d.deriveFromId ?? false;

	if (field && deriveFromId) {
		throw new Error(`Collection "${obj.name}": "field" e "deriveFromId" são mutuamente exclusivos`);
	}
	if (!field && !deriveFromId) {
		throw new Error(
			`Collection "${obj.name}" sem campo de TTL definido: informe "field" (campo Date existente) ou "deriveFromId: true"`,
		);
	}

	const rawExpire = obj.expire ?? obj.expireAfterSeconds ?? d.expire ?? d.expireAfterSeconds;
	if (rawExpire === undefined) {
		throw new Error(`Collection "${obj.name}" sem "expire"/"expireAfterSeconds" definido`);
	}

	return {
		name: obj.name,
		field: deriveFromId ? DERIVED_FIELD : (field as string),
		deriveFromId,
		expireAfterSeconds: parseDuration(rawExpire),
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/resolveTtlEntry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/parseYml.ts src/core/ttl/resolveTtlEntry.ts test/resolveTtlEntry.test.ts
git commit -m "feat: schema yml do ttl + resolveTtlEntry (precedência defaults/override)"
```

---

### Task 3: `deriveCreated` — materializar `_created` a partir do `_id`

Função de banco. Roda o `updateMany` com pipeline, idempotente.

**Files:**
- Create: `src/core/ttl/deriveCreated.ts`
- Test: `test/deriveCreated.test.ts`

**Interfaces:**
- Produces: `deriveCreated(db: Db, collection: string, field?: string): Promise<number>` — preenche `field` (default `_created`) com `{ $toDate: "$_id" }` só nos docs que ainda não têm. Retorna quantos docs foram modificados. Pré-condição: `_id` é ObjectId.

- [ ] **Step 1: Write the failing test**

```ts
// test/deriveCreated.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, type MongoClient, ObjectId } from "mongodb";
import { deriveCreated } from "../src/core/ttl/deriveCreated";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(DST_URI);
	dbName = uniqueDbName("derive");
	db = client.db(dbName);
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

describe("deriveCreated", () => {
	test("materializa _created = timestamp do _id, e é idempotente", async () => {
		const oid = new ObjectId("58c8e3a0000000000000000a"); // 2017
		await db.collection("c1").insertOne({ _id: oid, nome: "x" });

		const modified = await deriveCreated(db, "c1");
		expect(modified).toBe(1);

		const doc = await db.collection("c1").findOne({ _id: oid });
		expect(doc?._created).toBeInstanceOf(Date);
		expect((doc?._created as Date).getTime()).toBe(oid.getTimestamp().getTime());

		// rodar de novo não modifica (filtro $exists:false)
		const again = await deriveCreated(db, "c1");
		expect(again).toBe(0);
	});

	test("aceita nome de campo customizado", async () => {
		await db.collection("c2").insertOne({ _id: new ObjectId(), nome: "y" });
		const modified = await deriveCreated(db, "c2", "_meuCampo");
		expect(modified).toBe(1);
		const doc = await db.collection("c2").findOne({ nome: "y" });
		expect(doc?._meuCampo).toBeInstanceOf(Date);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/deriveCreated.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/ttl/deriveCreated.ts
import type { Db } from "mongodb";
import { DERIVED_FIELD } from "./resolveTtlEntry";

/**
 * Materializa um campo Date a partir do timestamp embutido no _id (ObjectId),
 * via updateMany com pipeline ($toDate). Só toca docs que ainda não têm o campo
 * (idempotente). Retorna a quantidade de docs modificados.
 *
 * Necessário porque TTL só funciona em campo BSON Date; _id (ObjectId) não expira.
 * One-shot sobre os docs existentes — inserts futuros não são cobertos aqui.
 */
export async function deriveCreated(db: Db, collection: string, field: string = DERIVED_FIELD): Promise<number> {
	const res = await db.collection(collection).updateMany({ [field]: { $exists: false } }, [
		{ $set: { [field]: { $toDate: "$_id" } } },
	]);
	return res.modifiedCount;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/deriveCreated.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/ttl/deriveCreated.ts test/deriveCreated.test.ts
git commit -m "feat: deriveCreated — materializa _created a partir do _id (idempotente)"
```

---

### Task 4: `applyTtl` — orquestra derive + createIndex por collection

Junta tudo por collection: se `deriveFromId`, materializa; depois cria o índice TTL.

**Files:**
- Create: `src/core/ttl/applyTtl.ts`
- Test: `test/applyTtl.test.ts`

**Interfaces:**
- Consumes: `ResolvedTtl` (Task 2), `deriveCreated` (Task 3).
- Produces: `applyTtl(db: Db, resolved: ResolvedTtl): Promise<{ name: string; field: string; expireAfterSeconds: number; derivedCount?: number; indexName: string }>` — quando `deriveFromId`, chama `deriveCreated`; sempre cria `createIndex({ [field]: 1 }, { expireAfterSeconds })`. Retorna um resumo.

- [ ] **Step 1: Write the failing test**

```ts
// test/applyTtl.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, type MongoClient, ObjectId } from "mongodb";
import { applyTtl } from "../src/core/ttl/applyTtl";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(DST_URI);
	dbName = uniqueDbName("apply");
	db = client.db(dbName);
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

async function ttlIndex(db: Db, coll: string, field: string) {
	const idx = await db.collection(coll).indexes();
	return idx.find((i) => i.key?.[field] === 1 && i.expireAfterSeconds !== undefined);
}

describe("applyTtl", () => {
	test("deriveFromId: materializa _created e cria índice TTL nele", async () => {
		await db.collection("a").insertOne({ _id: new ObjectId(), x: 1 });
		const out = await applyTtl(db, {
			name: "a",
			field: "_created",
			deriveFromId: true,
			expireAfterSeconds: 2592000,
		});
		expect(out.derivedCount).toBe(1);
		const idx = await ttlIndex(db, "a", "_created");
		expect(idx?.expireAfterSeconds).toBe(2592000);
	});

	test("campo Date existente: cria índice TTL sem materializar", async () => {
		await db.collection("b").insertOne({ ts: new Date("2020-01-01"), x: 1 });
		const out = await applyTtl(db, {
			name: "b",
			field: "ts",
			deriveFromId: false,
			expireAfterSeconds: 3600,
		});
		expect(out.derivedCount).toBeUndefined();
		const idx = await ttlIndex(db, "b", "ts");
		expect(idx?.expireAfterSeconds).toBe(3600);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/applyTtl.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/ttl/applyTtl.ts
import type { Db } from "mongodb";
import { deriveCreated } from "./deriveCreated";
import type { ResolvedTtl } from "./resolveTtlEntry";

export type TtlResult = {
	name: string;
	field: string;
	expireAfterSeconds: number;
	derivedCount?: number;
	indexName: string;
};

/**
 * Aplica o TTL numa collection já resolvida: se deriveFromId, materializa o
 * campo _created a partir do _id; depois cria o índice TTL no campo.
 */
export async function applyTtl(db: Db, resolved: ResolvedTtl): Promise<TtlResult> {
	let derivedCount: number | undefined;
	if (resolved.deriveFromId) {
		derivedCount = await deriveCreated(db, resolved.name, resolved.field);
	}

	const indexName = await db
		.collection(resolved.name)
		.createIndex({ [resolved.field]: 1 }, { expireAfterSeconds: resolved.expireAfterSeconds });

	return {
		name: resolved.name,
		field: resolved.field,
		expireAfterSeconds: resolved.expireAfterSeconds,
		derivedCount,
		indexName,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/applyTtl.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/ttl/applyTtl.ts test/applyTtl.test.ts
git commit -m "feat: applyTtl — materializa (se preciso) e cria o índice TTL por collection"
```

---

### Task 5: Comando `ttl` — wiring CLI + YAML

Liga tudo no commander: modo YAML (com arquivo) e modo CLI (flags). Resolve collections, loga resumo.

**Files:**
- Create: `src/commands/ttl.ts`
- Modify: `src/cli.ts` (registrar `program.command("ttl [file]")`)
- Modify: `src/types/cliOptions.d.ts` (adicionar `TtlOptionsCli`)
- Test: `test/ttlCommand.test.ts`

**Interfaces:**
- Consumes: `parseYml`, `ttlYmlSchema`/`TtlYmlOptions` (Task 2), `resolveTtlEntry` (Task 2), `applyTtl` (Task 4), `conn` (`db/conn.ts`).
- Produces:
  - Em `cliOptions.d.ts`: `type TtlOptionsCli = { uri?: string; db?: string; collections?: string; all?: boolean; field?: string; deriveFromId?: boolean; expire?: string }`.
  - `export async function ttlCommand(file: string | undefined, cli: TtlOptionsCli): Promise<TtlResult[]>` em `commands/ttl.ts`. Retorna os resultados aplicados (pra teste). Fecha a conexão ao fim.
  - Função auxiliar exportada `buildTtlPlan(file, cli)` opcional — ver implementação.

- [ ] **Step 1: Write the failing test**

```ts
// test/ttlCommand.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, type MongoClient, ObjectId } from "mongodb";
import { ttlCommand } from "../src/commands/ttl";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(DST_URI);
	dbName = uniqueDbName("ttlcmd");
	db = client.db(dbName);
	await db.collection("orders").insertOne({ _id: new ObjectId(), x: 1 });
	await db.collection("sessions").insertOne({ lastActivity: new Date("2020-01-01"), x: 1 });
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

describe("ttlCommand (modo CLI)", () => {
	test("deriveFromId uniforme aplica TTL em várias collections", async () => {
		const out = await ttlCommand(undefined, {
			uri: DST_URI,
			db: dbName,
			collections: "orders",
			deriveFromId: true,
			expire: "30d",
		});
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe("orders");
		expect(out[0].expireAfterSeconds).toBe(2592000);

		const idx = (await db.collection("orders").indexes()).find(
			(i) => i.key?._created === 1 && i.expireAfterSeconds === 2592000,
		);
		expect(idx).toBeTruthy();
	});

	test("field explícito num campo Date existente", async () => {
		const out = await ttlCommand(undefined, {
			uri: DST_URI,
			db: dbName,
			collections: "sessions",
			field: "lastActivity",
			expire: "1h",
		});
		expect(out[0].expireAfterSeconds).toBe(3600);
	});

	test("erro: field e deriveFromId juntos no CLI", async () => {
		await expect(
			ttlCommand(undefined, {
				uri: DST_URI,
				db: dbName,
				collections: "orders",
				field: "ts",
				deriveFromId: true,
				expire: "1d",
			}),
		).rejects.toThrow();
	});

	test("erro: sem --expire no modo CLI", async () => {
		await expect(
			ttlCommand(undefined, { uri: DST_URI, db: dbName, collections: "orders", deriveFromId: true }),
		).rejects.toThrow(/expire/i);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/ttlCommand.test.ts`
Expected: FAIL — módulo `../src/commands/ttl` não encontrado.

- [ ] **Step 3a: Adicionar tipo em `src/types/cliOptions.d.ts`**

```ts
export type TtlOptionsCli = {
	uri?: string;
	db?: string;
	collections?: string;
	all?: boolean;
	field?: string;
	deriveFromId?: boolean;
	expire?: string;
};
```

- [ ] **Step 3b: Implementar `src/commands/ttl.ts`**

```ts
// src/commands/ttl.ts
import { conn } from "../db/conn";
import parseYml from "../utils/parseYml";
import { customLog } from "../utils/customLog";
import { errorHandler } from "../errors/errorHandler";
import { getCollections } from "../functions/getCollections";
import { applyTtl, type TtlResult } from "../core/ttl/applyTtl";
import { resolveTtlEntry, type ResolvedTtl } from "../core/ttl/resolveTtlEntry";
import { ttlYmlSchema, type TtlYmlOptions, type TtlCollectionEntry, type TtlDefaults } from "../types/parseYml";
import type { TtlOptionsCli } from "../types/cliOptions";

type Plan = {
	uri: string;
	db: string;
	entries: TtlCollectionEntry[];
	defaults?: TtlDefaults;
	all: boolean;
};

/** Monta o plano a partir do yml (se houver arquivo) ou das flags CLI. */
function buildPlan(file: string | undefined, cli: TtlOptionsCli): Plan {
	if (file) {
		const opts = parseYml<TtlYmlOptions>(file, ttlYmlSchema);
		const { ttl } = opts.command;
		return {
			uri: ttl.source.uri,
			db: ttl.source.db,
			entries: ttl.collections ?? [],
			defaults: ttl.defaults,
			all: false,
		};
	}

	// modo CLI: validações de presença/exclusividade
	if (!cli.uri || !cli.db) throw new Error("Modo CLI exige --uri e --db");
	if (!cli.expire) throw new Error("Modo CLI exige --expire");
	if (cli.field && cli.deriveFromId) throw new Error("--field e --derive-from-id são mutuamente exclusivos");
	if (!cli.field && !cli.deriveFromId) throw new Error("Modo CLI exige --field ou --derive-from-id");
	if (cli.collections && cli.all) throw new Error("--collections e --all são mutuamente exclusivos");
	if (!cli.collections && !cli.all) throw new Error("Modo CLI exige --collections ou --all");

	const defaults: TtlDefaults = {
		field: cli.field,
		deriveFromId: cli.deriveFromId,
		expire: cli.expire,
	};
	const entries: TtlCollectionEntry[] = cli.collections
		? cli.collections.split(",").map((s) => s.trim()).filter(Boolean)
		: [];

	return { uri: cli.uri, db: cli.db, entries, defaults, all: Boolean(cli.all) };
}

export async function ttlCommand(file: string | undefined, cli: TtlOptionsCli): Promise<TtlResult[]> {
	const plan = buildPlan(file, cli);
	const client = await conn(plan.uri, "ttl");
	const db = client.db(plan.db);

	try {
		// resolve a lista de nomes (suporta --all reusando getCollections)
		const collectionEntries = await getCollections(
			db,
			{ all: plan.all },
			file ?? "(cli)",
			plan.entries as never,
		);

		// pra cada nome, casa com a entry original (pra herdar field/expire) e resolve
		const resolved: ResolvedTtl[] = collectionEntries.map(({ name }) => {
			const original = plan.entries.find(
				(e) => (typeof e === "string" ? e : e.name) === name,
			);
			return resolveTtlEntry(original ?? name, plan.defaults);
		});

		const results: TtlResult[] = [];
		for (const r of resolved) {
			const out = await applyTtl(db, r);
			results.push(out);
			const derived = out.derivedCount !== undefined ? ` (_created em ${out.derivedCount} docs)` : "";
			customLog("success", `TTL em ${out.name}: ${out.field} expira em ${out.expireAfterSeconds}s${derived}`);
		}

		customLog("info", `TTL aplicado em ${results.length} collection(s).`);
		return results;
	} catch (error) {
		throw errorHandler(error, "TTL:COMMAND");
	} finally {
		await client.close();
	}
}

export default ttlCommand;
```

> Nota: no `--all` o `getCollections` retorna todas as collections do banco e o `plan.entries` fica vazio, então cada uma cai no `resolveTtlEntry(name, defaults)` — herdando 100% dos defaults (que no CLI vêm das flags). Correto.

- [ ] **Step 3c: Registrar no `src/cli.ts`**

Adicionar import no topo, junto dos outros:

```ts
import { ttlCommand } from "./commands/ttl";
```

E adicionar o comando após o bloco do `sync` (antes de `program.parse`):

```ts
program
	.command("ttl [file]")
	.description("cria índices TTL em massa. Com [file] usa yml granular; sem arquivo, usa as flags abaixo (config uniforme).")
	.option("--uri <uri>", "URI do Mongo (modo CLI)")
	.option("--db <db>", "banco alvo (modo CLI)")
	.option("--collections <list>", "collections separadas por vírgula, ex.: orders,logs,posts")
	.option("-a --all", "aplica em todas as collections do banco")
	.option("--field <field>", "campo Date existente como base do TTL")
	.option("--derive-from-id", "materializa _created a partir do _id (explícito)")
	.option("--expire <dur>", "duração: 30d, 1h, 3mo, 90d... (mês=30d, ano=365d)")
	.action((file, opts) =>
		ttlCommand(file, {
			uri: opts.uri,
			db: opts.db,
			collections: opts.collections,
			all: opts.all,
			field: opts.field,
			deriveFromId: opts.deriveFromId,
			expire: opts.expire,
		}),
	);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/ttlCommand.test.ts`
Expected: PASS

- [ ] **Step 5: Smoke test manual no container**

```bash
# sobe containers se preciso
bun run test:up
# cria collection de teste e roda o comando de verdade
docker exec mongo-b mongosh --quiet --eval 'db.getSiblingDB("ttl_smoke").orders.insertMany([{x:1},{x:2}])'
bun run src/cli.ts ttl --uri "mongodb://127.0.0.1:27021/?directConnection=true" --db ttl_smoke --collections orders --derive-from-id --expire 30d
# confere índice TTL e _created
docker exec mongo-b mongosh --quiet --eval 'const d=db.getSiblingDB("ttl_smoke"); printjson(d.orders.getIndexes()); printjson(d.orders.findOne())'
# limpa
docker exec mongo-b mongosh --quiet --eval 'db.getSiblingDB("ttl_smoke").dropDatabase()'
```
Expected: índice `_created_1` com `expireAfterSeconds: 2592000`; docs com campo `_created` do tipo Date.

- [ ] **Step 6: Commit**

```bash
git add src/commands/ttl.ts src/cli.ts src/types/cliOptions.d.ts test/ttlCommand.test.ts
git commit -m "feat: comando pulsar ttl (modos yml e CLI) ligando o fluxo de TTL em massa"
```

---

### Task 6: Documentação + exemplo de yml

Atualiza `CLAUDE.md` e adiciona um yml de exemplo versionado (sem credenciais).

**Files:**
- Modify: `CLAUDE.md`
- Create: `configs/ttl-example.yml`

**Interfaces:** nenhuma (docs).

- [ ] **Step 1: Criar `configs/ttl-example.yml`**

```yaml
# Exemplo do comando `pulsar ttl` — cria índices TTL em massa.
# NUNCA commitar URI/credencial real aqui: use placeholder ou o mongo local.
command:
  ttl:
    source:
      uri: 'mongodb://127.0.0.1:27021/?directConnection=true'
      db: 'meu-banco'
    defaults:
      deriveFromId: true       # materializa _created a partir do _id (explícito)
      expire: 30d              # 30 dias
    collections:
      - orders                 # herda defaults (deriva _created, 30d)
      - logs                   # idem
      - name: sessions         # override
        field: lastActivity    #   usa campo Date existente
        expire: 1h             #   expira em 1h
      - name: trimestral
        field: createdAt
        expire: 3mo            # 90 dias
```

- [ ] **Step 2: Atualizar `CLAUDE.md`**

No bloco "Comandos úteis", adicionar:

```sh
bun run src/cli.ts ttl configs/ttl-example.yml                 # TTL em massa via yml
bun run src/cli.ts ttl --uri '...' --db x --all --derive-from-id --expire 30d  # via CLI
```

Em "Estrutura", adicionar sob `core/`:

```
    ttl/
      parseDuration.ts      # "30d"/"1h"/"3mo" -> segundos (mês=30d, ano=365d; 'm' proibido)
      resolveTtlEntry.ts    # precedência defaults+override por collection; erro se não resolve
      deriveCreated.ts      # updateMany pipeline { $toDate: "$_id" } -> campo _created (idempotente)
      applyTtl.ts           # materializa (se preciso) + createIndex TTL por collection
```

E adicionar uma seção nova após "## Formato dos YMLs":

```markdown
## Comando `ttl` — TTL em massa

Comando **standalone** (sem relação com sync). Cria índices TTL em várias collections.

**Restrição:** TTL só funciona em campo BSON `Date`. `_id` direto é impossível (o Mongo recusa o índice e ObjectId não expira). Quando a collection não tem campo de data, o pulsar materializa um campo `_created` a partir do `_id` via `updateMany` com pipeline (`{ $toDate: "$_id" }`), **só nos docs existentes** (inserts futuros não são cobertos — é one-shot).

Dois modos:
- **YAML** (`pulsar ttl arquivo.yml`): granular, `defaults` + override por collection.
- **CLI** (`pulsar ttl` + flags): uniforme pra um conjunto de collections.

Derivar do `_id` é **sempre explícito** (`deriveFromId: true` / `--derive-from-id`). Sem `field` nem `deriveFromId` → erro. `field` e `deriveFromId` são mutuamente exclusivos.

**Duração:** `30d`, `1h`, `3mo`... → `expireAfterSeconds`. Unidades: `s/sec/seconds`, `min/minutes`, `h/hours`, `d/days`, `w/weeks`, `mo/months` (30d), `y/years` (365d). `m` sozinho é proibido (ambíguo minuto/mês). Aceita `expireAfterSeconds` cru também.

Ver `configs/ttl-example.yml`.
```

- [ ] **Step 3: Verificar que não há credencial real**

```bash
git add CLAUDE.md configs/ttl-example.yml
git diff --staged | grep -nEi 'mongodb\+srv|://[^/ ]*:[^/ ]*@|password|secret|token' && echo "ABORTAR: secret encontrado" || echo "limpo"
```
Expected: `limpo`

- [ ] **Step 4: Commit**

```bash
git commit -m "docs: comando ttl no CLAUDE.md + configs/ttl-example.yml"
```

---

### Task 7: Suite completa + verificação final

- [ ] **Step 1: Rodar a suite inteira**

Run: `bun test`
Expected: todos os testes passam (incluindo os 40 antigos + os novos de ttl).

- [ ] **Step 2: Lint/format (se existir script)**

Run: `bun run check` (ou `bunx biome check --write src test`)
Expected: sem erros.

- [ ] **Step 3: Varredura final de secrets em todo o diff da branch**

```bash
git diff main --stat
git log --oneline main..HEAD
git diff main | grep -nEi 'mongodb\+srv|://[^/ ]*:[^/ ]*@|password|secret|token' && echo "ABORTAR" || echo "limpo — sem secrets"
```
Expected: `limpo — sem secrets`

---

## Self-Review

**Spec coverage:**
- Comando standalone `ttl` → Task 5. ✓
- TTL só em Date / `_id` impossível → Global Constraints + Task 6 docs. ✓
- `deriveFromId` materializa `_created` via pipeline → Task 3. ✓
- Idempotência (`$exists:false`) → Task 3. ✓
- YAML defaults + override → Task 2 + 5. ✓
- CLI uniforme + flags + exclusividades → Task 5. ✓
- Precedência + erro quando não resolve → Task 2. ✓
- Duração humana, `m` proibido, mês=30d/ano=365d → Task 1. ✓
- `--all` reusando getCollections → Task 5. ✓
- Reuso de conn/parseYml/getCollections → Task 5. ✓
- Docs (CLAUDE.md) + exemplo yml → Task 6. ✓
- Segurança sem secrets → cada commit + Task 7. ✓

**Placeholder scan:** nenhum TBD/TODO; todo passo de código tem o código. ✓

**Type consistency:** `ResolvedTtl`, `TtlResult`, `DERIVED_FIELD`, `resolveTtlEntry`, `deriveCreated`, `applyTtl`, `ttlCommand`, `TtlOptionsCli`, `ttlYmlSchema`/`TtlYmlOptions`/`TtlCollectionEntry`/`TtlDefaults` — nomes e assinaturas batem entre as tasks 1→5. ✓

**Limitação documentada:** inserts futuros sem `_created` (one-shot) — registrado na spec e no CLAUDE.md (Task 6). ✓
```
