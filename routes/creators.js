const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const {
  readVideos,
  readUsers,
  readCreatorFollows,
  writeCreatorFollows,
} = require("../utils/storage");
const { requireAuth, JWT_SECRET } = require("../middleware/auth");
const {
  normalizeWhitespace,
  parseMetric,
  resolveVideoCreator,
} = require("../utils/creators");

const router = express.Router();
const MAX_CREATOR_VIDEOS = 100;

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
    const [videosData, usersData, creatorFollowsData] = await Promise.all([
      readVideos(),
      readUsers(),
      readCreatorFollows(),
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

    await writeCreatorFollows(nextCreatorFollows);

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
