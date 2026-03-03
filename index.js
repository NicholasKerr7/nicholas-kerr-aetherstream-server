const express = require("express");
const cors = require("cors");
require("dotenv").config();

const videosRoutes = require("./routes/videos");
const { ensureStorageReady, videosFilePath } = require("./utils/storage");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use("/videos", videosRoutes);

const startServer = async () => {
  try {
    await ensureStorageReady();

    app.listen(PORT, () => {
      console.log(`Server has started on port ${PORT}`);
      console.log(`Using video storage: ${videosFilePath}`);
    });
  } catch (error) {
    console.error("Failed to initialize storage:", error.message);
    process.exit(1);
  }
};

startServer();
