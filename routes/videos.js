const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const multer = require("multer");

const {
  readVideos,
  writeVideos,
  readUsers,
  writeUsers,
  readCommentLikes,
  writeCommentLikes,
  readWatchProgress,
  writeWatchProgress,
  readCreatorFollows,
  readNotifications,
  writeNotifications,
} = require("../utils/storage");
const { requireAuth, JWT_SECRET } = require("../middleware/auth");
const {
  hasCloudinaryConfig,
  uploadVideoFileToCloudinary,
} = require("../utils/mediaStorage");
const { parseMetric, resolveVideoCreator } = require("../utils/creators");
const {
  resolveUserNotificationPreferences,
  isNotificationEnabledForType,
} = require("../utils/notificationPreferences");

const router = express.Router();
const DEFAULT_VIDEO_IMAGE = "https://i.imgur.com/l2Xfgpl.jpg";
const DEFAULT_VIDEO_CATEGORY = "General";
const MAX_VIDEO_UPLOAD_BYTES =
  Number(process.env.MAX_VIDEO_UPLOAD_BYTES) || 750 * 1024 * 1024;
const MAX_VIDEO_TAGS = 8;
const MAX_FEED_ITEMS = 80;
const DEFAULT_FEED_ITEMS = 36;
const DEFAULT_FEED_MODE = "for-you";
const FEED_MODES = new Set(["for-you", "following", "trending"]);
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

const formatMetric = (value) =>
  new Intl.NumberFormat("en-US").format(Math.max(0, Number(value) || 0));

const normalizeIdList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
};

const resolveVideoLikeUserIds = (video = {}) =>
  normalizeIdList(video.likedByUserIds);

const resolveSavedVideoIdsForUser = (user = {}) =>
  normalizeIdList(user.savedVideoIds);

const resolveVideoLikesCount = (video = {}) => parseMetric(video.likes);

const isVideoOwnedByUser = (video = {}, userId = "") => {
  if (!userId) {
    return false;
  }

  return resolveVideoCreator(video).creatorId === userId;
};

const serializeVideoSummary = (video) => {
  const creator = resolveVideoCreator(video);

  return {
    id: video.id,
    title: video.title,
    channel: creator.creatorName,
    creatorId: creator.creatorId,
    creatorAvatarUrl: creator.creatorAvatarUrl,
    image: video.image,
    description: video.description || "",
    duration: video.duration || "0:00",
    timestamp: Number(video.timestamp) || 0,
    category: inferCategoryFromVideo(video),
    tags: resolveVideoTags(video),
  };
};

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

const buildFollowedCreatorIdSetForUser = (creatorFollowsData = [], userId = "") =>
  new Set(
    creatorFollowsData
      .filter((creatorFollow) => creatorFollow.userId === userId)
      .map((creatorFollow) => creatorFollow.creatorId)
      .filter(Boolean)
  );

const parseFeedMode = (modeValue = "") => {
  const normalizedMode = String(modeValue || "")
    .trim()
    .toLowerCase();

  if (!normalizedMode || !FEED_MODES.has(normalizedMode)) {
    return DEFAULT_FEED_MODE;
  }

  return normalizedMode;
};

const parseFeedLimit = (limitValue) => {
  const parsedLimit = Number(limitValue);

  if (!Number.isFinite(parsedLimit)) {
    return DEFAULT_FEED_ITEMS;
  }

  return Math.min(MAX_FEED_ITEMS, Math.max(1, Math.round(parsedLimit)));
};

const resolveTimestamp = (timestampValue = 0) => {
  const parsedTimestamp = Number(timestampValue);

  if (!Number.isFinite(parsedTimestamp) || parsedTimestamp <= 0) {
    return 0;
  }

  return parsedTimestamp;
};

const resolveAgeDaysFromTimestamp = (timestampValue = 0) => {
  const resolvedTimestamp = resolveTimestamp(timestampValue);

  if (!resolvedTimestamp) {
    return 365;
  }

  return Math.max(0, (Date.now() - resolvedTimestamp) / (1000 * 60 * 60 * 24));
};

const countStoredComments = (comments = []) => {
  if (!Array.isArray(comments)) {
    return 0;
  }

  const visitedCommentIds = new Set();

  const countCommentWithReplies = (comment = {}) => {
    if (!comment || typeof comment !== "object") {
      return 0;
    }

    const commentId = typeof comment.id === "string" ? comment.id.trim() : "";

    if (commentId) {
      if (visitedCommentIds.has(commentId)) {
        return 0;
      }

      visitedCommentIds.add(commentId);
    }

    const replies = Array.isArray(comment.replies) ? comment.replies : [];

    return (
      1 +
      replies.reduce(
        (replyCount, replyComment) =>
          replyCount + countCommentWithReplies(replyComment),
        0
      )
    );
  };

  return comments.reduce(
    (commentCount, comment) => commentCount + countCommentWithReplies(comment),
    0
  );
};

