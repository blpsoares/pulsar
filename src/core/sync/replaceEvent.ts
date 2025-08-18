import type { Collection, Document } from "mongodb";
import { customLog } from "../../utils/customLog";

export async function watchReplaceEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	const destCollectionName = destCollection.collectionName;
	if (!rawDocument) {
		customLog(
			"warn",
			`[${destCollectionName}] fullDocument não encontrado. Ignorando.`,
		);
		return;
	}

	await destCollection.replaceOne(
		{
			_id: rawDocument._id,
		},
		rawDocument,
	);
}
