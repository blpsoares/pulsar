import type { Collection } from "mongodb";

export async function freezeCollection(collection: Collection) {
	await collection.updateMany(
		{ hot: { $exists: true } },
		{ $unset: { hot: "" } },
	);
}