const scoreTrendingVideo = (video = {}) => {
  const views = parseMetric(video.views);
  const likes = parseMetric(video.likes);
  const comments = countStoredComments(video.comments);
  const ageDays = resolveAgeDaysFromTimestamp(video.timestamp);
  const freshnessBoost = Math.max(0, 30 - ageDays) / 30;
  const momentumBoost = Math.max(0, 10 - ageDays) / 10;

  return (
    Math.log10(views + 1) * 4.2 +
    Math.log10(likes + 1) * 5.1 +
    Math.log10(comments + 1) * 3.6 +
    freshnessBoost * 3.2 +
    momentumBoost * 1.6
  );
};

const serializeManagedVideo = (video) => ({
  ...serializeVideoSummary(video),
  views: video.views || "0",
  likes: formatMetric(resolveVideoLikesCount(video)),
  likesCount: resolveVideoLikesCount(video),
  commentsCount: countStoredComments(video.comments),
  video: video.video || "",
});

const addWeightToMap = (weightMap = new Map(), key = "", weight = 0) => {
  if (!key || !Number.isFinite(weight) || weight <= 0) {
    return;
  }

  weightMap.set(key, (weightMap.get(key) || 0) + weight);
};

const buildDefaultPersonalizationProfile = () => ({
  tagWeights: new Map(),
  categoryWeights: new Map(),
  creatorWeights: new Map(),
  watchedVideoStateById: new Map(),
  followedCreatorIds: new Set(),
  hasSignals: false,
});

const buildPersonalizationProfile = ({
  userId = "",
  videosData = [],
  watchProgressEntries = [],
  creatorFollowsData = [],
} = {}) => {
  if (!userId) {
    return buildDefaultPersonalizationProfile();
  }

  const videosById = new Map(videosData.map((video) => [video.id, video]));
  const watchedVideoStateById = new Map();
  const tagWeights = new Map();
  const categoryWeights = new Map();
  const creatorWeights = new Map();
  const followedCreatorIds = buildFollowedCreatorIdSetForUser(
    creatorFollowsData,
    userId
  );
  const userWatchEntries = watchProgressEntries.filter(
    (watchProgressEntry) => watchProgressEntry.userId === userId
  );

  userWatchEntries.forEach((watchProgressEntry) => {
    const watchedVideo = videosById.get(watchProgressEntry.videoId);

    if (!watchedVideo) {
      return;
    }

    const normalizedWatchState = normalizeWatchProgressPayload(watchedVideo, {
      progressSeconds: watchProgressEntry.progressSeconds,
      durationSeconds: watchProgressEntry.durationSeconds,
      completed: watchProgressEntry.completed,
    });
    const completedBoost = normalizedWatchState.completed ? 1.35 : 1;
    const completionRatio = normalizedWatchState.completed
      ? 1
      : normalizedWatchState.durationSeconds
        ? normalizedWatchState.progressSeconds / normalizedWatchState.durationSeconds
        : 0;
    const engagementWeight = Math.max(0.2, completionRatio) * completedBoost;
    const recencyDays = resolveAgeDaysFromTimestamp(watchProgressEntry.updatedAt);
    const recencyWeight = 0.6 + Math.max(0, 21 - recencyDays) / 21;
    const weightedSignal = engagementWeight * recencyWeight;
    const category = inferCategoryFromVideo(watchedVideo);
    const creator = resolveVideoCreator(watchedVideo);
    const tags = resolveVideoTags(watchedVideo);
    const normalizedTagWeight = weightedSignal / Math.max(1, tags.length);

    watchedVideoStateById.set(watchedVideo.id, normalizedWatchState);

    addWeightToMap(categoryWeights, category, weightedSignal);
    addWeightToMap(creatorWeights, creator.creatorId, weightedSignal * 1.2);

    tags.forEach((tag) => {
      addWeightToMap(tagWeights, tag, normalizedTagWeight);
    });
  });

  followedCreatorIds.forEach((creatorId) => {
    addWeightToMap(creatorWeights, creatorId, 2.5);
  });

  return {
    tagWeights,
    categoryWeights,
    creatorWeights,
    watchedVideoStateById,
    followedCreatorIds,
    hasSignals:
      tagWeights.size > 0 ||
      categoryWeights.size > 0 ||
      creatorWeights.size > 0 ||
      followedCreatorIds.size > 0,
  };
};

