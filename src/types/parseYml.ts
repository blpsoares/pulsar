import { z } from "zod";

export const migrateYmlSchema = z.object({
	command: z.object({
		migrate: z.object({
			source: z.object({
				uri: z.string(),
				db: z.string(),
			}),
			destination: z.object({
				uri: z.string(),
				db: z.string(),
			}),
			collections: z.array(z.string()).optional(),
			queryString: z.string().optional(),
		}),
	}),
});

const syncCollectionEntrySchema = z.union([
	z.string(),
	z
		.object({
			name: z.string(),
			filter: z.record(z.unknown()).optional(),
			filterFile: z.string().optional(),
		})
		.refine((d) => !(d.filter && d.filterFile), {
			message: 'Use "filter" or "filterFile", not both',
		}),
]);

/** Índices escolhidos de UMA collection: `{ collection, indexes: [nomes] }`. */
const collectionIndexesSchema = z.object({
	collection: z.string(),
	indexes: z.array(z.string()),
});

export const syncYmlSchema = z.object({
	command: z.object({
		sync: z.object({
			source: z.object({
				uri: z.string(),
				db: z.string(),
			}),
			destination: z.object({
				uri: z.string(),
				db: z.string(),
			}),
			collections: z.array(syncCollectionEntrySchema).optional(),
			// Recria os índices secundários da origem no destino: `true` = todos;
			// lista = só os nomeados, por collection; omitido/false = nenhum.
			// A forma de OBJETO (e não "coll.indice") é proposital: tanto nome de
			// collection quanto nome de índice aceitam ponto, e um separador
			// ambíguo transformaria "vendas.2024" num par indecifrável.
			copyIndexes: z
				.union([z.boolean(), z.array(collectionIndexesSchema)])
				.optional(),
			// Recria as views da origem no destino (metadados, fora do sync):
			// `true` = todas; array de nomes = só essas; omitido = nenhuma.
			copyViews: z.union([z.boolean(), z.array(z.string())]).optional(),
			logging: z
				.object({
					verbose: z.boolean().optional(),
					progress: z.boolean().optional(),
					lang: z.enum(["en", "pt"]).optional(),
				})
				.optional(),
			performance: z
				.object({
					// quantas collections fazem o dump inicial em paralelo
					parallel: z.number().int().positive().optional(),
					// tamanho do lote (find $in + bulkWrite) no dump
					batchSize: z.number().int().positive().optional(),
					// intervalo de flush do changeBuffer (ms); default 1000
					flushIntervalMs: z.number().int().positive().optional(),
				})
				.optional(),
		}),
	}),
});

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
			performance: z
				.object({
					// quantas collections recebem TTL em paralelo
					parallel: z.number().int().positive().optional(),
				})
				.optional(),
		}),
	}),
});

export type SyncCollectionEntry = z.infer<typeof syncCollectionEntrySchema>;
export type CollectionIndexes = z.infer<typeof collectionIndexesSchema>;
/** `true` = todos os índices; lista = só os nomeados; false/omitido = nenhum. */
export type CopyIndexesOption = boolean | CollectionIndexes[];
export type MigrateYmlOptions = z.infer<typeof migrateYmlSchema>;
export type SyncYmlOptions = z.infer<typeof syncYmlSchema>;
export type TtlCollectionEntry = z.infer<typeof ttlCollectionEntrySchema>;
export type TtlDefaults = z.infer<typeof ttlDefaultsSchema>;
export type TtlYmlOptions = z.infer<typeof ttlYmlSchema>;
