const express = require("express");
const router = express.Router();
const videosData = require("../data/videos.json");
const crypto = require("crypto");
// const uploadImg = require("../public/images/Upload-video-preview.jpg");

// app.use(express.static('public'));
// app.use('/images', express.static('images'));

router.get("/", (req, res) => {
  const allVideos = videosData.map((video) => {
    return {
      id: video.id,
      title: video.title,
      channel: video.channel,
      image: video.image,
    };
  });
  res.json(allVideos);
});

router.get("/:videosId", (req, res) => {
  const singleVideo = videosData.find((video) => {
    return video.id === req.params.videosId;
  });

  res.json(singleVideo);
});

router.post("/", (req, res) => {
  const newVideo = {
    id: crypto.randomUUID(),
    title: req.body.title,
    channel: "Nick",
    description: req.body.description,
    // comment: "Love the video, im definitely subscribing to your channel and liking your video.",
    likes: "250,000,000",
    views: "100,000,000",
    timestamp: new Date().toLocaleDateString(),
    // image: uploadImg ,
  };
  videosData.push(newVideo);
  res.status(201).json(newVideo);
});

module.exports = router;
