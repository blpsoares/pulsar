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
			logging: z
				.object({
					verbose: z.boolean().optional(),
					progress: z.boolean().optional(),
				})
				.optional(),
		}),
	}),
});

export type SyncCollectionEntry = z.infer<typeof syncCollectionEntrySchema>;
export type MigrateYmlOptions = z.infer<typeof migrateYmlSchema>;
export type SyncYmlOptions = z.infer<typeof syncYmlSchema>;
