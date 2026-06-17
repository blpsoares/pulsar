// biome-ignore assist/source/organizeImports: <explanation>
import type { Collection, Document } from "mongodb";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { customLog, logger } from "../../utils/customLog";
import { getLogConfig } from "../../utils/logConfig";
import { createBar, removeBar } from "../../utils/progressManager";
import { watcher } from "./watcherEvents";

type DumpResult = "skipped" | "updated" | "inserted";

export async function dumpCollections(
	sourceCollection: Collection,
	destCollection: Collection,
	deletedIds: string[],
	filter?: Document,
) {
	const { collectionName } = destCollection;
	const { progress } = getLogConfig();

	try {
		const total = await sourceCollection.countDocuments(filter ?? {});
		const stats = { skipped: 0, updated: 0, inserted: 0 };

		const bar = progress ? createBar(collectionName, total) : null;

		const cursor = sourceCollection.find(filter ?? {}).sort({ _id: -1 });

		for await (const coldDocument of cursor) {
			if (deletedIds.includes(coldDocument._id.toString())) continue;

			const newDocument = addFieldsOnMongoDocument(coldDocument, "dump", false);
			const result = await insertOrUpdateDocument(coldDocument, newDocument, destCollection);

			stats[result === "skipped" ? "skipped" : result === "updated" ? "updated" : "inserted"]++;
			bar?.increment(1, { skip: stats.skipped, upd: stats.updated, ins: stats.inserted });
		}

		watcher.emit("finishDump", collectionName, total, stats);
		if (bar) removeBar(bar);
	} catch (error) {
		watcher.emit("errorDump", error, collectionName);
	}
}

async function insertOrUpdateDocument(
	coldDocument: Document,
	newDocument: Document,
	destCollection: Collection,
): Promise<DumpResult> {
	const sourceHash = newDocument.__sync?.hash;

	const destDoc = await destCollection.findOne(
		{ _id: coldDocument._id },
		{ projection: { "__sync.hot": 1, "__sync.hash": 1 } },
	);

	if (destDoc === null) {
		await destCollection.insertOne(newDocument);
		return "inserted";
	}

	if (destDoc.__sync?.hot === true || destDoc.__sync?.hash === sourceHash) {
		return "skipped";
	}

	await destCollection.updateOne({ _id: coldDocument._id }, { $set: newDocument });
	return "updated";
}

