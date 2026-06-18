import type { Collection } from "mongodb";

/**
 * "Descongela" as marcas `__sync.hot` remanescentes de execuções anteriores.
 *
 * Por quê: `__sync.hot: true` significa "o change stream ao vivo escreveu a
 * versão mais fresca deste doc — o dump não deve sobrescrever". Esse flag só é
 * válido DENTRO de uma execução. Entre runs (restart) ele fica velho e, se o
 * doc mudou na origem com o watch desligado, o dump veria `hot === true` e
 * pularia — deixando o destino desatualizado.
 *
 * Limpar o flag no início (antes do change stream abrir) faz o dump re-avaliar
 * esses docs por hash: muda na origem → atualiza; igual → pula sem escrever.
 * Não há risco de sobrescrita porque a origem é sempre a fonte da verdade; a
 * proteção da corrida dentro da run continua, pois o stream re-marca `hot`.
 *
 */
export async function freezeCollection(collection: Collection) {
	await collection.updateMany(
		{ "__sync.hot": true },
		{ $unset: { "__sync.hot": "" } },
	);
}
