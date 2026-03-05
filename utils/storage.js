const fs = require("fs/promises");
const path = require("path");

const SEAGATE_PREFIX = "/Volumes/Seagate/";
const DEFAULT_STORAGE_DIR =
  "/Volumes/Seagate/Coding Projects/nicholas-kerr-aetherstream-server/data";

const storageDir = path.resolve(process.env.STORAGE_DIR || DEFAULT_STORAGE_DIR);
const videosFilePath = path.join(storageDir, "videos.json");
const usersFilePath = path.join(storageDir, "users.json");
const commentLikesFilePath = path.join(storageDir, "comment-likes.json");
const watchProgressFilePath = path.join(storageDir, "watch-progress.json");
const creatorFollowsFilePath = path.join(storageDir, "creator-follows.json");
const seedVideosFilePath = path.resolve(__dirname, "..", "data", "videos.json");
const seedUsersFilePath = path.resolve(__dirname, "..", "data", "users.json");
const seedCommentLikesFilePath = path.resolve(
  __dirname,
  "..",
  "data",
  "comment-likes.json"
);
const seedWatchProgressFilePath = path.resolve(
  __dirname,
  "..",
  "data",
  "watch-progress.json"
);
const seedCreatorFollowsFilePath = path.resolve(
  __dirname,
  "..",
  "data",
  "creator-follows.json"
);

const isSeagatePath = (targetPath) =>
  targetPath === "/Volumes/Seagate" || targetPath.startsWith(SEAGATE_PREFIX);

const ensureSeedFile = async (targetFilePath, seedFilePath, defaultContent) => {
  try {
    await fs.access(targetFilePath);
    return;
  } catch {
    // Target file does not exist yet.
  }

  try {
    const seedContent = await fs.readFile(seedFilePath, "utf8");
    await fs.writeFile(targetFilePath, seedContent);
  } catch {
    await fs.writeFile(targetFilePath, defaultContent);
  }
};

const ensureStorageReady = async () => {
  if (!isSeagatePath(storageDir)) {
    throw new Error(
      `Invalid STORAGE_DIR "${storageDir}". This app is configured to use Seagate storage only.`
    );
  }

  await fs.mkdir(storageDir, { recursive: true });

  await ensureSeedFile(videosFilePath, seedVideosFilePath, "[]");
  await ensureSeedFile(usersFilePath, seedUsersFilePath, "[]");
  await ensureSeedFile(commentLikesFilePath, seedCommentLikesFilePath, "[]");
  await ensureSeedFile(watchProgressFilePath, seedWatchProgressFilePath, "[]");
  await ensureSeedFile(creatorFollowsFilePath, seedCreatorFollowsFilePath, "[]");
};

const readJson = async (filePath) => {
  const fileContent = await fs.readFile(filePath, "utf8");
  return JSON.parse(fileContent);
};

const writeJson = async (filePath, payload) => {
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
};

const readVideos = async () => readJson(videosFilePath);
const writeVideos = async (videos) => writeJson(videosFilePath, videos);

const readUsers = async () => readJson(usersFilePath);
const writeUsers = async (users) => writeJson(usersFilePath, users);

const readCommentLikes = async () => readJson(commentLikesFilePath);
const writeCommentLikes = async (commentLikes) =>
  writeJson(commentLikesFilePath, commentLikes);
const readWatchProgress = async () => readJson(watchProgressFilePath);
const writeWatchProgress = async (watchProgressEntries) =>
  writeJson(watchProgressFilePath, watchProgressEntries);
const readCreatorFollows = async () => readJson(creatorFollowsFilePath);
const writeCreatorFollows = async (creatorFollows) =>
  writeJson(creatorFollowsFilePath, creatorFollows);

module.exports = {
  ensureStorageReady,
  readVideos,
  writeVideos,
  readUsers,
  writeUsers,
  readCommentLikes,
  writeCommentLikes,
  readWatchProgress,
  writeWatchProgress,
  readCreatorFollows,
  writeCreatorFollows,
  storageDir,
  videosFilePath,
  usersFilePath,
  commentLikesFilePath,
  watchProgressFilePath,
  creatorFollowsFilePath,
};
