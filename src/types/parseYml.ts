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
			collections: z.array(z.string()).optional(),
		}),
	}),
});

export type MigrateYmlOptions = z.infer<typeof migrateYmlSchema>;
export type SyncYmlOptions = z.infer<typeof syncYmlSchema>;
