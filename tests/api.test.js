const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const storageDir = path.join(os.tmpdir(), `aetherstream-api-test-${Date.now()}`);

process.env.NODE_ENV = "test";
process.env.STORAGE_DIR = storageDir;
process.env.JWT_SECRET = "test-jwt-secret";
process.env.CORS_ORIGINS = "http://localhost:3000";
process.env.RATE_LIMIT_MAX_REQUESTS = "1000";
delete process.env.CLOUDINARY_CLOUD_NAME;
delete process.env.CLOUDINARY_API_KEY;
delete process.env.CLOUDINARY_API_SECRET;

const { app } = require("../index");
const { ensureStorageReady, readVideos, writeVideos } = require("../utils/storage");

let server;
let baseUrl;

const requestJson = async (route, options = {}) => {
  const isJsonBody = typeof options.body === "string";
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      ...(isJsonBody ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();

  return {
    response,
    body: text ? JSON.parse(text) : null,
  };
};

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

const uniqueSuffix = () =>
  `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const createTestUser = async (label = "Flow User") => {
  const suffix = uniqueSuffix();
  const normalizedLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const email = `${normalizedLabel}-${suffix}@aetherstream.local`;
  const password = "secure-password";
  const result = await requestJson("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      name: `${label} ${suffix.slice(-4)}`,
      email,
      password,
      avatarUrl: "",
    }),
  });

  assert.equal(result.response.status, 201);
  assert.ok(result.body.token);

  return {
    email,
    password,
    token: result.body.token,
    user: result.body.user,
  };
};

const appendVideoForCreator = async (creator, overrides = {}) => {
  const videosData = await readVideos();
  const video = {
    id: `test-video-${uniqueSuffix()}`,
    title: "Deterministic API Flow",
    channel: creator.name,
    creatorId: creator.id,
    creatorAvatarUrl: creator.avatarUrl || "",
    image: "https://example.com/test-poster.jpg",
    description: "A stable fixture video for API flow coverage.",
    category: "Technology",
    tags: ["api", "testing"],
    likes: "0",
    views: "10",
    duration: "2:00",
    video: "https://example.com/test-video.mp4",
    timestamp: Date.now(),
    comments: [],
    ...overrides,
  };

  await writeVideos([...videosData, video]);

  return video;
};

test.before(async () => {
  await ensureStorageReady();

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  await fs.rm(storageDir, { recursive: true, force: true });
});

test("serves security headers and allowed CORS origins", async () => {
  const response = await fetch(`${baseUrl}/videos`, {
    headers: {
      Origin: "http://localhost:3000",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.ok(response.headers.get("ratelimit"));
});

test("does not reflect disallowed CORS origins", async () => {
  const response = await fetch(`${baseUrl}/videos`, {
    headers: {
      Origin: "https://malicious.example",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("returns seeded video summaries and personalized feed payloads", async () => {
  const videosResult = await requestJson("/videos");

  assert.equal(videosResult.response.status, 200);
  assert.ok(Array.isArray(videosResult.body));
  assert.ok(videosResult.body.length > 0);
  assert.ok(videosResult.body[0].id);
  assert.ok(videosResult.body[0].title);

  const feedResult = await requestJson("/videos/feed?mode=for-you&limit=5");

  assert.equal(feedResult.response.status, 200);
  assert.equal(feedResult.body.mode, "trending");
  assert.equal(feedResult.body.requestedMode, "for-you");
  assert.ok(Array.isArray(feedResult.body.videos));
  assert.ok(feedResult.body.videos.length <= 5);
});

test("rejects protected routes without a bearer token", async () => {
  const result = await requestJson("/videos/history");

  assert.equal(result.response.status, 401);
  assert.match(result.body.message, /Authorization token is required/i);
});

test("supports signup and authenticated profile reads", async () => {
  const email = `test-${Date.now()}@aetherstream.local`;
  const signupResult = await requestJson("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      name: "Test Creator",
      email,
      password: "secure-password",
      avatarUrl: "",
    }),
  });

  assert.equal(signupResult.response.status, 201);
  assert.ok(signupResult.body.token);
  assert.equal(signupResult.body.user.email, email);
  assert.equal(signupResult.body.user.passwordHash, undefined);

  const profileResult = await requestJson("/auth/me", {
    headers: {
      Authorization: `Bearer ${signupResult.body.token}`,
    },
  });

  assert.equal(profileResult.response.status, 200);
  assert.equal(profileResult.body.email, email);
});

test("supports login, duplicate signup protection, and profile updates", async () => {
  const account = await createTestUser("Auth Flow");

  const duplicateSignupResult = await requestJson("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      name: "Duplicate Auth Flow",
      email: account.email,
      password: account.password,
      avatarUrl: "",
    }),
  });

  assert.equal(duplicateSignupResult.response.status, 409);

  const loginResult = await requestJson("/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: account.email,
      password: account.password,
    }),
  });

  assert.equal(loginResult.response.status, 200);
  assert.ok(loginResult.body.token);
  assert.equal(loginResult.body.user.email, account.email);

  const profileUpdateResult = await requestJson("/auth/me", {
    method: "PATCH",
    headers: authHeaders(loginResult.body.token),
    body: JSON.stringify({
      name: "Updated Auth Flow",
      avatarUrl: "https://example.com/avatar.png",
    }),
  });

  assert.equal(profileUpdateResult.response.status, 200);
  assert.equal(profileUpdateResult.body.name, "Updated Auth Flow");
  assert.equal(profileUpdateResult.body.avatarUrl, "https://example.com/avatar.png");
});

test("supports local admin demo login outside production", async () => {
  const result = await requestJson("/auth/admin-login", {
    method: "POST",
    body: JSON.stringify({}),
  });

  assert.equal(result.response.status, 200);
  assert.ok(result.body.token);
  assert.equal(result.body.user.role, "admin");
});

test("validates authenticated upload requests without external media services", async () => {
  const uploader = await createTestUser("Upload Flow");

  const unauthenticatedUpload = await requestJson("/videos", {
    method: "POST",
    body: JSON.stringify({
      title: "Unauthorized upload",
      description: "This should not publish.",
    }),
  });

  assert.equal(unauthenticatedUpload.response.status, 401);

  const missingVideoForm = new FormData();
  missingVideoForm.append("title", "Upload without video");
  missingVideoForm.append("description", "Missing video file coverage.");

  const missingVideoResult = await requestJson("/videos", {
    method: "POST",
    headers: authHeaders(uploader.token),
    body: missingVideoForm,
  });

  assert.equal(missingVideoResult.response.status, 400);
  assert.match(missingVideoResult.body.message, /attach a video/i);

  const uploadForm = new FormData();
  uploadForm.append("title", "Upload pipeline validation");
  uploadForm.append("description", "Valid multipart fields but no Cloudinary config.");
  uploadForm.append("category", "technology");
  uploadForm.append("tags", "api, upload");
  uploadForm.append(
    "video",
    new Blob(["fake mp4 payload"], { type: "video/mp4" }),
    "flow.mp4"
  );
  uploadForm.append(
    "thumbnail",
    new Blob(["fake image payload"], { type: "image/jpeg" }),
    "flow.jpg"
  );

  const unconfiguredPipelineResult = await requestJson("/videos", {
    method: "POST",
    headers: authHeaders(uploader.token),
    body: uploadForm,
  });

  assert.equal(unconfiguredPipelineResult.response.status, 503);
  assert.match(unconfiguredPipelineResult.body.message, /Cloudinary/i);
});

test("supports creator follow management and creator notifications", async () => {
  const creator = await createTestUser("Creator Follow Target");
  const follower = await createTestUser("Creator Follower");
  const video = await appendVideoForCreator(creator.user, {
    title: "Creator Follow Coverage",
  });

  const creatorProfileResult = await requestJson(`/creators/${creator.user.id}`, {
    headers: authHeaders(follower.token),
  });

  assert.equal(creatorProfileResult.response.status, 200);
  assert.equal(creatorProfileResult.body.id, creator.user.id);
  assert.ok(
    creatorProfileResult.body.videos.some(
      (creatorVideo) => creatorVideo.id === video.id
    )
  );

  const followResult = await requestJson(`/creators/${creator.user.id}/follow`, {
    method: "PUT",
    headers: authHeaders(follower.token),
    body: JSON.stringify({ following: true }),
  });

  assert.equal(followResult.response.status, 200);
  assert.equal(followResult.body.following, true);
  assert.equal(followResult.body.followersCount, 1);

  const followingFeedResult = await requestJson("/videos/following", {
    headers: authHeaders(follower.token),
  });

  assert.equal(followingFeedResult.response.status, 200);
  assert.deepEqual(followingFeedResult.body.followedCreatorIds, [creator.user.id]);
  assert.ok(
    followingFeedResult.body.videos.some(
      (followingVideo) => followingVideo.id === video.id
    )
  );

  const notificationsResult = await requestJson("/notifications", {
    headers: authHeaders(creator.token),
  });
  const followNotification = notificationsResult.body.notifications.find(
    (notification) =>
      notification.type === "creator_follow" &&
      notification.actorUserId === follower.user.id
  );

  assert.equal(notificationsResult.response.status, 200);
  assert.ok(followNotification);
  assert.equal(notificationsResult.body.unreadCount, 1);

  const readResult = await requestJson(
    `/notifications/${followNotification.id}/read`,
    {
      method: "PATCH",
      headers: authHeaders(creator.token),
    }
  );

  assert.equal(readResult.response.status, 200);
  assert.equal(readResult.body.unreadCount, 0);

  const unfollowResult = await requestJson(`/creators/${creator.user.id}/follow`, {
    method: "PUT",
    headers: authHeaders(follower.token),
    body: JSON.stringify({ following: false }),
  });

  assert.equal(unfollowResult.response.status, 200);
  assert.equal(unfollowResult.body.following, false);
  assert.equal(unfollowResult.body.followersCount, 0);
});

test("supports creator-owned video management and analytics", async () => {
  const creator = await createTestUser("Video Manager");
  const viewer = await createTestUser("Analytics Viewer");
  const video = await appendVideoForCreator(creator.user, {
    title: "Original Managed Video",
    views: "42",
    duration: "4:00",
  });

  const forbiddenUpdateResult = await requestJson(`/videos/${video.id}`, {
    method: "PATCH",
    headers: authHeaders(viewer.token),
    body: JSON.stringify({
      title: "Viewer should not edit",
      description: "This update should be rejected.",
    }),
  });

  assert.equal(forbiddenUpdateResult.response.status, 403);

  const updateResult = await requestJson(`/videos/${video.id}`, {
    method: "PATCH",
    headers: authHeaders(creator.token),
    body: JSON.stringify({
      title: "Updated Managed Video",
      description: "Updated creator-managed description.",
      category: "education",
      tags: ["workflow", "testing", "workflow"],
    }),
  });

  assert.equal(updateResult.response.status, 200);
  assert.equal(updateResult.body.title, "Updated Managed Video");
  assert.equal(updateResult.body.category, "Education");
  assert.deepEqual(updateResult.body.tags, ["workflow", "testing"]);

  const mineResult = await requestJson("/videos/mine", {
    headers: authHeaders(creator.token),
  });

  assert.equal(mineResult.response.status, 200);
  assert.ok(mineResult.body.videos.some((ownedVideo) => ownedVideo.id === video.id));

  const progressResult = await requestJson(`/videos/${video.id}/progress`, {
    method: "PUT",
    headers: authHeaders(viewer.token),
    body: JSON.stringify({
      progressSeconds: 120,
      durationSeconds: 240,
    }),
  });

  assert.equal(progressResult.response.status, 200);
  assert.equal(progressResult.body.progressPercent, 50);

  const analyticsResult = await requestJson("/creators/me/analytics?windowDays=14", {
    headers: authHeaders(creator.token),
  });

  assert.equal(analyticsResult.response.status, 200);
  assert.equal(analyticsResult.body.creator.id, creator.user.id);
  assert.equal(analyticsResult.body.overview.totalVideos, 1);
  assert.equal(analyticsResult.body.overview.totalWatchSessions, 1);
  assert.equal(analyticsResult.body.overview.uniqueViewers, 1);

  const deleteResult = await requestJson(`/videos/${video.id}`, {
    method: "DELETE",
    headers: authHeaders(creator.token),
  });

  assert.equal(deleteResult.response.status, 200);
  assert.equal(deleteResult.body.deleted, true);

  const afterDeleteMineResult = await requestJson("/videos/mine", {
    headers: authHeaders(creator.token),
  });

  assert.equal(afterDeleteMineResult.response.status, 200);
  assert.equal(
    afterDeleteMineResult.body.videos.some((ownedVideo) => ownedVideo.id === video.id),
    false
  );
});

test("supports comments, video likes, comment likes, saves, and read-all notifications", async () => {
  const creator = await createTestUser("Commented Creator");
  const commenter = await createTestUser("Video Commenter");
  const liker = await createTestUser("Comment Liker");
  const video = await appendVideoForCreator(creator.user, {
    title: "Comment Coverage Video",
  });

  const commentResult = await requestJson(`/videos/${video.id}/comments`, {
    method: "POST",
    headers: authHeaders(commenter.token),
    body: JSON.stringify({ comment: "This API flow is working." }),
  });

  assert.equal(commentResult.response.status, 201);
  assert.ok(commentResult.body.id);
  assert.equal(commentResult.body.comment, "This API flow is working.");

  const likeVideoResult = await requestJson(`/videos/${video.id}/like`, {
    method: "PATCH",
    headers: authHeaders(commenter.token),
    body: JSON.stringify({ liked: true }),
  });

  assert.equal(likeVideoResult.response.status, 200);
  assert.equal(likeVideoResult.body.liked, true);
  assert.equal(likeVideoResult.body.likesCount, 1);

  const saveVideoResult = await requestJson(`/videos/${video.id}/save`, {
    method: "PATCH",
    headers: authHeaders(commenter.token),
    body: JSON.stringify({ saved: true }),
  });

  assert.equal(saveVideoResult.response.status, 200);
  assert.equal(saveVideoResult.body.saved, true);

  const likeCommentResult = await requestJson(
    `/videos/${video.id}/comments/${commentResult.body.id}/like`,
    {
      method: "PATCH",
      headers: authHeaders(liker.token),
    }
  );

  assert.equal(likeCommentResult.response.status, 200);
  assert.equal(likeCommentResult.body.likes, 1);
  assert.equal(likeCommentResult.body.likedByCurrentUser, true);

  const unlikeCommentResult = await requestJson(
    `/videos/${video.id}/comments/${commentResult.body.id}/like`,
    {
      method: "PATCH",
      headers: authHeaders(liker.token),
    }
  );

  assert.equal(unlikeCommentResult.response.status, 200);
  assert.equal(unlikeCommentResult.body.likes, 0);
  assert.equal(unlikeCommentResult.body.likedByCurrentUser, false);

  const detailResult = await requestJson(`/videos/${video.id}`, {
    headers: authHeaders(commenter.token),
  });

  assert.equal(detailResult.response.status, 200);
  assert.equal(detailResult.body.isLikedByCurrentUser, true);
  assert.equal(detailResult.body.isSavedByCurrentUser, true);
  assert.ok(
    detailResult.body.comments.some(
      (comment) => comment.id === commentResult.body.id
    )
  );

  const notificationsResult = await requestJson("/notifications", {
    headers: authHeaders(creator.token),
  });
  const notificationTypes = notificationsResult.body.notifications.map(
    (notification) => notification.type
  );

  assert.equal(notificationsResult.response.status, 200);
  assert.ok(notificationTypes.includes("video_comment"));
  assert.ok(notificationTypes.includes("video_comment_like"));
  assert.equal(notificationsResult.body.unreadCount, 2);

  const readAllResult = await requestJson("/notifications/read-all", {
    method: "PUT",
    headers: authHeaders(creator.token),
  });

  assert.equal(readAllResult.response.status, 200);
  assert.equal(readAllResult.body.updatedCount, 2);
  assert.equal(readAllResult.body.unreadCount, 0);

  const deleteCommentResult = await requestJson(
    `/videos/${video.id}/comments/${commentResult.body.id}`,
    {
      method: "DELETE",
      headers: authHeaders(commenter.token),
    }
  );

  assert.equal(deleteCommentResult.response.status, 200);
  assert.ok(deleteCommentResult.body.deletedCommentIds.includes(commentResult.body.id));

  const afterDeleteDetailResult = await requestJson(`/videos/${video.id}`, {
    headers: authHeaders(commenter.token),
  });

  assert.equal(afterDeleteDetailResult.response.status, 200);
  assert.equal(
    afterDeleteDetailResult.body.comments.some(
      (comment) => comment.id === commentResult.body.id
    ),
    false
  );
});
