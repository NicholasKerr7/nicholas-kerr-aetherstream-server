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

const { app } = require("../index");
const { ensureStorageReady } = require("../utils/storage");

let server;
let baseUrl;

const requestJson = async (route, options = {}) => {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();

  return {
    response,
    body: text ? JSON.parse(text) : null,
  };
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

test("supports local admin demo login outside production", async () => {
  const result = await requestJson("/auth/admin-login", {
    method: "POST",
    body: JSON.stringify({}),
  });

  assert.equal(result.response.status, 200);
  assert.ok(result.body.token);
  assert.equal(result.body.user.role, "admin");
});
