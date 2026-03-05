const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  likes: true,
  comments: true,
  follows: true,
});

const normalizeNotificationPreferences = (preferences = {}) => ({
  likes:
    typeof preferences.likes === "boolean"
      ? preferences.likes
      : DEFAULT_NOTIFICATION_PREFERENCES.likes,
  comments:
    typeof preferences.comments === "boolean"
      ? preferences.comments
      : DEFAULT_NOTIFICATION_PREFERENCES.comments,
  follows:
    typeof preferences.follows === "boolean"
      ? preferences.follows
      : DEFAULT_NOTIFICATION_PREFERENCES.follows,
});

const resolveUserNotificationPreferences = (user = {}) =>
  normalizeNotificationPreferences(user.notificationPreferences || {});

const notificationTypeToPreferenceKey = {
  video_comment_like: "likes",
  video_comment: "comments",
  creator_follow: "follows",
};

const isNotificationEnabledForType = (preferences = {}, notificationType = "") => {
  const preferenceKey = notificationTypeToPreferenceKey[notificationType];

  if (!preferenceKey) {
    return true;
  }

  const normalizedPreferences = normalizeNotificationPreferences(preferences);

  return normalizedPreferences[preferenceKey];
};

module.exports = {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences,
  resolveUserNotificationPreferences,
  isNotificationEnabledForType,
};
