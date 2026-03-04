const express = require("express");
const cors = require("cors");
require("dotenv").config();

const videosRoutes = require("./routes/videos");
const authRoutes = require("./routes/auth");
const { ensureStorageReady, videosFilePath, usersFilePath } = require("./utils/storage");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/videos", videosRoutes);

const startServer = async () => {
  try {
    await ensureStorageReady();

    app.listen(PORT, () => {
      console.log(`Server has started on port ${PORT}`);
      console.log(`Using video storage: ${videosFilePath}`);
      console.log(`Using user storage: ${usersFilePath}`);
    });
  } catch (error) {
    console.error("Failed to initialize storage:", error.message);
    process.exit(1);
  }
};

startServer();
