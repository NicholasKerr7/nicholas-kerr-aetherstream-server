const express = require("express");
const app = express();
const cors = require("cors");
const PORT = process.env.PORT || 8080;
require("dotenv").config();
const videos = require("./routes/videos");

app.use(cors());
app.use(express.json());
app.use("/videos", videos);

app.listen(PORT, () => {
  console.log("Server has started on port " + PORT);
});
