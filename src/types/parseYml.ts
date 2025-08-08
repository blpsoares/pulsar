import { z } from 'zod';

export const dumpYmlSchema = z.object({
  command: z.object({
    dump: z.object({
      source: z.object({
        uri: z.string(),
        db: z.string(),
      }),
      destination: z.object({
        uri: z.string(),
        db: z.string(),
      }),
      collections: z.array(z.string()),
      queryString: z.string().optional(),
    }),
  }),
});

export const watchYmlSchema = z.object({
  command: z.object({
    watch: z.object({
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

export type DumpYmlOptions = z.infer<typeof dumpYmlSchema>;
export type WatchYmlOptions = z.infer<typeof watchYmlSchema>;
