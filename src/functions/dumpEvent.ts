import { MongoServerError, type Collection, type Document } from "mongodb";
import { errorHandler } from "../errors/errorHandler";
import { customLog } from "../utils/customLog";
import { EventEmitter } from "node:events";
import { addFieldsOnMongoDocument } from "../utils/mongoToolsReturn";

export const dumpEvent = new EventEmitter();

dumpEvent.on("dump", dumpCollections);
dumpEvent.on("finish", (coll: string) =>
	customLog("success", `Collection [ ${coll} ] dumpada para o destino.`, true),
);
dumpEvent.on("error", (err: Error | unknown, coll: string) => {
	throw errorHandler(err, `DUMP:${coll}`);
});

async function dumpCollections(
	sourceCollection: Collection,
	destCollection: Collection,
) {
	const collectionName = destCollection.namespace.split(".")[1];
	try {
		const cursor = sourceCollection.find().sort({ _id: 1 });
		for await (const coldDocument of cursor) {
			const newDocument = addFieldsOnMongoDocument(coldDocument, "dump");
			await insertOrUpdateDocument(coldDocument, newDocument, destCollection);
		}
		dumpEvent.emit("finish", collectionName);
	} catch (error) {
		dumpEvent.emit("error", error, collectionName);
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
				`O Documento: ${coldDocument._id.toString()} ja existe no destino e foi atualizado pelo watch durante o dump.`,
			);
		} else {
			throw err;
		}
	}
}
