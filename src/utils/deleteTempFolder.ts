import fs from "node:fs";

export const deleteTempFolder = (pathTempFolder: string) => {
	fs.rmdirSync(pathTempFolder, { recursive: true });
};
