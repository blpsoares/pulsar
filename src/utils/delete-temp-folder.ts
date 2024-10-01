import fs from 'fs';

export const deleteTempFolder = (pathTempFolder: string) => {
  fs.rmdirSync(pathTempFolder, { recursive: true });
};
