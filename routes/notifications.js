const express = require("express");

const {
  readNotifications,
  writeNotifications,
  readUsers,
  writeUsers,
} = require("../utils/storage");
const { requireAuth } = require("../middleware/auth");
const {
  normalizeNotificationPreferences,
  resolveUserNotificationPreferences,
  isNotificationEnabledForType,
} = require("../utils/notificationPreferences");

const router = express.Router();
const MAX_NOTIFICATIONS = 60;

const serializeNotification = (notification = {}) => ({
  id: notification.id,
  type: notification.type || "video_activity",
  userId: notification.userId,
  actorUserId: notification.actorUserId || "",
  actorName: notification.actorName || "Someone",
  actorAvatarUrl: notification.actorAvatarUrl || "",
  videoId: notification.videoId || "",
  videoTitle: notification.videoTitle || "",
  creatorId: notification.creatorId || "",
  commentId: notification.commentId || "",
  commentPreview: notification.commentPreview || "",
  message: notification.message || "",
  createdAt: Number(notification.createdAt) || Date.now(),
  readAt: Number(notification.readAt) || 0,
  isRead: Boolean(notification.readAt),
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const [notificationsData, usersData] = await Promise.all([
      readNotifications(),
      readUsers(),
    ]);
    const currentUser = usersData.find((user) => user.id === req.user.id);
    const notificationPreferences = resolveUserNotificationPreferences(currentUser);
    const notificationsForUser = notificationsData
      .filter((notification) => notification.userId === req.user.id)
      .map(serializeNotification)
      .filter((notification) =>
        isNotificationEnabledForType(notificationPreferences, notification.type)
      )
      .sort(
        (firstNotification, secondNotification) =>
          secondNotification.createdAt - firstNotification.createdAt
      )
      .slice(0, MAX_NOTIFICATIONS);
    const unreadCount = notificationsForUser.filter(
      (notification) => !notification.isRead
    ).length;

    res.json({
      notifications: notificationsForUser,
      unreadCount,
      preferences: notificationPreferences,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load notifications." });
  }
});

router.get("/preferences", requireAuth, async (req, res) => {
  try {
    const usersData = await readUsers();
    const currentUser = usersData.find((user) => user.id === req.user.id);

    if (!currentUser) {
      return res.status(404).json({ message: "User profile not found." });
    }

    res.json({
      preferences: resolveUserNotificationPreferences(currentUser),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load notification preferences." });
  }
});

router.put("/preferences", requireAuth, async (req, res) => {
  try {
    const usersData = await readUsers();
    const currentUser = usersData.find((user) => user.id === req.user.id);

    if (!currentUser) {
      return res.status(404).json({ message: "User profile not found." });
    }

    const nextPreferences = normalizeNotificationPreferences({
      ...resolveUserNotificationPreferences(currentUser),
      ...req.body,
    });

    currentUser.notificationPreferences = nextPreferences;
    await writeUsers(usersData);

    res.json({
      preferences: nextPreferences,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update notification preferences." });
  }
});

router.patch("/:notificationId/read", requireAuth, async (req, res) => {
  try {
    const notificationsData = await readNotifications();
    const notificationIndex = notificationsData.findIndex(
      (notification) =>
        notification.id === req.params.notificationId &&
        notification.userId === req.user.id
    );

    if (notificationIndex < 0) {
      return res.status(404).json({ message: "Notification not found." });
    }

    if (!notificationsData[notificationIndex].readAt) {
      notificationsData[notificationIndex].readAt = Date.now();
      await writeNotifications(notificationsData);
    }

    const unreadCount = notificationsData.filter(
      (notification) => notification.userId === req.user.id && !notification.readAt
    ).length;

    res.json({
      id: notificationsData[notificationIndex].id,
      readAt: Number(notificationsData[notificationIndex].readAt) || Date.now(),
      unreadCount,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update notification." });
  }
});

router.put("/read-all", requireAuth, async (req, res) => {
  try {
    const notificationsData = await readNotifications();
    const readAt = Date.now();
    let updatedCount = 0;

    const nextNotifications = notificationsData.map((notification) => {
      if (notification.userId !== req.user.id || notification.readAt) {
        return notification;
      }

      updatedCount += 1;

      return {
        ...notification,
        readAt,
      };
    });

    if (updatedCount > 0) {
      await writeNotifications(nextNotifications);
    }

    res.json({
      updatedCount,
      unreadCount: 0,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update notifications." });
  }
});

module.exports = router;
