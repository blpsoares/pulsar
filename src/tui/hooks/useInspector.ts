import type { MongoClient } from "mongodb";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type CollEstimate,
	countExact,
	estimateMany,
} from "../../core/inspect/collStats";
import { type DbSummary, dbSummary } from "../../core/inspect/dbStats";
import {
	type CollIndexes,
	indexSummaryMany,
} from "../../core/inspect/indexSummary";
import { type DbOverview, inspectDb } from "../../core/inspect/inspectDb";
import { type DatabaseInfo, probeConnection } from "../../core/inspect/probe";

/**
 * Toda a conversa da TUI com o Mongo passa por aqui.
 *
 * Concentrar num hook resolve duas coisas que dão errado quando cada tela
 * conecta por conta própria: (1) sobra cliente aberto quando o usuário volta
 * uma tela, e (2) uma resposta lenta chega depois que a tela já mudou e
 * sobrescreve o estado novo com dado velho. O `generation` abaixo é o guarda
 * contra o caso (2).
 */

export type ConnStatus = "idle" | "connecting" | "connected" | "error";

export type InspectorState = {
	status: ConnStatus;
	error?: string;
	/** bancos visíveis; vazio quando o usuário não tem permissão de listar */
	databases: DatabaseInfo[];
	overview?: DbOverview;
	/** banco cujo overview/summary está carregado — inclui o preview sob o cursor */
	currentDb?: string;
	/** retrato do banco escolhido: collections, views, índices, tamanho */
	summary?: DbSummary;
	estimates: CollEstimate[];
	indexes: CollIndexes[];
	loadingStats: boolean;
};

const INITIAL: InspectorState = {
	status: "idle",
	databases: [],
	estimates: [],
	indexes: [],
	loadingStats: false,
};

export function useInspector() {
	const [state, setState] = useState<InspectorState>(INITIAL);
	const clientRef = useRef<MongoClient | null>(null);
	// Cada conexão nova invalida as respostas em voo da anterior.
	const generation = useRef(0);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			clientRef.current?.close().catch(() => {});
			clientRef.current = null;
		};
	}, []);

	const apply = useCallback((gen: number, patch: Partial<InspectorState>) => {
		if (!mounted.current || gen !== generation.current) return;
		setState((prev) => ({ ...prev, ...patch }));
	}, []);

	const connect = useCallback(
		async (uri: string) => {
			generation.current += 1;
			const gen = generation.current;

			await clientRef.current?.close().catch(() => {});
			clientRef.current = null;
			setState({ ...INITIAL, status: "connecting" });

			const result = await probeConnection(uri);

			if (!result.ok) {
				apply(gen, { status: "error", error: result.error });
				return false;
			}

			// A tela pode ter mudado enquanto conectávamos: fecha o cliente órfão
			// em vez de vazar a conexão.
			if (gen !== generation.current || !mounted.current) {
				await result.client.close().catch(() => {});
				return false;
			}

			clientRef.current = result.client;
			apply(gen, {
				status: "connected",
				databases: result.databases,
				error: undefined,
			});
			return true;
		},
		[apply],
	);

	/** Lista collections e views do banco escolhido. Barato — só metadata. */
	const loadDb = useCallback(
		async (dbName: string) => {
			const client = clientRef.current;
			if (!client || !dbName) return;
			const gen = generation.current;

			try {
				const db = client.db(dbName);
				// As duas chamadas são de metadata e independentes entre si — em
				// paralelo o resumo aparece junto com a lista, não depois dela.
				const [overview, summary] = await Promise.all([
					inspectDb(db),
					dbSummary(db),
				]);
				apply(gen, {
					overview,
					summary,
					currentDb: dbName,
					estimates: [],
					indexes: [],
				});
			} catch (err) {
				apply(gen, {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[apply],
	);

	/**
	 * Estimativas e índices — o que fica atrás do toggle "show estimatives".
	 * Só roda quando o usuário pede, porque num banco com centenas de
	 * collections são centenas de comandos.
	 */
	const loadStats = useCallback(
		async (
			dbName: string,
			names: string[],
			opts: { estimates: boolean; indexes: boolean },
		) => {
			const client = clientRef.current;
			if (!client || !dbName || names.length === 0) return;
			const gen = generation.current;

			apply(gen, { loadingStats: true });
			try {
				const db = client.db(dbName);
				const [estimates, indexes] = await Promise.all([
					opts.estimates ? estimateMany(db, names) : Promise.resolve([]),
					opts.indexes ? indexSummaryMany(db, names) : Promise.resolve([]),
				]);
				apply(gen, {
					loadingStats: false,
					...(opts.estimates ? { estimates } : {}),
					...(opts.indexes ? { indexes } : {}),
				});
			} catch (err) {
				apply(gen, {
					loadingStats: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[apply],
	);

	/** Contagem exata de UMA collection, sob demanda (tecla `c` na lista). */
	const exactCount = useCallback(async (dbName: string, name: string) => {
		const client = clientRef.current;
		if (!client) return;
		const gen = generation.current;

		try {
			const docs = await countExact(client.db(dbName), name);
			if (!mounted.current || gen !== generation.current) return;
			setState((prev) => ({
				...prev,
				estimates: upsertEstimate(prev.estimates, name, docs),
			}));
		} catch {
			// Contagem exata é um extra: falhar não pode derrubar a tela.
		}
	}, []);

	const disconnect = useCallback(async () => {
		generation.current += 1;
		await clientRef.current?.close().catch(() => {});
		clientRef.current = null;
		if (mounted.current) setState(INITIAL);
	}, []);

	return { state, connect, loadDb, loadStats, exactCount, disconnect };
}

function upsertEstimate(
	list: CollEstimate[],
	name: string,
	docs: number,
): CollEstimate[] {
	const idx = list.findIndex((e) => e.name === name);
	if (idx === -1)
		return [
			...list,
			{
				name,
				docs,
				storageSize: 0,
				totalIndexSize: 0,
				indexCount: 0,
				exact: true,
			},
		];
	const next = [...list];
	next[idx] = { ...next[idx], name, docs, exact: true };
	return next;
}