const scoreForYouVideo = (feedCandidate = {}, personalizationProfile = {}) => {
  const summary = feedCandidate.summary || {};
  const trendingScore = Number(feedCandidate.trendingScore) || 0;
  const tags = Array.isArray(summary.tags) ? summary.tags : [];
  const category = summary.category || DEFAULT_VIDEO_CATEGORY;
  const creatorId = summary.creatorId || "";
  const tagAffinityTotal = tags.reduce(
    (totalAffinity, tag) =>
      totalAffinity + (personalizationProfile.tagWeights.get(tag) || 0),
    0
  );
  const tagAffinity = tags.length
    ? tagAffinityTotal / Math.min(3, tags.length)
    : 0;
  const categoryAffinity =
    personalizationProfile.categoryWeights.get(category) || 0;
  const creatorAffinity =
    personalizationProfile.creatorWeights.get(creatorId) || 0;
  const isFollowedCreator =
    personalizationProfile.followedCreatorIds.has(creatorId);
  const watchedState = personalizationProfile.watchedVideoStateById.get(summary.id);
  let watchedAdjustment = 0;

  if (watchedState?.completed) {
    watchedAdjustment = -4;
  } else if ((watchedState?.progressSeconds || 0) > 0) {
    watchedAdjustment = 1.6;
  }

  return (
    trendingScore +
    tagAffinity * 2.4 +
    categoryAffinity * 1.5 +
    creatorAffinity * 1.6 +
    (isFollowedCreator ? 3.5 : 0) +
    watchedAdjustment
  );
};

const scoreFollowingVideo = (feedCandidate = {}, personalizationProfile = {}) => {
  const summary = feedCandidate.summary || {};
  const tags = Array.isArray(summary.tags) ? summary.tags : [];
  const tagAffinity = tags.reduce(
    (totalAffinity, tag) =>
      totalAffinity + (personalizationProfile.tagWeights.get(tag) || 0),
    0
  );
  const creatorAffinity =
    personalizationProfile.creatorWeights.get(summary.creatorId) || 0;
  const recencyBoost = Math.max(0, 20 - feedCandidate.ageDays) / 20;

  return (
    feedCandidate.trendingScore +
    recencyBoost * 3.2 +
    tagAffinity * 1.4 +
    creatorAffinity * 0.8
  );
};

const rankFeedVideos = ({
  mode = DEFAULT_FEED_MODE,
  videosData = [],
  personalizationProfile = buildDefaultPersonalizationProfile(),
}) => {
  const feedCandidates = videosData.map((video) => {
    const summary = serializeVideoSummary(video);

    return {
      summary,
      trendingScore: scoreTrendingVideo(video),
      ageDays: resolveAgeDaysFromTimestamp(video.timestamp),
    };
  });

  const scopedFeedCandidates =
    mode === "following"
      ? feedCandidates.filter((candidate) =>
          personalizationProfile.followedCreatorIds.has(candidate.summary.creatorId)
        )
      : feedCandidates;

  return scopedFeedCandidates
    .map((candidate) => {
      if (mode === "following") {
        return {
          ...candidate,
          score: scoreFollowingVideo(candidate, personalizationProfile),
        };
      }

      if (mode === "for-you") {
        return {
          ...candidate,
          score: scoreForYouVideo(candidate, personalizationProfile),
        };
      }

      return {
        ...candidate,
        score: candidate.trendingScore,
      };
    })
    .sort((firstCandidate, secondCandidate) => {
      if (secondCandidate.score !== firstCandidate.score) {
        return secondCandidate.score - firstCandidate.score;
      }

      if (secondCandidate.summary.timestamp !== firstCandidate.summary.timestamp) {
        return secondCandidate.summary.timestamp - firstCandidate.summary.timestamp;
      }

      return firstCandidate.summary.title.localeCompare(secondCandidate.summary.title);
    })
    .map((candidate) => candidate.summary);
};

const truncateNotificationCommentPreview = (commentText = "", maxLength = 90) => {
  const normalizedCommentText = String(commentText || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedCommentText) {
    return "";
  }

  if (normalizedCommentText.length <= maxLength) {
    return normalizedCommentText;
  }

  return `${normalizedCommentText.slice(0, Math.max(0, maxLength - 1))}...`;
};

