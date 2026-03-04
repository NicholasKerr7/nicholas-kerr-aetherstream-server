const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const multer = require("multer");

const {
  readVideos,
  writeVideos,
  readUsers,
  readCommentLikes,
  writeCommentLikes,
  readWatchProgress,
  writeWatchProgress,
} = require("../utils/storage");
const { requireAuth, JWT_SECRET } = require("../middleware/auth");
const {
  hasCloudinaryConfig,
  uploadVideoFileToCloudinary,
} = require("../utils/mediaStorage");

const router = express.Router();
const DEFAULT_VIDEO_IMAGE = "https://i.imgur.com/l2Xfgpl.jpg";
const DEFAULT_VIDEO_CATEGORY = "General";
const MAX_VIDEO_UPLOAD_BYTES =
  Number(process.env.MAX_VIDEO_UPLOAD_BYTES) || 750 * 1024 * 1024;
const MAX_VIDEO_TAGS = 8;
const MAX_WATCH_HISTORY_ITEMS = 40;
const MAX_CONTINUE_WATCHING_ITEMS = 12;
const COMPLETE_PROGRESS_RATIO = 0.98;
const MIN_CONTINUE_PROGRESS_SECONDS = 1;
const DEFAULT_DISCOVERY_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "been",
  "before",
  "between",
  "could",
  "every",
  "first",
  "from",
  "have",
  "into",
  "just",
  "more",
  "much",
  "over",
  "really",
  "some",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "very",
  "what",
  "with",
  "your",
  "when",
  "where",
  "while",
]);

const CATEGORY_RULES = [
  {
    category: "Adventure",
    keywords: ["travel", "trip", "journey", "vacation", "mountain", "ski", "explore"],
  },
  {
    category: "Action Sports",
    keywords: ["bmx", "bike", "skate", "rampage", "ride", "shred", "sport"],
  },
  {
    category: "Wellness",
    keywords: ["health", "medical", "wellness", "safety", "nutrition", "fitness"],
  },
  {
    category: "Technology",
    keywords: ["code", "software", "tech", "developer", "ai", "cloud"],
  },
  {
    category: "Lifestyle",
    keywords: ["home", "daily", "productivity", "routine", "style", "design"],
  },
];

const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_VIDEO_UPLOAD_BYTES,
  },
  fileFilter: (req, file, callback) => {
    if (file?.mimetype?.startsWith("video/")) {
      callback(null, true);
      return;
    }

    callback(new Error("Only video file uploads are allowed."));
  },
});

const parseVideoUpload = (req, res, next) => {
  uploadVideo.single("video")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      const maxUploadMb = Math.round(MAX_VIDEO_UPLOAD_BYTES / (1024 * 1024));
      res
        .status(413)
        .json({ message: `Video file is too large. Max size is ${maxUploadMb}MB.` });
      return;
    }

    res.status(400).json({ message: error.message || "Invalid video upload payload." });
  });
};

const toPositiveInteger = (value) => {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 0;
  }

  return Math.round(parsedValue);
};

const parseDurationToSeconds = (durationValue) => {
  if (typeof durationValue === "number") {
    return toPositiveInteger(durationValue);
  }

  if (typeof durationValue !== "string") {
    return 0;
  }

  const parts = durationValue
    .split(":")
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part) && part >= 0);

  if (parts.length === 2) {
    return toPositiveInteger(parts[0] * 60 + parts[1]);
  }

  if (parts.length === 3) {
    return toPositiveInteger(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }

  return 0;
};

const computeProgressPercent = (progressSeconds, durationSeconds, completed) => {
  if (completed) {
    return 100;
  }

  if (!durationSeconds) {
    return 0;
  }

  return Math.min(
    100,
    Math.max(0, Math.round((progressSeconds / durationSeconds) * 100))
  );
};

