const path = require("path");
const streamifier = require("streamifier");
const { v2: cloudinary } = require("cloudinary");

const DEFAULT_VIDEO_FOLDER = "aetherstream/videos";
const DEFAULT_THUMBNAIL_FOLDER = "aetherstream/thumbnails";

const hasCloudinaryConfig = () =>
  Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );

const ensureCloudinaryConfigured = () => {
  if (!hasCloudinaryConfig()) {
    throw new Error("Cloudinary configuration is missing.");
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
};

const sanitizePublicIdBase = (name = "") =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const formatDuration = (durationSeconds = 0) => {
  const totalSeconds = Math.max(0, Math.round(Number(durationSeconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const uploadVideoFileToCloudinary = async (file) => {
  ensureCloudinaryConfigured();

  if (!file?.buffer?.length) {
    throw new Error("Video file payload is empty.");
  }

  const fileNameBase = sanitizePublicIdBase(
    path.parse(file.originalname || "upload-video").name
  );
  const publicId = `${Date.now()}-${fileNameBase || "video"}`;
  const uploadFolder = process.env.CLOUDINARY_VIDEO_FOLDER || DEFAULT_VIDEO_FOLDER;

  const uploadResult = await new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: uploadFolder,
        public_id: publicId,
        resource_type: "video",
        overwrite: false,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      }
    );

    streamifier.createReadStream(file.buffer).pipe(uploadStream);
  });

  const thumbnailUrl = cloudinary.url(uploadResult.public_id, {
    resource_type: "video",
    format: "jpg",
    secure: true,
    transformation: [
      { width: 1280, height: 720, crop: "fill", gravity: "auto" },
      { start_offset: "1" },
      { quality: "auto" },
    ],
  });

  return {
    videoUrl: uploadResult.secure_url,
    thumbnailUrl,
    duration: formatDuration(uploadResult.duration),
    bytes: uploadResult.bytes || 0,
    publicId: uploadResult.public_id,
  };
};

const uploadImageFileToCloudinary = async (file) => {
  ensureCloudinaryConfigured();

  if (!file?.buffer?.length) {
    throw new Error("Image file payload is empty.");
  }

  const fileNameBase = sanitizePublicIdBase(
    path.parse(file.originalname || "upload-thumbnail").name
  );
  const publicId = `${Date.now()}-${fileNameBase || "thumbnail"}`;
  const uploadFolder =
    process.env.CLOUDINARY_THUMBNAIL_FOLDER || DEFAULT_THUMBNAIL_FOLDER;

  const uploadResult = await new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: uploadFolder,
        public_id: publicId,
        resource_type: "image",
        overwrite: false,
        transformation: [
          { width: 1280, height: 720, crop: "fill", gravity: "auto" },
          { quality: "auto" },
        ],
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      }
    );

    streamifier.createReadStream(file.buffer).pipe(uploadStream);
  });
  const imageUrl = cloudinary.url(uploadResult.public_id, {
    resource_type: "image",
    secure: true,
    transformation: [
      { width: 1280, height: 720, crop: "fill", gravity: "auto" },
      { quality: "auto" },
    ],
  });

  return {
    imageUrl,
    bytes: uploadResult.bytes || 0,
    publicId: uploadResult.public_id,
  };
};

module.exports = {
  hasCloudinaryConfig,
  uploadImageFileToCloudinary,
  uploadVideoFileToCloudinary,
  formatDuration,
};
