const express = require("express");

const { readNotifications, writeNotifications } = require("../utils/storage");
const { requireAuth } = require("../middleware/auth");

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
  commentId: notification.commentId || "",
  commentPreview: notification.commentPreview || "",
  message: notification.message || "",
  createdAt: Number(notification.createdAt) || Date.now(),
  readAt: Number(notification.readAt) || 0,
  isRead: Boolean(notification.readAt),
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const notificationsData = await readNotifications();
    const notificationsForUser = notificationsData
      .filter((notification) => notification.userId === req.user.id)
      .map(serializeNotification)
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
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load notifications." });
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
