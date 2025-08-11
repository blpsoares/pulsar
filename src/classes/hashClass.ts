import crc32 from "crc/crc32";
import type { Document } from "mongodb";

export class Hash {
	encode(document: Document) {
		return crc32(JSON.stringify(document));
	}
}