const resolveRecipientUserIdForVideo = (video = {}, usersData = []) => {
  const videoCreator = resolveVideoCreator(video);

  if (!videoCreator.creatorId) {
    return "";
  }

  const hasMatchingUser = usersData.some((user) => user.id === videoCreator.creatorId);

  return hasMatchingUser ? videoCreator.creatorId : "";
};

const resolveNotificationPreferencesForUser = (usersData = [], userId = "") => {
  const matchingUser = usersData.find((user) => user.id === userId);

  return resolveUserNotificationPreferences(matchingUser);
};

const buildVideoInteractionNotificationMessage = ({
  type = "video_comment",
  actorName = "Someone",
  videoTitle = "",
  commentPreview = "",
}) => {
  const safeVideoTitle = String(videoTitle || "your video");

  if (type === "video_comment_like") {
    return `${actorName} liked a comment on your video "${safeVideoTitle}".`;
  }

  if (commentPreview) {
    return `${actorName} commented on your video "${safeVideoTitle}": "${commentPreview}"`;
  }

  return `${actorName} commented on your video "${safeVideoTitle}".`;
};

const appendVideoInteractionNotification = (
  notificationsData = [],
  {
    recipientUserId = "",
    recipientNotificationPreferences = {},
    actorUser = null,
    type = "video_comment",
    video = null,
    commentId = "",
    commentText = "",
  } = {}
) => {
  const safeNotifications = Array.isArray(notificationsData) ? notificationsData : [];
  const actorUserId = actorUser?.id || "";
  const actorName = actorUser?.name?.trim() || "Someone";

  if (!recipientUserId || !actorUserId || recipientUserId === actorUserId || !video?.id) {
    return safeNotifications;
  }

  if (!isNotificationEnabledForType(recipientNotificationPreferences, type)) {
    return safeNotifications;
  }

  const commentPreview = truncateNotificationCommentPreview(commentText);

  return [
    ...safeNotifications,
    {
      id: crypto.randomUUID(),
      userId: recipientUserId,
      type,
      actorUserId,
      actorName,
      actorAvatarUrl: actorUser?.avatarUrl?.trim() || "",
      videoId: video.id,
      videoTitle: video.title || "",
      commentId,
      commentPreview,
      message: buildVideoInteractionNotificationMessage({
        type,
        actorName,
        videoTitle: video.title || "",
        commentPreview: type === "video_comment" ? commentPreview : "",
      }),
      createdAt: Date.now(),
      readAt: 0,
    },
  ];
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

const normalizeCommentParentId = (parentId = "") =>
  typeof parentId === "string" ? parentId.trim() : "";

const normalizeStoredComments = (comments = []) =>
  Array.isArray(comments)
    ? comments.map((comment) => {
        const { replies, ...rest } = comment || {};

        return {
          ...rest,
          parentId: normalizeCommentParentId(rest.parentId),
        };
      })
    : [];

const findCommentById = (comments = [], commentId = "") =>
  comments.find((comment) => comment.id === commentId);

const collectDescendantCommentIds = (comments = [], parentCommentId = "") => {
  const childCommentIdsByParentId = new Map();

  comments.forEach((comment) => {
    const parentId = normalizeCommentParentId(comment.parentId);

    if (!parentId) {
      return;
    }

    if (!childCommentIdsByParentId.has(parentId)) {
      childCommentIdsByParentId.set(parentId, []);
    }

    childCommentIdsByParentId.get(parentId).push(comment.id);
  });

  const descendantCommentIds = [];
  const pendingParentIds = [parentCommentId];

  while (pendingParentIds.length) {
    const activeParentId = pendingParentIds.pop();
    const directChildCommentIds = childCommentIdsByParentId.get(activeParentId) || [];

    directChildCommentIds.forEach((childCommentId) => {
      descendantCommentIds.push(childCommentId);
      pendingParentIds.push(childCommentId);
    });
  }

  return descendantCommentIds;
};

const buildCommentsByParentId = (comments = []) => {
  const commentsByParentId = new Map([["", []]]);
  const commentIds = new Set(comments.map((comment) => comment.id));

  comments.forEach((comment) => {
    const rawParentId = normalizeCommentParentId(comment.parentId);
    const parentId = rawParentId && commentIds.has(rawParentId) ? rawParentId : "";

    if (!commentsByParentId.has(parentId)) {
      commentsByParentId.set(parentId, []);
    }

    commentsByParentId.get(parentId).push(comment);
  });

  return commentsByParentId;
};

const serializeComment = (comment, avatarLookupByUserId, likedCommentIds) => ({
  ...comment,
  avatarUrl: resolveCommentAvatarUrl(comment, avatarLookupByUserId),
  likedByCurrentUser: Boolean(likedCommentIds?.has(comment.id)),
});

const serializeThreadedComments = (
  comments = [],
  avatarLookupByUserId,
  likedCommentIds,
  parentId = "",
  commentsByParentId = buildCommentsByParentId(comments)
) =>
  (commentsByParentId.get(parentId) || []).map((comment) => ({
    ...serializeComment(comment, avatarLookupByUserId, likedCommentIds),
    replies: serializeThreadedComments(
      comments,
      avatarLookupByUserId,
      likedCommentIds,
      comment.id,
      commentsByParentId
    ),
  }));

const serializeVideoWithCommentAvatars = (
  video,
  avatarLookupByUserId,
  likedCommentIds
) => ({
  ...video,
  comments: serializeThreadedComments(
    normalizeStoredComments(video.comments),
    avatarLookupByUserId,
    likedCommentIds
  ),
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

router.get("/following", requireAuth, async (req, res) => {
  try {
    const [videosData, creatorFollowsData] = await Promise.all([
      readVideos(),
      readCreatorFollows(),
    ]);
    const followedCreatorIds = buildFollowedCreatorIdSetForUser(
      creatorFollowsData,
      req.user.id
    );
    const followingFeed = videosData
      .map((video) => serializeVideoSummary(video))
      .filter((videoSummary) => followedCreatorIds.has(videoSummary.creatorId))
      .sort((first, second) => second.timestamp - first.timestamp);

    res.json({
      videos: followingFeed,
      followedCreatorIds: Array.from(followedCreatorIds),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load following feed." });
  }
});

router.get("/feed", async (req, res) => {
  try {
    const [videosData, usersData, watchProgressEntries, creatorFollowsData] =
      await Promise.all([
        readVideos(),
        readUsers(),
        readWatchProgress(),
        readCreatorFollows(),
      ]);
    const requestedMode = parseFeedMode(req.query.mode);
    const feedLimit = parseFeedLimit(req.query.limit);
    const requesterUserId = getOptionalAuthenticatedUserId(
      req.headers.authorization || "",
      usersData
    );
    const personalizationProfile = requesterUserId
      ? buildPersonalizationProfile({
          userId: requesterUserId,
          videosData,
          watchProgressEntries,
          creatorFollowsData,
        })
      : buildDefaultPersonalizationProfile();
    const effectiveMode =
      requestedMode === "for-you" && !requesterUserId ? "trending" : requestedMode;
    const rankedFeedVideos = rankFeedVideos({
      mode: effectiveMode,
      videosData,
      personalizationProfile,
    }).slice(0, feedLimit);

    res.json({
      mode: effectiveMode,
      requestedMode,
      videos: rankedFeedVideos,
      personalization: {
        isAuthenticated: Boolean(requesterUserId),
        hasSignals: personalizationProfile.hasSignals,
        followedCreatorCount: personalizationProfile.followedCreatorIds.size,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load personalized feed." });
  }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    const videosData = await readVideos();
    const ownedVideos = videosData
      .filter((video) => isVideoOwnedByUser(video, req.user.id))
      .sort(
        (firstVideo, secondVideo) =>
          (Number(secondVideo.timestamp) || 0) -
          (Number(firstVideo.timestamp) || 0)
      )
      .map((video) => serializeManagedVideo(video));

    res.json({ videos: ownedVideos });
  } catch (error) {
    res.status(500).json({ message: "Failed to load your videos." });
  }
});

router.get("/saved", requireAuth, async (req, res) => {
  try {
    const [videosData, usersData] = await Promise.all([readVideos(), readUsers()]);
    const currentUser = usersData.find((user) => user.id === req.user.id);

    if (!currentUser) {
      return res.status(404).json({ message: "User profile not found." });
    }

    const videosById = new Map(videosData.map((video) => [video.id, video]));
    const savedVideos = resolveSavedVideoIdsForUser(currentUser)
      .map((savedVideoId) => videosById.get(savedVideoId))
      .filter(Boolean)
      .map((video) => serializeVideoSummary(video));

    res.json({ videos: savedVideos });
  } catch (error) {
    res.status(500).json({ message: "Failed to load saved videos." });
  }
});

router.patch("/:videoId", requireAuth, async (req, res) => {
  try {
    const videosData = await readVideos();
    const selectedVideo = videosData.find((video) => video.id === req.params.videoId);

    if (!selectedVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    if (!isVideoOwnedByUser(selectedVideo, req.user.id)) {
      return res.status(403).json({ message: "You can only edit your own videos." });
    }

    const title = req.body.title?.trim();
    const description = req.body.description?.trim();
    const category = normalizeCategory(req.body.category);
    const tags = normalizeTags(req.body.tags);

    if (!title || !description) {
      return res
        .status(400)
        .json({ message: "Please provide both a title and description." });
    }

    selectedVideo.title = title;
    selectedVideo.description = description;
    selectedVideo.category =
      category || inferCategoryFromVideo({ ...selectedVideo, title, description });
    selectedVideo.tags = tags.length
      ? tags
      : buildAutoTagsFromVideo({ ...selectedVideo, title, description });

    await writeVideos(videosData);

    res.json(serializeManagedVideo(selectedVideo));
  } catch (error) {
    res.status(500).json({ message: "Failed to update video details." });
  }
});

router.delete("/:videoId", requireAuth, async (req, res) => {
  try {
    const [
      videosData,
      usersData,
      commentLikesData,
      watchProgressEntries,
      notificationsData,
    ] = await Promise.all([
      readVideos(),
      readUsers(),
      readCommentLikes(),
      readWatchProgress(),
      readNotifications(),
    ]);
    const selectedVideo = videosData.find((video) => video.id === req.params.videoId);

    if (!selectedVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    if (!isVideoOwnedByUser(selectedVideo, req.user.id)) {
      return res
        .status(403)
        .json({ message: "You can only delete your own videos." });
    }

    const nextVideosData = videosData.filter(
      (video) => video.id !== selectedVideo.id
    );
    const nextUsersData = usersData.map((user) => {
      const nextSavedVideoIds = resolveSavedVideoIdsForUser(user).filter(
        (savedVideoId) => savedVideoId !== selectedVideo.id
      );

      if (!Array.isArray(user.savedVideoIds)) {
        return user;
      }

      if (!nextSavedVideoIds.length) {
        const { savedVideoIds, ...restUser } = user;
        return restUser;
      }

      return {
        ...user,
        savedVideoIds: nextSavedVideoIds,
      };
    });
    const nextCommentLikesData = commentLikesData.filter(
      (commentLike) => commentLike.videoId !== selectedVideo.id
    );
    const nextWatchProgressEntries = watchProgressEntries.filter(
      (watchProgressEntry) => watchProgressEntry.videoId !== selectedVideo.id
    );
    const nextNotificationsData = notificationsData.filter(
      (notification) => notification.videoId !== selectedVideo.id
    );

    await Promise.all([
      writeVideos(nextVideosData),
      writeUsers(nextUsersData),
      writeCommentLikes(nextCommentLikesData),
      writeWatchProgress(nextWatchProgressEntries),
      writeNotifications(nextNotificationsData),
    ]);

    res.json({ videoId: selectedVideo.id, deleted: true });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete video." });
  }
});

router.get("/:videoId", async (req, res) => {
  try {
    const [
      videosData,
      usersData,
      commentLikesData,
      watchProgressEntries,
      creatorFollowsData,
    ] =
      await Promise.all([
        readVideos(),
        readUsers(),
        readCommentLikes(),
        readWatchProgress(),
        readCreatorFollows(),
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
    const creator = resolveVideoCreator(singleVideo);
    const currentUser = requesterUserId
      ? usersData.find((user) => user.id === requesterUserId)
      : null;
    const videoLikeUserIds = resolveVideoLikeUserIds(singleVideo);
    const videoLikesCount = resolveVideoLikesCount(singleVideo);

    serializedVideo.channel = creator.creatorName;
    serializedVideo.creatorId = creator.creatorId;
    serializedVideo.creatorAvatarUrl = creator.creatorAvatarUrl;
    const creatorFollowerUserIds = new Set(
      creatorFollowsData
        .filter((creatorFollow) => creatorFollow.creatorId === creator.creatorId)
        .map((creatorFollow) => creatorFollow.userId)
        .filter(Boolean)
    );

    serializedVideo.creatorFollowersCount = creatorFollowerUserIds.size;
    serializedVideo.isCreatorFollowedByCurrentUser = requesterUserId
      ? creatorFollowerUserIds.has(requesterUserId)
      : false;
    serializedVideo.category = inferCategoryFromVideo(singleVideo);
    serializedVideo.tags = resolveVideoTags(singleVideo);
    serializedVideo.likes = formatMetric(videoLikesCount);
    serializedVideo.likesCount = videoLikesCount;
    serializedVideo.isLikedByCurrentUser = requesterUserId
      ? videoLikeUserIds.includes(requesterUserId)
      : false;
    serializedVideo.isSavedByCurrentUser = currentUser
      ? resolveSavedVideoIdsForUser(currentUser).includes(singleVideo.id)
      : false;
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

router.patch("/:videoId/like", requireAuth, async (req, res) => {
  try {
    const videosData = await readVideos();
    const selectedVideo = videosData.find((video) => video.id === req.params.videoId);

    if (!selectedVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    const currentLikeUserIds = resolveVideoLikeUserIds(selectedVideo);
    const isCurrentlyLiked = currentLikeUserIds.includes(req.user.id);
    const shouldLike =
      typeof req.body.liked === "boolean" ? req.body.liked : !isCurrentlyLiked;
    const nextLikeUserIds = shouldLike
      ? Array.from(new Set([...currentLikeUserIds, req.user.id]))
      : currentLikeUserIds.filter((userId) => userId !== req.user.id);
    const likeDelta =
      shouldLike === isCurrentlyLiked ? 0 : shouldLike ? 1 : -1;
    const nextLikesCount = Math.max(
      0,
      resolveVideoLikesCount(selectedVideo) + likeDelta
    );

    if (nextLikeUserIds.length) {
      selectedVideo.likedByUserIds = nextLikeUserIds;
    } else {
      delete selectedVideo.likedByUserIds;
    }

    selectedVideo.likes = formatMetric(nextLikesCount);
    await writeVideos(videosData);

    res.json({
      videoId: selectedVideo.id,
      liked: shouldLike,
      likes: selectedVideo.likes,
      likesCount: nextLikesCount,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update video like." });
  }
});

router.patch("/:videoId/save", requireAuth, async (req, res) => {
  try {
    const [videosData, usersData] = await Promise.all([readVideos(), readUsers()]);
    const selectedVideo = videosData.find((video) => video.id === req.params.videoId);
    const currentUser = usersData.find((user) => user.id === req.user.id);

    if (!selectedVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    if (!currentUser) {
      return res.status(404).json({ message: "User profile not found." });
    }

    const currentSavedVideoIds = resolveSavedVideoIdsForUser(currentUser);
    const isCurrentlySaved = currentSavedVideoIds.includes(selectedVideo.id);
    const shouldSave =
      typeof req.body.saved === "boolean" ? req.body.saved : !isCurrentlySaved;
    const nextSavedVideoIds = shouldSave
      ? Array.from(new Set([...currentSavedVideoIds, selectedVideo.id]))
      : currentSavedVideoIds.filter((videoId) => videoId !== selectedVideo.id);

    if (nextSavedVideoIds.length) {
      currentUser.savedVideoIds = nextSavedVideoIds;
    } else {
      delete currentUser.savedVideoIds;
    }

    await writeUsers(usersData);

    const savedCount = usersData.filter((user) =>
      resolveSavedVideoIdsForUser(user).includes(selectedVideo.id)
    ).length;

    res.json({
      videoId: selectedVideo.id,
      saved: shouldSave,
      savedCount,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update saved video." });
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
      creatorId: req.user.id,
      creatorAvatarUrl: req.user.avatarUrl || "",
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
    const parentCommentId = normalizeCommentParentId(req.body.parentId);

    if (!commentText) {
      return res
        .status(400)
        .json({ message: "Please provide a comment before posting." });
    }

    const [videosData, usersData, notificationsData] = await Promise.all([
      readVideos(),
      readUsers(),
      readNotifications(),
    ]);
    const selectedVideo = videosData.find(
      (video) => video.id === req.params.videoId
    );

    if (!selectedVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    selectedVideo.comments = normalizeStoredComments(selectedVideo.comments);

    if (parentCommentId && !findCommentById(selectedVideo.comments, parentCommentId)) {
      return res
        .status(404)
        .json({ message: "No parent comment with that id exists" });
    }

    const newComment = {
      id: crypto.randomUUID(),
      name: req.user.name,
      avatarUrl: req.user.avatarUrl || "",
      comment: commentText,
      likes: 0,
      timestamp: Date.now(),
      userId: req.user.id,
      parentId: parentCommentId,
    };

    if (parentCommentId) {
      selectedVideo.comments.push(newComment);
    } else {
      selectedVideo.comments.unshift(newComment);
    }

    const notificationRecipientUserId = resolveRecipientUserIdForVideo(
      selectedVideo,
      usersData
    );
    const notificationRecipientPreferences = resolveNotificationPreferencesForUser(
      usersData,
      notificationRecipientUserId
    );
    const nextNotifications = appendVideoInteractionNotification(
      notificationsData,
      {
        recipientUserId: notificationRecipientUserId,
        recipientNotificationPreferences: notificationRecipientPreferences,
        actorUser: req.user,
        type: "video_comment",
        video: selectedVideo,
        commentId: newComment.id,
        commentText: newComment.comment,
      }
    );
    const shouldWriteNotifications =
      nextNotifications.length !== notificationsData.length;
    const pendingWrites = [writeVideos(videosData)];

    if (shouldWriteNotifications) {
      pendingWrites.push(writeNotifications(nextNotifications));
    }

    await Promise.all(pendingWrites);

    const likedCommentIds = new Set();
    const serializedComment = serializeComment(
      newComment,
      buildAvatarLookupByUserId([]),
      likedCommentIds
    );

    serializedComment.replies = [];

    res
      .status(201)
      .json(serializedComment);
  } catch (error) {
    res.status(500).json({ message: "Failed to publish comment." });
  }
});

router.patch("/:videoId/comments/:commentId/like", requireAuth, async (req, res) => {
  try {
    const [videosData, usersData, commentLikesData, notificationsData] =
      await Promise.all([
      readVideos(),
      readUsers(),
      readCommentLikes(),
      readNotifications(),
    ]);
    const avatarLookupByUserId = buildAvatarLookupByUserId(usersData);
    const selectedVideo = videosData.find(
      (video) => video.id === req.params.videoId
    );

    if (!selectedVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    selectedVideo.comments = normalizeStoredComments(selectedVideo.comments);
    const selectedComment = findCommentById(
      selectedVideo.comments,
      req.params.commentId
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
    const notificationRecipientUserId = resolveRecipientUserIdForVideo(
      selectedVideo,
      usersData
    );
    const notificationRecipientPreferences = resolveNotificationPreferencesForUser(
      usersData,
      notificationRecipientUserId
    );
    const nextNotifications =
      isLiking && notificationRecipientUserId
        ? appendVideoInteractionNotification(notificationsData, {
            recipientUserId: notificationRecipientUserId,
            recipientNotificationPreferences: notificationRecipientPreferences,
            actorUser: req.user,
            type: "video_comment_like",
            video: selectedVideo,
            commentId: selectedComment.id,
            commentText: selectedComment.comment,
          })
        : notificationsData;
    const shouldWriteNotifications =
      nextNotifications.length !== notificationsData.length;
    const pendingWrites = [writeVideos(videosData), writeCommentLikes(commentLikesData)];

    if (shouldWriteNotifications) {
      pendingWrites.push(writeNotifications(nextNotifications));
    }

    await Promise.all(pendingWrites);

    const serializedComment = serializeComment(
      selectedComment,
      avatarLookupByUserId,
      likedCommentIds
    );

    serializedComment.replies = [];

    res.json(serializedComment);
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

    selectedVideo.comments = normalizeStoredComments(selectedVideo.comments);
    const targetComment = findCommentById(
      selectedVideo.comments,
      req.params.commentId
    );

    if (!targetComment) {
      return res.status(404).json({ message: "No comment with that id exists" });
    }

    if (!targetComment?.userId || targetComment.userId !== req.user.id) {
      return res.status(403).json({ message: "You can only delete your own comments." });
    }

    const descendantCommentIds = collectDescendantCommentIds(
      selectedVideo.comments,
      req.params.commentId
    );
    const deletedCommentIds = [req.params.commentId, ...descendantCommentIds];
    const deletedCommentIdSet = new Set(deletedCommentIds);

    selectedVideo.comments = selectedVideo.comments.filter(
      (comment) => !deletedCommentIdSet.has(comment.id)
    );

    const remainingCommentLikes = commentLikesData.filter(
      (commentLike) =>
        !(
          commentLike.videoId === req.params.videoId &&
          deletedCommentIdSet.has(commentLike.commentId)
        )
    );
    await Promise.all([writeVideos(videosData), writeCommentLikes(remainingCommentLikes)]);

    const serializedComment = serializeComment(
      targetComment,
      avatarLookupByUserId,
      new Set()
    );

    serializedComment.replies = [];

    res.json({
      deletedComment: serializedComment,
      deletedCommentIds,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete comment." });
  }
});

module.exports = router;
