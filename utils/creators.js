const normalizeWhitespace = (value = "") =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ");

const toSlug = (value = "") =>
  normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const fallbackCreatorIdForName = (creatorName = "") =>
  `channel-${toSlug(creatorName) || "unknown-creator"}`;

const resolveVideoCreator = (video = {}) => {
  const creatorName =
    normalizeWhitespace(video.channel || video.creatorName) || "Unknown Creator";
  const creatorId =
    normalizeWhitespace(video.creatorId) || fallbackCreatorIdForName(creatorName);
  const creatorAvatarUrl = normalizeWhitespace(video.creatorAvatarUrl || "");

  return {
    creatorId,
    creatorName,
    creatorAvatarUrl,
  };
};

const parseMetric = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }

  if (typeof value !== "string") {
    return 0;
  }

  const numericValue = Number(value.replace(/[^0-9]/g, ""));

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.max(0, Math.round(numericValue));
};

module.exports = {
  fallbackCreatorIdForName,
  normalizeWhitespace,
  parseMetric,
  resolveVideoCreator,
};