const normalizeWatchProgressPayload = (video, progressPayload = {}) => {
  const rawProgressSeconds = Number(progressPayload.progressSeconds);
  const rawDurationSeconds = Number(progressPayload.durationSeconds);
  const durationFromVideo = parseDurationToSeconds(video?.duration);
  const safeProgressSeconds = Number.isFinite(rawProgressSeconds)
    ? rawProgressSeconds
    : 0;

  const durationSeconds = toPositiveInteger(rawDurationSeconds) || durationFromVideo;
  const clampedProgressSeconds = Math.max(0, Math.round(safeProgressSeconds));
  const boundedProgressSeconds = durationSeconds
    ? Math.min(clampedProgressSeconds, durationSeconds)
    : clampedProgressSeconds;
  const isCompletedFromPayload = Boolean(progressPayload.completed);
  const isCompletedFromProgress =
    durationSeconds > 0 &&
    boundedProgressSeconds >=
      Math.max(1, Math.floor(durationSeconds * COMPLETE_PROGRESS_RATIO));
  const completed = isCompletedFromPayload || isCompletedFromProgress;

  return {
    progressSeconds: completed ? 0 : boundedProgressSeconds,
    durationSeconds,
    completed,
  };
};

const normalizeTag = (tag = "") => {
  const trimmed = String(tag || "").trim().toLowerCase();

  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/\s+/g, " ");
};

const normalizeTags = (tagsValue) => {
  const rawTags = Array.isArray(tagsValue)
    ? tagsValue
    : typeof tagsValue === "string"
      ? tagsValue.split(",")
      : [];

  const uniqueTags = [];

  rawTags.forEach((tag) => {
    const normalized = normalizeTag(tag);

    if (!normalized || uniqueTags.includes(normalized)) {
      return;
    }

    uniqueTags.push(normalized);
  });

  return uniqueTags.slice(0, MAX_VIDEO_TAGS);
};

const titleCase = (value = "") =>
  value
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

const normalizeCategory = (categoryValue = "") => {
  const cleaned = String(categoryValue || "").trim();

  if (!cleaned) {
    return "";
  }

  return titleCase(cleaned.replace(/\s+/g, " "));
};

const inferCategoryFromVideo = (video = {}) => {
  const explicitCategory = normalizeCategory(video.category);

  if (explicitCategory) {
    return explicitCategory;
  }

  const text = `${video.title || ""} ${video.description || ""}`.toLowerCase();

  const matchingRule = CATEGORY_RULES.find((rule) =>
    rule.keywords.some((keyword) => text.includes(keyword))
  );

  return matchingRule?.category || DEFAULT_VIDEO_CATEGORY;
};

