const express = require("express");
const crypto = require("crypto");

const { readVideos, writeVideos } = require("../utils/storage");

const router = express.Router();
const DEFAULT_VIDEO_IMAGE = "https://i.imgur.com/l2Xfgpl.jpg";

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
    const videosData = await readVideos();

    const singleVideo = videosData.find(
      (video) => video.id === req.params.videoId
    );

    if (!singleVideo) {
      return res.status(404).json({ message: "No video with that id exists" });
    }

    res.json(singleVideo);
  } catch (error) {
    res.status(500).json({ message: "Failed to load video details." });
  }
});

router.post("/", async (req, res) => {
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
      channel: "Nick",
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

router.post("/:videoId/comments", async (req, res) => {
  try {
    const commentText = req.body.comment?.trim();
    const authorName = req.body.name?.trim() || "You";

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
      name: authorName,
      comment: commentText,
      likes: 0,
      timestamp: Date.now(),
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

router.patch("/:videoId/comments/:commentId/like", async (req, res) => {
  try {
    const videosData = await readVideos();
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

    res.json(selectedComment);
  } catch (error) {
    res.status(500).json({ message: "Failed to like comment." });
  }
});

router.delete("/:videoId/comments/:commentId", async (req, res) => {
  try {
    const videosData = await readVideos();
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

    res.json(deletedComment);
  } catch (error) {
    res.status(500).json({ message: "Failed to delete comment." });
  }
});

module.exports = router;
