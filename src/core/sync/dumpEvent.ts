// biome-ignore assist/source/organizeImports: <explanation>
import type { Collection, Document } from "mongodb";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { watcher } from "./watcherEvents";

export async function dumpCollections(
	sourceCollection: Collection,
	destCollection: Collection,
	deletedIds: string[],
) {
	const { collectionName } = destCollection;
	try {
		const cursor = sourceCollection.find().sort({ _id: -1 });

		for await (const coldDocument of cursor) {
			if (deletedIds.includes(coldDocument._id.toString())) return;

			const newDocument = addFieldsOnMongoDocument(coldDocument, "dump");
			await insertOrUpdateDocument(coldDocument, newDocument, destCollection);
		}
		watcher.emit("finishDump", collectionName);
	} catch (error) {
		watcher.emit("errorDump", error, collectionName);
	}
}

async function insertOrUpdateDocument(
	coldDocument: Document,
	newDocument: Document,
	destCollection: Collection,
) {
	const sourceHash = newDocument.__sync?.hash;

	const destDoc = await destCollection.findOne(
		{ _id: coldDocument._id },
		{ projection: { "__sync.hot": 1, "__sync.hash": 1 } },
	);

	if (destDoc === null) {
		await destCollection.insertOne(newDocument);
	} else if (destDoc.__sync?.hot === true || destDoc.__sync?.hash === sourceHash) {
		return;
	} else {
		await destCollection.updateOne(
			{ _id: coldDocument._id },
			{ $set: newDocument },
		);
	}
}
