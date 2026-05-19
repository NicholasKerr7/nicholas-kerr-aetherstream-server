const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
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
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "1mb";
const RATE_LIMIT_WINDOW_MS =
  Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS =
  Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 300;

const parseAllowedOrigins = () => {
  const configuredOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return new Set(configuredOrigins.length ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS);
};

const corsOptions = {
  origin(origin, callback) {
    const allowedOrigins = parseAllowedOrigins();

    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(null, false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
};

app.disable("x-powered-by");
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { message: "Too many requests. Please try again later." },
  })
);
app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.use("/auth", authRoutes);
app.use("/videos", videosRoutes);
app.use("/creators", creatorsRoutes);
app.use("/notifications", notificationsRoutes);

app.use((error, req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ message: "Request body is too large." });
  }

  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({ message: "Request body contains invalid JSON." });
  }

  return next(error);
});

const startServer = async () => {
  try {
    await ensureStorageReady();

    return app.listen(PORT, () => {
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

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
};
