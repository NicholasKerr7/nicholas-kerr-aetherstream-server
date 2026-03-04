const express = require("express");
const crypto = require("crypto");

const { readVideos, writeVideos, readUsers } = require("../utils/storage");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const DEFAULT_VIDEO_IMAGE = "https://i.imgur.com/l2Xfgpl.jpg";

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

const serializeComment = (comment, avatarLookupByUserId) => ({
  ...comment,
  avatarUrl: resolveCommentAvatarUrl(comment, avatarLookupByUserId),
});

const serializeVideoWithCommentAvatars = (video, avatarLookupByUserId) => ({
  ...video,
  comments: Array.isArray(video.comments)
    ? video.comments.map((comment) =>
        serializeComment(comment, avatarLookupByUserId)
      )
    : [],
});

router.get("/", async (req, res) => {
  try {
    const videosData = await readVideos();

    const allVideos = videosData.map((video) => ({
      id: video.id,
      title: video.title,
      channel: video.channel,
      image: video.image,
    }));

    res.json(allVideos);
  } catch (error) {
    res.status(500).json({ message: "Failed to load videos." });
  }
});

router.get("/:videoId", async (req, res) => {
  try {
    const [videosData, usersData] = await Promise.all([readVideos(), readUsers()]);
    const avatarLookupByUserId = buildAvatarLookupByUserId(usersData);

    const singleVideo = videosData.find(
      (video) => video.id === req.params.videoId
    );

    if (!singleVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    res.json(serializeVideoWithCommentAvatars(singleVideo, avatarLookupByUserId));
  } catch (error) {
    res.status(500).json({ message: "Failed to load video details." });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const title = req.body.title?.trim();
    const description = req.body.description?.trim();

    if (!title || !description) {
      return res
        .status(400)
        .json({ message: "Please provide both a title and description." });
    }

    const videosData = await readVideos();

    const newVideo = {
      id: crypto.randomUUID(),
      title,
      channel: req.user.name,
      image: DEFAULT_VIDEO_IMAGE,
      description,
      likes: "0",
      views: "0",
      duration: "0:00",
      video: "https://project-2-api.herokuapp.com/stream",
      timestamp: Date.now(),
      comments: [],
    };

    videosData.push(newVideo);
    await writeVideos(videosData);

    res.status(201).json(newVideo);
  } catch (error) {
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

    res.status(201).json(newComment);
  } catch (error) {
    res.status(500).json({ message: "Failed to publish comment." });
  }
});

router.patch("/:videoId/comments/:commentId/like", requireAuth, async (req, res) => {
  try {
    const [videosData, usersData] = await Promise.all([readVideos(), readUsers()]);
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

    selectedComment.likes = Number(selectedComment.likes || 0) + 1;
    await writeVideos(videosData);

    res.json(serializeComment(selectedComment, avatarLookupByUserId));
  } catch (error) {
    res.status(500).json({ message: "Failed to like comment." });
  }
});

router.delete("/:videoId/comments/:commentId", requireAuth, async (req, res) => {
  try {
    const [videosData, usersData] = await Promise.all([readVideos(), readUsers()]);
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

    const [deletedComment] = selectedVideo.comments.splice(commentIndex, 1);
    await writeVideos(videosData);

    res.json(serializeComment(deletedComment, avatarLookupByUserId));
  } catch (error) {
    res.status(500).json({ message: "Failed to delete comment." });
  }
});

module.exports = router;
