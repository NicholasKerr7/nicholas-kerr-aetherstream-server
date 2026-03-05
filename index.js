const express = require("express");
const cors = require("cors");
require("dotenv").config();

const videosRoutes = require("./routes/videos");
const authRoutes = require("./routes/auth");
const creatorsRoutes = require("./routes/creators");
const notificationsRoutes = require("./routes/notifications");
const {
  ensureStorageReady,
  videosFilePath,
  usersFilePath,
  commentLikesFilePath,
  watchProgressFilePath,
  creatorFollowsFilePath,
  notificationsFilePath,
} = require("./utils/storage");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/videos", videosRoutes);
app.use("/creators", creatorsRoutes);
app.use("/notifications", notificationsRoutes);

const startServer = async () => {
  try {
    await ensureStorageReady();

    app.listen(PORT, () => {
      console.log(`Server has started on port ${PORT}`);
      console.log(`Using video storage: ${videosFilePath}`);
      console.log(`Using user storage: ${usersFilePath}`);
      console.log(`Using comment-like storage: ${commentLikesFilePath}`);
      console.log(`Using watch-progress storage: ${watchProgressFilePath}`);
      console.log(`Using creator-follow storage: ${creatorFollowsFilePath}`);
      console.log(`Using notifications storage: ${notificationsFilePath}`);
    });
  } catch (error) {
    console.error("Failed to initialize storage:", error.message);
    process.exit(1);
  }
};

startServer();