const buildAutoTagsFromVideo = (video = {}) => {
  const sourceText = `${video.title || ""} ${video.description || ""}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");

  const tokens = sourceText.split(/\s+/).filter((token) => {
    if (!token || token.length < 4) {
      return false;
    }

    return !DEFAULT_DISCOVERY_STOP_WORDS.has(token);
  });

  const uniqueTokens = [];

  tokens.forEach((token) => {
    if (!uniqueTokens.includes(token)) {
      uniqueTokens.push(token);
    }
  });

  return uniqueTokens.slice(0, MAX_VIDEO_TAGS);
};

const resolveVideoTags = (video = {}) => {
  const explicitTags = normalizeTags(video.tags);

  if (explicitTags.length) {
    return explicitTags;
  }

  return buildAutoTagsFromVideo(video);
};

const serializeVideoSummary = (video) => ({
  id: video.id,
  title: video.title,
  channel: video.channel,
  image: video.image,
  description: video.description || "",
  duration: video.duration || "0:00",
  category: inferCategoryFromVideo(video),
  tags: resolveVideoTags(video),
});

const serializeWatchHistoryEntry = (watchProgressEntry = {}, video) => {
  if (!video) {
    return null;
  }

  const normalizedEntry = normalizeWatchProgressPayload(video, {
    progressSeconds: watchProgressEntry.progressSeconds,
    durationSeconds: watchProgressEntry.durationSeconds,
    completed: watchProgressEntry.completed,
  });

  return {
    id: watchProgressEntry.id,
    userId: watchProgressEntry.userId,
    videoId: watchProgressEntry.videoId,
    progressSeconds: normalizedEntry.progressSeconds,
    durationSeconds: normalizedEntry.durationSeconds,
    progressPercent: computeProgressPercent(
      normalizedEntry.progressSeconds,
      normalizedEntry.durationSeconds,
      normalizedEntry.completed
    ),
    completed: normalizedEntry.completed,
    updatedAt: Number(watchProgressEntry.updatedAt) || Date.now(),
    video: serializeVideoSummary(video),
  };
};

const buildWatchHistoryForUser = (watchProgressEntries, videosData, userId) => {
  const videosById = new Map(videosData.map((video) => [video.id, video]));

  const history = watchProgressEntries
    .filter((entry) => entry.userId === userId)
    .map((entry) => {
      const targetVideo = videosById.get(entry.videoId);
      return serializeWatchHistoryEntry(entry, targetVideo);
    })
    .filter(Boolean)
    .sort((first, second) => second.updatedAt - first.updatedAt)
    .slice(0, MAX_WATCH_HISTORY_ITEMS);

  const continueWatching = history
    .filter(
      (entry) =>
        !entry.completed && entry.progressSeconds >= MIN_CONTINUE_PROGRESS_SECONDS
    )
    .slice(0, MAX_CONTINUE_WATCHING_ITEMS);

  return { history, continueWatching };
};

const buildAvatarLookupByUserId = (users = []) =>
  new Map(
    users
      .map((user) => [user.id, user.avatarUrl?.trim() || ""])
      .filter((entry) => entry[1])
  );

const resolveCommentAvatarUrl = (comment, avatarLookupByUserId) => {
  if (comment.userId && avatarLookupByUserId.has(comment.userId)) {
    return avatarLookupByUserId.get(comment.userId);
  }

  const explicitAvatarUrl = comment.avatarUrl?.trim() || "";

  if (explicitAvatarUrl) {
    return explicitAvatarUrl;
  }

  return "";
};

const getOptionalAuthenticatedUserId = (authorizationHeader, usersData = []) => {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return "";
  }

  const token = authorizationHeader.slice(7).trim();

  if (!token) {
    return "";
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const matchingUser = usersData.find((user) => user.id === payload.sub);
    return matchingUser ? matchingUser.id : "";
  } catch {
    return "";
  }
};

const buildLikedCommentIdSetForUser = (
  commentLikesData = [],
  userId = "",
  videoId = ""
) =>
  new Set(
    commentLikesData
      .filter(
        (commentLike) =>
          commentLike.userId === userId && commentLike.videoId === videoId
      )
      .map((commentLike) => commentLike.commentId)
  );

const serializeComment = (comment, avatarLookupByUserId, likedCommentIds) => ({
  ...comment,
  avatarUrl: resolveCommentAvatarUrl(comment, avatarLookupByUserId),
  likedByCurrentUser: Boolean(likedCommentIds?.has(comment.id)),
});

const serializeVideoWithCommentAvatars = (
  video,
  avatarLookupByUserId,
  likedCommentIds
) => ({
  ...video,
  comments: Array.isArray(video.comments)
    ? video.comments.map((comment) =>
        serializeComment(comment, avatarLookupByUserId, likedCommentIds)
      )
    : [],
});

router.get("/", async (req, res) => {
  try {
    const videosData = await readVideos();

    const allVideos = videosData.map((video) => serializeVideoSummary(video));

    res.json(allVideos);
  } catch (error) {
    res.status(500).json({ message: "Failed to load videos." });
  }
});

router.get("/history", requireAuth, async (req, res) => {
  try {
    const [videosData, watchProgressEntries] = await Promise.all([
      readVideos(),
      readWatchProgress(),
    ]);
    const watchHistory = buildWatchHistoryForUser(
      watchProgressEntries,
      videosData,
      req.user.id
    );

    res.json(watchHistory);
  } catch (error) {
    res.status(500).json({ message: "Failed to load watch history." });
  }
});

router.get("/:videoId", async (req, res) => {
  try {
    const [videosData, usersData, commentLikesData, watchProgressEntries] =
      await Promise.all([
      readVideos(),
      readUsers(),
      readCommentLikes(),
      readWatchProgress(),
    ]);
    const avatarLookupByUserId = buildAvatarLookupByUserId(usersData);
    const requesterUserId = getOptionalAuthenticatedUserId(
      req.headers.authorization || "",
      usersData
    );
    const likedCommentIds = requesterUserId
      ? buildLikedCommentIdSetForUser(
          commentLikesData,
          requesterUserId,
          req.params.videoId
        )
      : new Set();

    const singleVideo = videosData.find(
      (video) => video.id === req.params.videoId
    );

    if (!singleVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    const serializedVideo = serializeVideoWithCommentAvatars(
      singleVideo,
      avatarLookupByUserId,
      likedCommentIds
    );
    const matchingWatchProgress = requesterUserId
      ? watchProgressEntries.find(
          (entry) =>
            entry.userId === requesterUserId && entry.videoId === singleVideo.id
        )
      : null;
    const serializedWatchProgress = matchingWatchProgress
      ? serializeWatchHistoryEntry(matchingWatchProgress, singleVideo)
      : null;

    serializedVideo.category = inferCategoryFromVideo(singleVideo);
    serializedVideo.tags = resolveVideoTags(singleVideo);
    serializedVideo.watchProgressSeconds =
      serializedWatchProgress?.progressSeconds || 0;
    serializedVideo.watchDurationSeconds =
      serializedWatchProgress?.durationSeconds ||
      parseDurationToSeconds(singleVideo.duration);
    serializedVideo.watchCompleted = Boolean(serializedWatchProgress?.completed);
    serializedVideo.watchUpdatedAt = serializedWatchProgress?.updatedAt || 0;

    res.json(serializedVideo);
  } catch (error) {
    res.status(500).json({ message: "Failed to load video details." });
  }
});

router.put("/:videoId/progress", requireAuth, async (req, res) => {
  try {
    const rawProgressSeconds = Number(req.body.progressSeconds);

    if (!Number.isFinite(rawProgressSeconds) || rawProgressSeconds < 0) {
      return res.status(400).json({
        message: "Please provide a valid non-negative progressSeconds value.",
      });
    }

    const [videosData, watchProgressEntries] = await Promise.all([
      readVideos(),
      readWatchProgress(),
    ]);
    const selectedVideo = videosData.find((video) => video.id === req.params.videoId);

    if (!selectedVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    const normalizedWatchProgress = normalizeWatchProgressPayload(selectedVideo, {
      progressSeconds: rawProgressSeconds,
      durationSeconds: req.body.durationSeconds,
      completed: req.body.completed,
    });
    const existingWatchProgressIndex = watchProgressEntries.findIndex(
      (entry) =>
        entry.userId === req.user.id && entry.videoId === req.params.videoId
    );
    const existingWatchProgress =
      existingWatchProgressIndex >= 0
        ? watchProgressEntries[existingWatchProgressIndex]
        : null;
    const nextWatchProgressEntry = {
      id: existingWatchProgress?.id || crypto.randomUUID(),
      userId: req.user.id,
      videoId: req.params.videoId,
      progressSeconds: normalizedWatchProgress.progressSeconds,
      durationSeconds: normalizedWatchProgress.durationSeconds,
      completed: normalizedWatchProgress.completed,
      createdAt: existingWatchProgress?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    if (existingWatchProgressIndex >= 0) {
      watchProgressEntries[existingWatchProgressIndex] = nextWatchProgressEntry;
    } else {
      watchProgressEntries.push(nextWatchProgressEntry);
    }

    await writeWatchProgress(watchProgressEntries);

    res.json(serializeWatchHistoryEntry(nextWatchProgressEntry, selectedVideo));
  } catch (error) {
    res.status(500).json({ message: "Failed to update watch progress." });
  }
});

router.post("/", requireAuth, parseVideoUpload, async (req, res) => {
  try {
    const title = req.body.title?.trim();
    const description = req.body.description?.trim();
    const category = normalizeCategory(req.body.category);
    const tags = normalizeTags(req.body.tags);

    if (!title || !description) {
      return res
        .status(400)
        .json({ message: "Please provide both a title and description." });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Please attach a video file to publish." });
    }

    if (!hasCloudinaryConfig()) {
      return res.status(503).json({
        message:
          "Video upload pipeline is not configured. Add Cloudinary environment variables on the server.",
      });
    }

    const uploadedVideo = await uploadVideoFileToCloudinary(req.file);
    const videosData = await readVideos();

    const newVideo = {
      id: crypto.randomUUID(),
      title,
      channel: req.user.name,
      image: uploadedVideo.thumbnailUrl || DEFAULT_VIDEO_IMAGE,
      description,
      category: category || inferCategoryFromVideo({ title, description }),
      tags: tags.length ? tags : buildAutoTagsFromVideo({ title, description }),
      likes: "0",
      views: "0",
      duration: uploadedVideo.duration || "0:00",
      video: uploadedVideo.videoUrl,
      timestamp: Date.now(),
      comments: [],
    };

    videosData.push(newVideo);
    await writeVideos(videosData);

    res.status(201).json(newVideo);
  } catch (error) {
    console.error("Video upload failed:", error.message);
    res.status(500).json({ message: "Failed to publish video." });
  }
});

router.post("/:videoId/comments", requireAuth, async (req, res) => {
  try {
    const commentText = req.body.comment?.trim();

    if (!commentText) {
      return res
        .status(400)
        .json({ message: "Please provide a comment before posting." });
    }

    const videosData = await readVideos();
    const selectedVideo = videosData.find(
      (video) => video.id === req.params.videoId
    );

    if (!selectedVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    const newComment = {
      id: crypto.randomUUID(),
      name: req.user.name,
      avatarUrl: req.user.avatarUrl || "",
      comment: commentText,
      likes: 0,
      timestamp: Date.now(),
      userId: req.user.id,
    };

    if (!Array.isArray(selectedVideo.comments)) {
      selectedVideo.comments = [];
    }

    selectedVideo.comments.unshift(newComment);
    await writeVideos(videosData);

    const likedCommentIds = new Set();
    res
      .status(201)
      .json(serializeComment(newComment, buildAvatarLookupByUserId([]), likedCommentIds));
  } catch (error) {
    res.status(500).json({ message: "Failed to publish comment." });
  }
});

router.patch("/:videoId/comments/:commentId/like", requireAuth, async (req, res) => {
  try {
    const [videosData, usersData, commentLikesData] = await Promise.all([
      readVideos(),
      readUsers(),
      readCommentLikes(),
    ]);
    const avatarLookupByUserId = buildAvatarLookupByUserId(usersData);
    const selectedVideo = videosData.find(
      (video) => video.id === req.params.videoId
    );

    if (!selectedVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    const selectedComment = selectedVideo.comments?.find(
      (comment) => comment.id === req.params.commentId
    );

    if (!selectedComment) {
      return res.status(404).json({ message: "No comment with that id exists" });
    }

    const likeRecordIndex = commentLikesData.findIndex(
      (commentLike) =>
        commentLike.videoId === req.params.videoId &&
        commentLike.commentId === req.params.commentId &&
        commentLike.userId === req.user.id
    );

    const isLiking = likeRecordIndex < 0;

    if (isLiking) {
      commentLikesData.push({
        id: crypto.randomUUID(),
        videoId: req.params.videoId,
        commentId: req.params.commentId,
        userId: req.user.id,
        createdAt: Date.now(),
      });
    } else {
      commentLikesData.splice(likeRecordIndex, 1);
    }

    const likeDelta = isLiking ? 1 : -1;
    selectedComment.likes = Math.max(0, Number(selectedComment.likes || 0) + likeDelta);
    const likedCommentIds = isLiking ? new Set([req.params.commentId]) : new Set();

    await Promise.all([writeVideos(videosData), writeCommentLikes(commentLikesData)]);

    res.json(serializeComment(selectedComment, avatarLookupByUserId, likedCommentIds));
  } catch (error) {
    res.status(500).json({ message: "Failed to like comment." });
  }
});

router.delete("/:videoId/comments/:commentId", requireAuth, async (req, res) => {
  try {
    const [videosData, usersData, commentLikesData] = await Promise.all([
      readVideos(),
      readUsers(),
      readCommentLikes(),
    ]);
    const avatarLookupByUserId = buildAvatarLookupByUserId(usersData);
    const selectedVideo = videosData.find(
      (video) => video.id === req.params.videoId
    );

    if (!selectedVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    const commentIndex = selectedVideo.comments?.findIndex(
      (comment) => comment.id === req.params.commentId
    );

    if (commentIndex < 0) {
      return res.status(404).json({ message: "No comment with that id exists" });
    }

    const targetComment = selectedVideo.comments[commentIndex];

    if (!targetComment?.userId || targetComment.userId !== req.user.id) {
      return res.status(403).json({ message: "You can only delete your own comments." });
    }

    const [deletedComment] = selectedVideo.comments.splice(commentIndex, 1);
    const remainingCommentLikes = commentLikesData.filter(
      (commentLike) =>
        !(
          commentLike.videoId === req.params.videoId &&
          commentLike.commentId === req.params.commentId
        )
    );
    await Promise.all([writeVideos(videosData), writeCommentLikes(remainingCommentLikes)]);

    res.json(serializeComment(deletedComment, avatarLookupByUserId, new Set()));
  } catch (error) {
    res.status(500).json({ message: "Failed to delete comment." });
  }
});

module.exports = router;
