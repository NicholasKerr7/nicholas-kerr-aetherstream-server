const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const {
  readVideos,
  readUsers,
  readCreatorFollows,
  writeCreatorFollows,
  readWatchProgress,
  readCommentLikes,
  readNotifications,
  writeNotifications,
} = require("../utils/storage");
const { requireAuth, JWT_SECRET } = require("../middleware/auth");
const {
  normalizeWhitespace,
  parseMetric,
  resolveVideoCreator,
} = require("../utils/creators");
const {
  resolveUserNotificationPreferences,
  isNotificationEnabledForType,
} = require("../utils/notificationPreferences");

const router = express.Router();
const MAX_CREATOR_VIDEOS = 100;
const DEFAULT_ANALYTICS_WINDOW_DAYS = 30;
const MIN_ANALYTICS_WINDOW_DAYS = 1;
const MAX_ANALYTICS_WINDOW_DAYS = 365;
const HOURS_PER_SECOND = 1 / 3600;

const getOptionalAuthenticatedUserId = (authorizationHeader = "", usersData = []) => {
  if (!authorizationHeader.startsWith("Bearer ")) {
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

const normalizeVideoTags = (video = {}) => {
  if (Array.isArray(video.tags)) {
    return video.tags.map((tag) => normalizeWhitespace(tag)).filter(Boolean);
  }

  if (typeof video.tags === "string") {
    return video.tags
      .split(",")
      .map((tag) => normalizeWhitespace(tag))
      .filter(Boolean);
  }

  return [];
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

const clampRatio = (value = 0) => Math.min(1, Math.max(0, Number(value) || 0));

const parseAnalyticsWindowDays = (windowDaysValue) => {
  const parsedWindowDays = Number(windowDaysValue);

  if (!Number.isFinite(parsedWindowDays)) {
    return DEFAULT_ANALYTICS_WINDOW_DAYS;
  }

  return Math.min(
    MAX_ANALYTICS_WINDOW_DAYS,
    Math.max(MIN_ANALYTICS_WINDOW_DAYS, Math.round(parsedWindowDays))
  );
};

const flattenStoredComments = (comments = []) => {
  if (!Array.isArray(comments)) {
    return [];
  }

  const flattenedComments = [];
  const visitedCommentIds = new Set();

  const visitComment = (comment = {}) => {
    if (!comment || typeof comment !== "object") {
      return;
    }

    const commentId = normalizeWhitespace(comment.id || "");

    if (commentId) {
      if (visitedCommentIds.has(commentId)) {
        return;
      }

      visitedCommentIds.add(commentId);
    }

    flattenedComments.push(comment);

    const replies = Array.isArray(comment.replies) ? comment.replies : [];
    replies.forEach((reply) => visitComment(reply));
  };

  comments.forEach((comment) => visitComment(comment));

  return flattenedComments;
};

const resolveWatchEntryDurationSeconds = (watchProgressEntry = {}) =>
  toPositiveInteger(watchProgressEntry.durationSeconds);

const resolveWatchEntryWatchedSeconds = (watchProgressEntry = {}) => {
  const durationSeconds = resolveWatchEntryDurationSeconds(watchProgressEntry);
  const progressSeconds = Math.max(
    0,
    Math.round(Number(watchProgressEntry.progressSeconds) || 0)
  );

  if (watchProgressEntry.completed) {
    return durationSeconds || progressSeconds;
  }

  if (durationSeconds) {
    return Math.min(durationSeconds, progressSeconds);
  }

  return progressSeconds;
};

const resolveWatchEntryCompletionRatio = (watchProgressEntry = {}) => {
  if (watchProgressEntry.completed) {
    return 1;
  }

  const durationSeconds = resolveWatchEntryDurationSeconds(watchProgressEntry);

  if (!durationSeconds) {
    return 0;
  }

  const progressSeconds = Math.max(
    0,
    Math.round(Number(watchProgressEntry.progressSeconds) || 0)
  );

  return clampRatio(progressSeconds / durationSeconds);
};

const roundHours = (totalSeconds = 0) =>
  Math.round(Math.max(0, Number(totalSeconds) || 0) * HOURS_PER_SECOND * 10) / 10;

const buildCreatorAnalytics = ({
  creatorId = "",
  creatorName = "",
  creatorAvatarUrl = "",
  videosData = [],
  watchProgressEntries = [],
  commentLikesData = [],
  creatorFollowsData = [],
  windowDays = DEFAULT_ANALYTICS_WINDOW_DAYS,
}) => {
  const analyticsWindowDays = parseAnalyticsWindowDays(windowDays);
  const windowStartAt = Date.now() - analyticsWindowDays * 24 * 60 * 60 * 1000;
  const creatorVideos = videosData.filter((video) => {
    const creator = resolveVideoCreator(video);
    return creator.creatorId === creatorId;
  });
  const creatorVideoIds = new Set(creatorVideos.map((video) => video.id));
  const watchEntriesForCreator = watchProgressEntries.filter((watchProgressEntry) =>
    creatorVideoIds.has(watchProgressEntry.videoId)
  );
  const commentLikesForCreator = commentLikesData.filter((commentLike) =>
    creatorVideoIds.has(commentLike.videoId)
  );
  const followers = creatorFollowsData.filter(
    (creatorFollow) => creatorFollow.creatorId === creatorId
  );
  const followersCount = followers.length;
  const newFollowersInWindow = followers.filter(
    (creatorFollow) => Number(creatorFollow.createdAt) >= windowStartAt
  ).length;
  const watchEntriesByVideoId = new Map();
  const commentLikesByVideoId = new Map();

  watchEntriesForCreator.forEach((watchProgressEntry) => {
    if (!watchEntriesByVideoId.has(watchProgressEntry.videoId)) {
      watchEntriesByVideoId.set(watchProgressEntry.videoId, []);
    }

    watchEntriesByVideoId.get(watchProgressEntry.videoId).push(watchProgressEntry);
  });

  commentLikesForCreator.forEach((commentLike) => {
    if (!commentLikesByVideoId.has(commentLike.videoId)) {
      commentLikesByVideoId.set(commentLike.videoId, []);
    }

    commentLikesByVideoId.get(commentLike.videoId).push(commentLike);
  });

  let totalViews = 0;
  let totalLikes = 0;
  let totalComments = 0;
  let totalCommentLikes = 0;
  let totalWatchSessions = 0;
  let totalCompletedViews = 0;
  let totalWatchSeconds = 0;
  let totalCompletionRatio = 0;
  let completionRatioCount = 0;
  let uploadedVideosInWindow = 0;
  let commentsInWindow = 0;
  let commentLikesInWindow = 0;
  let watchSessionsInWindow = 0;
  let watchSecondsInWindow = 0;
  const uniqueViewerUserIds = new Set();

  const perVideoAnalytics = creatorVideos.map((video) => {
    const videoViews = parseMetric(video.views);
    const videoLikes = parseMetric(video.likes);
    const videoComments = flattenStoredComments(video.comments);
    const videoCommentsCount = videoComments.length;
    const videoCommentLikes = commentLikesByVideoId.get(video.id) || [];
    const videoWatchEntries = watchEntriesByVideoId.get(video.id) || [];
    const videoUniqueViewers = new Set(
      videoWatchEntries.map((watchProgressEntry) => watchProgressEntry.userId).filter(Boolean)
    );
    let videoWatchSeconds = 0;
    let videoCompletedViews = 0;
    let videoCompletionRatio = 0;
    let videoCompletionRatioCount = 0;

    videoWatchEntries.forEach((watchProgressEntry) => {
      const watchedSeconds = resolveWatchEntryWatchedSeconds(watchProgressEntry);
      const completionRatio = resolveWatchEntryCompletionRatio(watchProgressEntry);
      const updatedAt = Number(watchProgressEntry.updatedAt) || 0;

      videoWatchSeconds += watchedSeconds;

      if (watchProgressEntry.completed) {
        videoCompletedViews += 1;
      }

      if (resolveWatchEntryDurationSeconds(watchProgressEntry) || watchProgressEntry.completed) {
        videoCompletionRatio += completionRatio;
        videoCompletionRatioCount += 1;
      }

      if (updatedAt >= windowStartAt) {
        watchSessionsInWindow += 1;
        watchSecondsInWindow += watchedSeconds;
      }
    });

    videoUniqueViewers.forEach((viewerUserId) => uniqueViewerUserIds.add(viewerUserId));

    const videoCommentsInWindow = videoComments.filter(
      (comment) => Number(comment.timestamp) >= windowStartAt
    ).length;
    const videoCommentLikesInWindow = videoCommentLikes.filter(
      (commentLike) => Number(commentLike.createdAt) >= windowStartAt
    ).length;
    const publishedAt = Number(video.timestamp) || 0;

    if (publishedAt >= windowStartAt) {
      uploadedVideosInWindow += 1;
    }

    commentsInWindow += videoCommentsInWindow;
    commentLikesInWindow += videoCommentLikesInWindow;
    totalViews += videoViews;
    totalLikes += videoLikes;
    totalComments += videoCommentsCount;
    totalCommentLikes += videoCommentLikes.length;
    totalWatchSessions += videoWatchEntries.length;
    totalCompletedViews += videoCompletedViews;
    totalWatchSeconds += videoWatchSeconds;
    totalCompletionRatio += videoCompletionRatio;
    completionRatioCount += videoCompletionRatioCount;

    return {
      id: video.id,
      title: video.title || "Untitled video",
      image: video.image || "",
      publishedAt,
      durationSeconds: parseDurationToSeconds(video.duration),
      duration: video.duration || "0:00",
      views: videoViews,
      likes: videoLikes,
      comments: videoCommentsCount,
      commentLikes: videoCommentLikes.length,
      watchSessions: videoWatchEntries.length,
      uniqueViewers: videoUniqueViewers.size,
      completedViews: videoCompletedViews,
      watchHours: roundHours(videoWatchSeconds),
      averageWatchTimeSeconds: videoWatchEntries.length
        ? Math.round(videoWatchSeconds / videoWatchEntries.length)
        : 0,
      completionRatePercent: videoCompletionRatioCount
        ? Math.round((videoCompletionRatio / videoCompletionRatioCount) * 100)
        : 0,
      engagementScore: videoLikes + videoCommentsCount + videoCommentLikes.length,
      windowComments: videoCommentsInWindow,
      windowCommentLikes: videoCommentLikesInWindow,
    };
  });

  const topVideos = [...perVideoAnalytics]
    .sort((firstVideo, secondVideo) => {
      if (secondVideo.engagementScore !== firstVideo.engagementScore) {
        return secondVideo.engagementScore - firstVideo.engagementScore;
      }

      if (secondVideo.views !== firstVideo.views) {
        return secondVideo.views - firstVideo.views;
      }

      return secondVideo.publishedAt - firstVideo.publishedAt;
    })
    .slice(0, 8);

  return {
    creator: {
      id: creatorId,
      name: creatorName || "Creator",
      avatarUrl: creatorAvatarUrl || "",
    },
    overview: {
      totalVideos: creatorVideos.length,
      totalViews,
      totalLikes,
      totalComments,
      totalCommentLikes,
      totalFollowers: followersCount,
      totalWatchSessions,
      totalCompletedViews,
      uniqueViewers: uniqueViewerUserIds.size,
      watchHours: roundHours(totalWatchSeconds),
      averageCompletionRatePercent: completionRatioCount
        ? Math.round((totalCompletionRatio / completionRatioCount) * 100)
        : 0,
      averageWatchTimeSeconds: totalWatchSessions
        ? Math.round(totalWatchSeconds / totalWatchSessions)
        : 0,
    },
    window: {
      days: analyticsWindowDays,
      startsAt: windowStartAt,
      uploadedVideos: uploadedVideosInWindow,
      comments: commentsInWindow,
      commentLikes: commentLikesInWindow,
      newFollowers: newFollowersInWindow,
      watchSessions: watchSessionsInWindow,
      watchHours: roundHours(watchSecondsInWindow),
    },
    topVideos,
    videos: perVideoAnalytics,
  };
};

const appendCreatorFollowNotification = (
  notificationsData = [],
  {
    recipientUserId = "",
    recipientNotificationPreferences = {},
    actorUser = null,
    creatorProfile = null,
  } = {}
) => {
  const safeNotifications = Array.isArray(notificationsData) ? notificationsData : [];
  const actorUserId = actorUser?.id || "";
  const actorName = normalizeWhitespace(actorUser?.name || "") || "Someone";
  const creatorId = normalizeWhitespace(creatorProfile?.id || "");

  if (
    !recipientUserId ||
    !actorUserId ||
    !creatorId ||
    recipientUserId === actorUserId
  ) {
    return safeNotifications;
  }

  if (!isNotificationEnabledForType(recipientNotificationPreferences, "creator_follow")) {
    return safeNotifications;
  }

  return [
    ...safeNotifications,
    {
      id: crypto.randomUUID(),
      userId: recipientUserId,
      type: "creator_follow",
      actorUserId,
      actorName,
      actorAvatarUrl: normalizeWhitespace(actorUser?.avatarUrl || ""),
      creatorId,
      message: `${actorName} started following your creator profile.`,
      createdAt: Date.now(),
      readAt: 0,
    },
  ];
};

const serializeCreatorVideo = (video) => {
  const creator = resolveVideoCreator(video);

  return {
    id: video.id,
    title: video.title,
    channel: creator.creatorName,
    creatorId: creator.creatorId,
    creatorAvatarUrl: creator.creatorAvatarUrl,
    image: video.image,
    description: video.description || "",
    views: video.views || "0",
    likes: video.likes || "0",
    duration: video.duration || "0:00",
    timestamp: Number(video.timestamp) || 0,
    category: video.category || "General",
    tags: normalizeVideoTags(video),
  };
};

const buildCreatorsDirectory = (
  videosData = [],
  usersData = [],
  creatorFollowsData = [],
  requesterUserId = ""
) => {
  const creatorMap = new Map();
  const followersByCreatorId = new Map();
  const followedCreatorIds = new Set();

  creatorFollowsData.forEach((creatorFollow) => {
    const creatorId = normalizeWhitespace(creatorFollow.creatorId);
    const followerUserId = normalizeWhitespace(creatorFollow.userId);

    if (!creatorId || !followerUserId) {
      return;
    }

    if (followerUserId === requesterUserId) {
      followedCreatorIds.add(creatorId);
    }

    followersByCreatorId.set(
      creatorId,
      (followersByCreatorId.get(creatorId) || 0) + 1
    );
  });

  videosData.forEach((video) => {
    const creator = resolveVideoCreator(video);
    const existingCreator =
      creatorMap.get(creator.creatorId) || {
        id: creator.creatorId,
        name: creator.creatorName,
        avatarUrl: creator.creatorAvatarUrl,
        followersCount: 0,
        isFollowedByCurrentUser: false,
        videoCount: 0,
        totalViews: 0,
        totalLikes: 0,
        lastPublishedAt: 0,
        videos: [],
      };

    existingCreator.name = creator.creatorName;
    if (!existingCreator.avatarUrl && creator.creatorAvatarUrl) {
      existingCreator.avatarUrl = creator.creatorAvatarUrl;
    }

    existingCreator.videoCount += 1;
    existingCreator.totalViews += parseMetric(video.views);
    existingCreator.totalLikes += parseMetric(video.likes);
    existingCreator.lastPublishedAt = Math.max(
      existingCreator.lastPublishedAt,
      Number(video.timestamp) || 0
    );
    existingCreator.videos.push(serializeCreatorVideo(video));

    creatorMap.set(creator.creatorId, existingCreator);
  });

  usersData.forEach((user) => {
    const existingCreator = creatorMap.get(user.id);

    if (!existingCreator) {
      return;
    }

    if (normalizeWhitespace(user.name)) {
      existingCreator.name = normalizeWhitespace(user.name);
    }

    if (!existingCreator.avatarUrl && normalizeWhitespace(user.avatarUrl || "")) {
      existingCreator.avatarUrl = normalizeWhitespace(user.avatarUrl || "");
    }
  });

  const creators = Array.from(creatorMap.values()).map((creator) => {
    const sortedVideos = [...creator.videos]
      .sort((firstVideo, secondVideo) => secondVideo.timestamp - firstVideo.timestamp)
      .slice(0, MAX_CREATOR_VIDEOS);

    return {
      ...creator,
      followersCount: followersByCreatorId.get(creator.id) || 0,
      isFollowedByCurrentUser: followedCreatorIds.has(creator.id),
      videos: sortedVideos,
    };
  });

  creators.sort((firstCreator, secondCreator) => {
    if (secondCreator.followersCount !== firstCreator.followersCount) {
      return secondCreator.followersCount - firstCreator.followersCount;
    }

    return secondCreator.lastPublishedAt - firstCreator.lastPublishedAt;
  });

  return {
    creators,
    creatorsById: new Map(creators.map((creator) => [creator.id, creator])),
  };
};

router.get("/", async (req, res) => {
  try {
    const [videosData, usersData, creatorFollowsData] = await Promise.all([
      readVideos(),
      readUsers(),
      readCreatorFollows(),
    ]);
    const requesterUserId = getOptionalAuthenticatedUserId(
      req.headers.authorization || "",
      usersData
    );
    const { creators } = buildCreatorsDirectory(
      videosData,
      usersData,
      creatorFollowsData,
      requesterUserId
    );

    res.json(creators);
  } catch (error) {
    res.status(500).json({ message: "Failed to load creators." });
  }
});

router.get("/me/analytics", requireAuth, async (req, res) => {
  try {
    const [videosData, usersData, creatorFollowsData, watchProgressEntries, commentLikes] =
      await Promise.all([
        readVideos(),
        readUsers(),
        readCreatorFollows(),
        readWatchProgress(),
        readCommentLikes(),
      ]);
    const currentUser = usersData.find((user) => user.id === req.user.id);
    const analyticsPayload = buildCreatorAnalytics({
      creatorId: req.user.id,
      creatorName: currentUser?.name || req.user.name,
      creatorAvatarUrl: currentUser?.avatarUrl || req.user.avatarUrl || "",
      videosData,
      watchProgressEntries,
      commentLikesData: commentLikes,
      creatorFollowsData,
      windowDays: req.query.windowDays,
    });

    res.json(analyticsPayload);
  } catch (error) {
    res.status(500).json({ message: "Failed to load creator analytics." });
  }
});

router.get("/:creatorId", async (req, res) => {
  try {
    const [videosData, usersData, creatorFollowsData] = await Promise.all([
      readVideos(),
      readUsers(),
      readCreatorFollows(),
    ]);
    const requesterUserId = getOptionalAuthenticatedUserId(
      req.headers.authorization || "",
      usersData
    );
    const { creatorsById } = buildCreatorsDirectory(
      videosData,
      usersData,
      creatorFollowsData,
      requesterUserId
    );
    const creatorProfile = creatorsById.get(req.params.creatorId);

    if (!creatorProfile) {
      return res.status(404).json({ message: "No creator with that id exists" });
    }

    res.json(creatorProfile);
  } catch (error) {
    res.status(500).json({ message: "Failed to load creator profile." });
  }
});

router.put("/:creatorId/follow", requireAuth, async (req, res) => {
  try {
    const [videosData, usersData, creatorFollowsData, notificationsData] =
      await Promise.all([
        readVideos(),
        readUsers(),
        readCreatorFollows(),
        readNotifications(),
      ]);
    const { creatorsById } = buildCreatorsDirectory(
      videosData,
      usersData,
      creatorFollowsData,
      req.user.id
    );
    const creatorProfile = creatorsById.get(req.params.creatorId);

    if (!creatorProfile) {
      return res.status(404).json({ message: "No creator with that id exists" });
    }

    if (creatorProfile.id === req.user.id) {
      return res
        .status(400)
        .json({ message: "You cannot follow your own creator profile." });
    }

    const existingFollowIndex = creatorFollowsData.findIndex(
      (creatorFollow) =>
        creatorFollow.userId === req.user.id &&
        creatorFollow.creatorId === req.params.creatorId
    );
    const isCurrentlyFollowing = existingFollowIndex >= 0;
    const requestedFollowing =
      typeof req.body.following === "boolean"
        ? req.body.following
        : !isCurrentlyFollowing;

    let nextCreatorFollows = creatorFollowsData.filter(
      (creatorFollow) =>
        !(
          creatorFollow.userId === req.user.id &&
          creatorFollow.creatorId === req.params.creatorId
        )
    );

    if (requestedFollowing) {
      nextCreatorFollows.push({
        id: isCurrentlyFollowing
          ? creatorFollowsData[existingFollowIndex]?.id || crypto.randomUUID()
          : crypto.randomUUID(),
        userId: req.user.id,
        creatorId: req.params.creatorId,
        createdAt: Date.now(),
      });
    }

    const didStartFollowing = requestedFollowing && !isCurrentlyFollowing;
    const creatorNotificationPreferences = resolveUserNotificationPreferences(
      usersData.find((user) => user.id === creatorProfile.id)
    );
    const nextNotifications = didStartFollowing
      ? appendCreatorFollowNotification(notificationsData, {
          recipientUserId: creatorProfile.id,
          recipientNotificationPreferences: creatorNotificationPreferences,
          actorUser: req.user,
          creatorProfile,
        })
      : notificationsData;
    const shouldWriteNotifications =
      nextNotifications.length !== notificationsData.length;
    const pendingWrites = [writeCreatorFollows(nextCreatorFollows)];

    if (shouldWriteNotifications) {
      pendingWrites.push(writeNotifications(nextNotifications));
    }

    await Promise.all(pendingWrites);

    const followersCount = nextCreatorFollows.filter(
      (creatorFollow) => creatorFollow.creatorId === req.params.creatorId
    ).length;

    res.json({
      creatorId: req.params.creatorId,
      following: requestedFollowing,
      followersCount,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update creator follow status." });
  }
});

module.exports = router;
