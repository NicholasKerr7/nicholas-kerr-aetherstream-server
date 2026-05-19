# AetherStream API

Express API for the AetherStream client. It powers authentication, personalized video feeds, creator profiles, creator analytics, upload publishing, watch progress, saved videos, threaded comments, notifications, and local admin demo access.

## Stack

- Node.js and Express
- JSON-file persistence through `utils/storage.js`
- JWT authentication with `jsonwebtoken`
- Password hashing with `bcryptjs`
- Multipart uploads with `multer`
- Optional Cloudinary media storage for published videos and thumbnails

## Local Development

Install dependencies:

```bash
npm install
```

Create a local `.env` from the example file:

```bash
cp .env.example .env
```

Start the API:

```bash
npm start
```

The server listens on `http://localhost:8080/` by default. The AetherStream client expects this API URL.

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | API port. Defaults to `8080`. |
| `STORAGE_DIR` | Directory for JSON persistence files. Defaults to the Seagate data path used by this repo. Set this to any writable local path if that drive is not mounted. |
| `CORS_ORIGINS` | Comma-separated allowed browser origins. Defaults to local client origins. |
| `JSON_BODY_LIMIT` | Max JSON request body size. Defaults to `1mb`. |
| `RATE_LIMIT_WINDOW_MS` | Rate-limit window in milliseconds. Defaults to 15 minutes. |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per IP per window. Defaults to `300`. |
| `JWT_SECRET` | Secret used to sign and verify auth tokens. Set a strong value outside local development. |
| `JWT_EXPIRES_IN` | JWT lifetime. Defaults to `7d`. |
| `MAX_VIDEO_UPLOAD_BYTES` | Max accepted video upload size. Defaults to 750 MB. |
| `MAX_THUMBNAIL_UPLOAD_BYTES` | Max accepted thumbnail image size. Defaults to 10 MB. |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name for upload publishing. |
| `CLOUDINARY_API_KEY` | Cloudinary API key. |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret. |
| `CLOUDINARY_VIDEO_FOLDER` | Cloudinary folder for uploaded videos. Defaults to `aetherstream/videos`. |
| `CLOUDINARY_THUMBNAIL_FOLDER` | Cloudinary folder for uploaded thumbnails. Defaults to `aetherstream/thumbnails`. |
| `ADMIN_DEMO_LOGIN_ENABLED` | Set to `true` to allow `/auth/admin-login` in production. It is enabled automatically outside production. |
| `ADMIN_DEMO_EMAIL` | Optional admin demo email override. |
| `ADMIN_DEMO_PASSWORD` | Optional admin demo password override. |
| `ADMIN_DEMO_NAME` | Optional admin demo display name override. |

## Storage

The API persists state as JSON files:

- `videos.json`
- `users.json`
- `comment-likes.json`
- `watch-progress.json`
- `creator-follows.json`
- `notifications.json`

On startup, `ensureStorageReady()` creates the storage directory and seeds missing files from the repo's `data/` directory. This is intentionally lightweight for local development and demos; it is not a replacement for a production database.

## Authentication

Protected routes require:

```http
Authorization: Bearer <token>
```

Auth endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/signup` | Create an account and return a token. |
| `POST` | `/auth/login` | Sign in with email and password. |
| `POST` | `/auth/admin-login` | Create or sign in as the local admin demo user. |
| `GET` | `/auth/me` | Return the current authenticated profile. |
| `PATCH` | `/auth/me` | Update display name or avatar URL. |

## Videos

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/videos` | No | List video summaries. |
| `GET` | `/videos/feed?mode=for-you&limit=36` | Optional | Return ranked feed items. Modes: `for-you`, `following`, `trending`. |
| `GET` | `/videos/:videoId` | Optional | Return full video details, comments, creator state, like/save state, and watch progress. |
| `GET` | `/videos/history` | Yes | Return watch history and continue-watching items. |
| `GET` | `/videos/following` | Yes | Return videos from followed creators. |
| `GET` | `/videos/mine` | Yes | Return videos owned by the current creator. |
| `GET` | `/videos/saved` | Yes | Return saved videos for the current user. |
| `POST` | `/videos` | Yes | Publish a multipart video upload with optional thumbnail. Requires Cloudinary config. |
| `PATCH` | `/videos/:videoId` | Yes | Update title, description, category, and tags for owned videos. |
| `DELETE` | `/videos/:videoId` | Yes | Delete an owned video and related user state. |
| `PATCH` | `/videos/:videoId/like` | Yes | Toggle or set the current user's video like. |
| `PATCH` | `/videos/:videoId/save` | Yes | Toggle or set saved-video state. |
| `PUT` | `/videos/:videoId/progress` | Yes | Upsert watch progress. |
| `POST` | `/videos/:videoId/comments` | Yes | Add a top-level comment or reply. |
| `PATCH` | `/videos/:videoId/comments/:commentId/like` | Yes | Toggle the current user's comment like. |
| `DELETE` | `/videos/:videoId/comments/:commentId` | Yes | Delete the current user's comment and its replies. |

Video uploads use `multipart/form-data` with:

- `video`: required video file
- `thumbnail`: optional image file
- `title`: required
- `description`: required
- `category`: optional
- `tags`: optional comma-separated tags

If Cloudinary variables are missing, upload publishing returns `503` while the rest of the API remains usable.

## Creators

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/creators` | Optional | List creator profiles derived from published videos. |
| `GET` | `/creators/:creatorId` | Optional | Return one creator profile and recent uploads. |
| `GET` | `/creators/me/analytics?windowDays=30` | Yes | Return current creator analytics and top videos. |
| `PUT` | `/creators/:creatorId/follow` | Yes | Follow or unfollow a creator. |

Creator analytics include total videos, views, likes, comments, followers, watch sessions, completed views, watch hours, average completion rate, windowed activity, and top videos.

## Notifications

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/notifications` | Yes | Return recent notifications, unread count, and preferences. |
| `GET` | `/notifications/preferences` | Yes | Return notification preferences. |
| `PUT` | `/notifications/preferences` | Yes | Update notification preferences. |
| `PATCH` | `/notifications/:notificationId/read` | Yes | Mark one notification as read. |
| `PUT` | `/notifications/read-all` | Yes | Mark all current-user notifications as read. |

Notifications are created for creator follows, video comments, and comment likes when the recipient's preferences allow the event type.

## Maintenance

Useful checks before pushing API changes:

```bash
npm test
npm audit
npm audit --omit=dev
npm run audit:ci
```

GitHub Actions runs the API test suite, a high-severity audit gate, and dependency review for pull requests. Dependabot is configured to open grouped npm and GitHub Actions update PRs weekly.

## Security Hardening

The API disables `X-Powered-By`, applies Helmet security headers, restricts CORS to configured origins, limits JSON body size, rate-limits requests, validates upload MIME types, and keeps auth-only routes behind JWT middleware.

For local end-to-end verification, run the API on `http://localhost:8080/` and the AetherStream client on `http://localhost:3000/`.
