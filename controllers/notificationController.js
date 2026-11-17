const express = require("express");
const router = express.Router();
const { getNotificationModel } = require("../db/notificationSchema");

const AllNotifications = async (req, res) => {
  try {
    // Extract & pre-parse query params
    const {
      status = "unread",
      type,
      priority,
      category,
      page = 1,
      limit = 20,
      sort = "created_at",
      order = "desc",
    } = req.query;

    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const Notification = getNotificationModel(req.orgDb);

    // ---- Build Query ----
    const query = { tenant_id: req.user.tenant_id };

    if (status !== "all") query.status = status;
    if (type) query.type = type;
    if (priority) query.priority = priority;
    if (category) query.category = category;

    // ---- Sorting ----
    const sortObj = { [sort]: order === "desc" ? -1 : 1 };

    // ---- Fetch notifications & count in parallel ----
    const [notifications, totalCount] = await Promise.all([
      Notification.find(query).sort(sortObj).skip(skip).limit(limitNum).lean(),
      Notification.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalCount / limitNum);

    // Remove action_url from all notifications
    const sanitizedNotifications = notifications.map((notification) => {
      const { action_url, ...rest } = notification;
      return rest;
    });

    // ---- Response ----
    res.status(200).json({
      success: true,
      data: {
        notifications: sanitizedNotifications,
        pagination: {
          current_page: pageNum,
          total_pages: totalPages,
          total_count: totalCount,
          has_next: pageNum < totalPages,
          has_prev: pageNum > 1,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching notifications",
      error: error.message,
    });
  }
};

const notificationCount = async (req, res) => {
  try {
    const Notification = getNotificationModel(req.orgDb);

    const tenantId = req.user.tenant_id;

    // Single pipeline with facet for better performance
    const [result] = await Notification.aggregate([
      {
        $match: { tenant_id: tenantId },
      },
      {
        $facet: {
          unread: [{ $match: { status: "unread" } }, { $count: "count" }],
          read: [{ $match: { status: "read" } }, { $count: "count" }],
          archived: [{ $match: { status: "archived" } }, { $count: "count" }],
          total: [{ $count: "count" }],
        },
      },
    ]);

    // Safely extract counts with fallback to 0
    const formattedCounts = {
      unread: result.unread[0]?.count || 0,
      read: result.read[0]?.count || 0,
      archived: result.archived[0]?.count || 0,
      total: result.total[0]?.count || 0,
    };

    res.status(200).json({
      success: true,
      data: formattedCounts,
    });
  } catch (error) {
    console.error("Error fetching notification counts:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching notification counts",
      error: error.message,
    });
  }
};

const notification = async (req, res) => {
  try {
    const { id } = req.params;
    const Notification = getNotificationModel(req.orgDb);

    const notification = await Notification.findOne({
      _id: id,
      tenant_id: req.user.tenant_id,
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    // If it's already read, just return it
    if (notification.status === "read") {
      // Remove action_url before sending response
      const { action_url, ...sanitizedNotification } = notification.toObject();

      return res.status(200).json({
        success: true,
        data: sanitizedNotification,
        message: "Notification already marked as read",
      });
    }

    await notification.markAsRead();

    // Remove action_url before sending response
    const { action_url, ...sanitizedNotification } = notification.toObject();

    res.status(200).json({
      success: true,
      data: sanitizedNotification,
    });
  } catch (error) {
    console.error("Error fetching notification:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching notification",
      error: error.message,
    });
  }
};

const markAllread = async (req, res) => {
  try {
    const Notification = getNotificationModel(req.orgDb);

    const result = await Notification.updateMany(
      {
        tenant_id: req.user.tenant_id,
        status: "unread",
      },
      {
        $set: {
          status: "read",
          read_at: new Date(),
          updated_at: new Date(),
        },
      }
    );

    res.status(200).json({
      success: true,
      message: `All ${result.modifiedCount} notifications marked as read`,
      data: { modified_count: result.modifiedCount },
    });
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    res.status(500).json({
      success: false,
      message: "Error updating notifications",
      error: error.message,
    });
  }
};

module.exports = {
  markAllread,
  notification,
  notificationCount,
  AllNotifications,
};
