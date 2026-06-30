import { readFileSync } from "node:fs";
import type { Db, Document } from "mongodb";
import { errorHandler } from "../errors/errorHandler";
import type { SyncCollectionEntry } from "../types/parseYml";
import { t } from "../utils/i18n";

export type CollectionEntry = { name: string; filter?: Document };

function resolveEntry(entry: SyncCollectionEntry): Omit<
	CollectionEntry,
	"filter"
> & {
	filterFile?: string;
	filter?: Document;
} {
	if (typeof entry === "string") return { name: entry };
	return entry;
}

function loadFilter(
	entry: ReturnType<typeof resolveEntry>,
): Document | undefined {
	if (entry.filterFile) {
		try {
			return JSON.parse(readFileSync(entry.filterFile, "utf-8"));
		} catch {
			throw errorHandler(
				new Error(
					t("collections.filterfile_unreadable", {
						filterFile: entry.filterFile,
					}),
				),
			);
		}
	}
	return entry.filter as Document | undefined;
}

export async function getCollections<T extends { all?: boolean }>(
	db: Db,
	cliParams: T,
	ymlPath: string,
	collections?: (string | SyncCollectionEntry)[],
): Promise<CollectionEntry[]> {
	if (cliParams.all) {
		const names = (await db.listCollections().toArray())
			.filter((c) => c.type === "collection" && c.name !== "system.views")
			.map((c) => c.name);
		return names.map((name) => ({ name }));
	}

	if (!collections) {
		throw errorHandler(new Error(t("collections.none_to_watch", { ymlPath })));
	}

	return (collections as SyncCollectionEntry[]).map((raw) => {
		const entry = resolveEntry(raw);
		return { name: entry.name, filter: loadFilter(entry) };
	});
}
