// src/utils/idKey.ts
import { BSON } from "mongodb";

/**
 * Chave canônica de um `_id` para uso em `Set`/`Map` em memória.
 *
 * POR QUE ISTO EXISTE (bug de perda silenciosa de dados):
 * `String(id)` / `id.toString()` COLIDEM. Todo `_id` não-escalar vira
 * `"[object Object]"`, então TODOS os docs de `_id` composto de uma collection
 * viram a MESMA chave. Isso já causou:
 *   - dump: um único delete durante o dump inicial descartava o resto do dump
 *     inteiro (`deletedIds.includes(d._id.toString())` casava com tudo), e o
 *     dump ainda assim era carimbado como concluído;
 *   - watch: o buffer de mudanças colapsava todos os ids compostos numa entrada,
 *     aplicando 1 doc por collection por flush;
 *   - flush: doc presente na origem era classificado como ausente e DELETADO no
 *     destino.
 * `String(id)` também confunde tipos escalares distintos: o número `5` e a
 * string `"5"` viram ambos `"5"`.
 *
 * A codificação BSON resolve os dois casos de uma vez: ela carrega o TIPO junto
 * do valor e preserva a ORDEM das chaves de um documento — que é exatamente a
 * semântica de igualdade de `_id` do Mongo (`{a:1,b:2}` e `{b:2,a:1}` são `_id`
 * DIFERENTES).
 *
 * Nota: inteiro e int64 do mesmo valor geram bytes diferentes. Dentro de um run
 * isso não separa nada, porque os dois lados comparados (evento do change stream
 * e doc da origem) são decodificados pelo mesmo driver, com as mesmas opções.
 */
export function idKey(id: unknown): string {
	// BSON.serialize é tipado como Uint8Array (cujo toString não aceita encoding),
	// então o Buffer.from é necessário — não é decorativo.
	return Buffer.from(BSON.serialize({ _id: id })).toString("base64");
}

/** Set de chaves canônicas a partir de uma lista de `_id`s. */
export function idKeySet(ids: Iterable<unknown>): Set<string> {
	const s = new Set<string>();
	for (const id of ids) s.add(idKey(id));
	return s;
}
