import { MongoClient } from "mongodb";

/**
 * Conexão de SONDAGEM, usada só pela TUI enquanto o usuário preenche o form.
 *
 * De propósito NÃO reusa `db/conn.ts`: aquele caminho é o do daemon 24/7 e
 * retenta erro transitório até 60 vezes com backoff (o que é certo para um
 * sync que não pode morrer às 3h da manhã, e errado aqui). Numa TUI, um erro
 * de digitação na URI tem que voltar em segundos para o usuário corrigir, não
 * prender a tela por minutos.
 *
 * Por isso: timeout curto, uma tentativa, pool mínimo.
 */

export const PROBE_TIMEOUT_MS = 8000;

/** Banco visível na sondagem, com o tamanho que o servidor já informa. */
export type DatabaseInfo = { name: string; sizeOnDisk: number };

export type ProbeResult =
	| { ok: true; client: MongoClient; databases: DatabaseInfo[] }
	| { ok: false; error: string };

/**
 * `timeoutMs` é parâmetro (e não constante fixa) porque os testes precisam
 * falhar rápido, enquanto a TUI dá 8s — tempo de um Atlas distante responder
 * sem parecer que travou.
 */
export async function probeConnection(
	uri: string,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
	const clean = uri.trim().replace(/\/+$/, "");
	if (!clean) return { ok: false, error: "URI vazia" };

	let client: MongoClient | undefined;
	try {
		client = new MongoClient(clean, {
			serverSelectionTimeoutMS: timeoutMs,
			connectTimeoutMS: timeoutMs,
			// A sondagem é leve: listar bancos e ler metadata. Um pool grande aqui
			// só tomaria conexões do cluster à toa.
			maxPoolSize: 4,
		});
		await client.connect();

		return { ok: true, client, databases: await listDatabases(client) };
	} catch (err) {
		await client?.close().catch(() => {});
		return { ok: false, error: humanizeConnError(err) };
	}
}

/**
 * Listar bancos exige permissão de cluster; usuários de aplicação costumam ter
 * acesso a um banco só. Falhar aqui é normal — devolvemos lista vazia e a TUI
 * pede o nome do banco digitado.
 */
async function listDatabases(client: MongoClient): Promise<DatabaseInfo[]> {
	try {
		const { databases } = await client.db().admin().listDatabases();
		return databases
			.filter((d) => !["admin", "local", "config"].includes(String(d.name)))
			.map((d) => ({
				name: String(d.name),
				sizeOnDisk: Number(d.sizeOnDisk ?? 0),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

/**
 * Mensagem do driver -> frase acionável. O texto cru do Mongo ("MongoServerSelectionError:
 * connect ECONNREFUSED 127.0.0.1:27017") não diz ao usuário o que fazer.
 */
export function humanizeConnError(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);

	if (/Authentication failed|bad auth/i.test(msg))
		return "Autenticação falhou — confira usuário e senha na URI.";
	if (/ECONNREFUSED/i.test(msg))
		return "Conexão recusada — o servidor está no ar e a porta está certa?";
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg))
		return "Host não encontrado — confira o endereço na URI.";
	if (/Server selection timed out|timed out/i.test(msg))
		return "Tempo esgotado — servidor inacessível (IP liberado no Atlas?).";
	if (/Invalid scheme|Invalid connection string|MongoParseError/i.test(msg))
		return "URI inválida — deve começar com mongodb:// ou mongodb+srv://";
	if (/not authorized/i.test(msg))
		return "Sem permissão para esta operação com o usuário informado.";

	return msg;
}
