const fs = require("fs/promises");
const path = require("path");

const SEAGATE_PREFIX = "/Volumes/Seagate/";
const DEFAULT_STORAGE_DIR =
  "/Volumes/Seagate/Coding Projects/nicholas-kerr-aetherstream-server/data";

const storageDir = path.resolve(process.env.STORAGE_DIR || DEFAULT_STORAGE_DIR);
const videosFilePath = path.join(storageDir, "videos.json");
const seedVideosFilePath = path.resolve(__dirname, "..", "data", "videos.json");

const isSeagatePath = (targetPath) =>
  targetPath === "/Volumes/Seagate" || targetPath.startsWith(SEAGATE_PREFIX);

const ensureStorageReady = async () => {
  if (!isSeagatePath(storageDir)) {
    throw new Error(
      `Invalid STORAGE_DIR "${storageDir}". This app is configured to use Seagate storage only.`
    );
  }

  await fs.mkdir(storageDir, { recursive: true });

  try {
    await fs.access(videosFilePath);
  } catch {
    const seedVideos = await fs.readFile(seedVideosFilePath, "utf8");
    await fs.writeFile(videosFilePath, seedVideos);
  }
};

const readVideos = async () => {
  const fileContent = await fs.readFile(videosFilePath, "utf8");
  return JSON.parse(fileContent);
};

const writeVideos = async (videos) => {
  await fs.writeFile(videosFilePath, JSON.stringify(videos, null, 2));
};

module.exports = {
  ensureStorageReady,
  readVideos,
  writeVideos,
  storageDir,
  videosFilePath,
};
