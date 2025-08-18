// biome-ignore assist/source/organizeImports: <explanation>
import { MongoServerError, type Collection, type Document } from "mongodb";
import { customLog } from "../../utils/customLog";
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
	try {
		const result = await destCollection.updateOne(
			{
				_id: coldDocument._id,
				hot: { $exists: false },
			},
			{ $set: newDocument },
		);
		if (result.matchedCount === 0) await destCollection.insertOne(newDocument);
	} catch (err) {
		if (err instanceof MongoServerError && err.code === 11000) {
			customLog(
				"warn",
				`O Documento: ${coldDocument._id.toString()} ja existe no destino e foi atualizado pelo watch durante o migrate`,
			);
		} else {
			throw err;
		}
	}
}
