// controllers/activityLogController.js
const { getUserActivityLogModel } = require("../db/activitylogschema");

// Get user activity logs with filtering and pagination
const getUserActivityLogs = async (req, res) => {
  try {
    const {
      user_id,
      action,
      resource,
      start_date,
      end_date,
      page = 1,
      limit = 50,
      sort_by = "timestamp",
      sort_order = "desc",
    } = req.query;

    const UserActivityLog = getUserActivityLogModel(req.orgDb);

    // Convert page & limit once
    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 50;

    // Build query filters efficiently
    const filter = {};

    if (user_id) filter.user_id = user_id;
    if (action) filter.action = action;
    if (resource) filter.resource = resource;

    if (start_date || end_date) {
      const ts = {};
      if (start_date) ts.$gte = new Date(start_date);
      if (end_date) ts.$lte = new Date(end_date);
      filter.timestamp = ts;
    }

    const skip = (pageNum - 1) * limitNum;
    const sortOrder = sort_order === "desc" ? -1 : 1;

    // Run queries in parallel for faster results
    const [logs, total] = await Promise.all([
      UserActivityLog.find(filter, { request_body: 0 }) // Exclude request_body
        .sort({ [sort_by]: sortOrder })
        .skip(skip)
        .limit(limitNum)
        .lean(),

      UserActivityLog.countDocuments(filter),
    ]);

    res.json({
      logs,
      pagination: {
        current_page: pageNum,
        total_pages: Math.ceil(total / limitNum),
        total_records: total,
        per_page: limitNum,
      },
      tenant_info: {
        tenant_id: req.user.tenant_id,
        organization_name: req.user.organization_name,
      },
    });
  } catch (error) {
    console.error(
      `Error fetching activity logs for tenant ${req.user.tenant_id}:`,
      error
    );
    res.status(500).json({ error: "Failed to fetch activity logs" });
  }
};

// Get activity statistics
const getActivityStats = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    // Use tenant-specific UserActivityLog model
    const UserActivityLog = getUserActivityLogModel(req.orgDb);

    const filter = {};

    if (start_date || end_date) {
      filter.timestamp = {};
      if (start_date) filter.timestamp.$gte = new Date(start_date);
      if (end_date) filter.timestamp.$lte = new Date(end_date);
    }

    // Aggregate statistics
    const stats = await UserActivityLog.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          total_activities: { $sum: 1 },
          unique_users: { $addToSet: "$user_id" },
          actions_breakdown: {
            $push: "$action",
          },
          resources_breakdown: {
            $push: "$resource",
          },
          avg_response_time: { $avg: "$response_time" },
          error_count: {
            $sum: { $cond: [{ $gte: ["$response_status", 400] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          total_activities: 1,
          unique_users_count: { $size: "$unique_users" },
          avg_response_time: { $round: ["$avg_response_time", 2] },
          error_count: 1,
          success_rate: {
            $round: [
              {
                $multiply: [
                  {
                    $divide: [
                      { $subtract: ["$total_activities", "$error_count"] },
                      "$total_activities",
                    ],
                  },
                  100,
                ],
              },
              2,
            ],
          },
        },
      },
    ]);

    // Get action breakdown
    const actionBreakdown = await UserActivityLog.aggregate([
      { $match: filter },
      { $group: { _id: "$action", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // Get resource breakdown
    const resourceBreakdown = await UserActivityLog.aggregate([
      { $match: filter },
      { $group: { _id: "$resource", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // Get daily activity trend for the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const dailyTrend = await UserActivityLog.aggregate([
      {
        $match: {
          timestamp: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.date": 1 } },
    ]);

    res.json({
      summary: stats[0] || {
        total_activities: 0,
        unique_users_count: 0,
        avg_response_time: 0,
        error_count: 0,
        success_rate: 100,
      },
      action_breakdown: actionBreakdown,
      resource_breakdown: resourceBreakdown,
      daily_trend: dailyTrend,
      tenant_info: {
        tenant_id: req.user.tenant_id,
        organization_name: req.user.organization_name,
      },
    });
  } catch (error) {
    console.error(
      `Error fetching activity stats for tenant ${req.user.tenant_id}:`,
      error
    );
    res.status(500).json({ error: "Failed to fetch activity statistics" });
  }
};

// Get user-specific activity summary
const getUserActivitySummary = async (req, res) => {
  try {
    const { user_id } = req.params;
    const { days = 30 } = req.query;

    // Use tenant-specific UserActivityLog model
    const UserActivityLog = getUserActivityLogModel(req.orgDb);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const filter = {
      user_id: user_id,
      timestamp: { $gte: startDate },
    };

    const summary = await UserActivityLog.aggregate([
      { $match: filter },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
            action: "$action",
          },
          count: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: "$_id.date",
          actions: {
            $push: {
              action: "$_id.action",
              count: "$count",
            },
          },
          total_daily: { $sum: "$count" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Get user details
    const userActivities = await UserActivityLog.findOne(
      { user_id: user_id },
      { email: 1, metadata: 1 }
    ).lean();

    res.json({
      user_activity_summary: summary,
      user_info: userActivities
        ? {
            email: userActivities.email,
            organization_name: userActivities.metadata?.organization_name,
          }
        : null,
      tenant_info: {
        tenant_id: req.user.tenant_id,
        organization_name: req.user.organization_name,
      },
    });
  } catch (error) {
    console.error(
      `Error fetching user activity summary for tenant ${req.user.tenant_id}:`,
      error
    );
    res.status(500).json({ error: "Failed to fetch user activity summary" });
  }
};

// Get most active users in the tenant
const getMostActiveUsers = async (req, res) => {
  try {
    const { days = 30, limit = 10 } = req.query;

    // Use tenant-specific UserActivityLog model
    const UserActivityLog = getUserActivityLogModel(req.orgDb);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const mostActiveUsers = await UserActivityLog.aggregate([
      {
        $match: {
          timestamp: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            user_id: "$user_id",
            email: "$email",
          },
          total_activities: { $sum: 1 },
          last_activity: { $max: "$timestamp" },
          actions: { $addToSet: "$action" },
          organization_name: { $first: "$metadata.organization_name" },
        },
      },
      {
        $project: {
          user_id: "$_id.user_id",
          email: "$_id.email",
          total_activities: 1,
          last_activity: 1,
          unique_actions_count: { $size: "$actions" },
          organization_name: 1,
        },
      },
      { $sort: { total_activities: -1 } },
      { $limit: parseInt(limit) },
    ]);

    res.json({
      most_active_users: mostActiveUsers,
      tenant_info: {
        tenant_id: req.user.tenant_id,
        organization_name: req.user.organization_name,
      },
    });
  } catch (error) {
    console.error(
      `Error fetching most active users for tenant ${req.user.tenant_id}:`,
      error
    );
    res.status(500).json({ error: "Failed to fetch most active users" });
  }
};

// Get error logs and failed requests
const getErrorLogs = async (req, res) => {
  try {
    const { days = 7, page = 1, limit = 50 } = req.query;

    // Use tenant-specific UserActivityLog model
    const UserActivityLog = getUserActivityLogModel(req.orgDb);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const filter = {
      timestamp: { $gte: startDate },
      response_status: { $gte: 400 },
    };

    const skip = (page - 1) * limit;

    const errorLogs = await UserActivityLog.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await UserActivityLog.countDocuments(filter);

    // Get error breakdown by status code
    const errorBreakdown = await UserActivityLog.aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$response_status",
          count: { $sum: 1 },
          endpoints: { $addToSet: "$endpoint" },
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.json({
      error_logs: errorLogs,
      error_breakdown: errorBreakdown,
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(total / limit),
        total_records: total,
        per_page: parseInt(limit),
      },
      tenant_info: {
        tenant_id: req.user.tenant_id,
        organization_name: req.user.organization_name,
      },
    });
  } catch (error) {
    console.error(
      `Error fetching error logs for tenant ${req.user.tenant_id}:`,
      error
    );
    res.status(500).json({ error: "Failed to fetch error logs" });
  }
};

// Clean up old logs (for maintenance)
const cleanupOldLogs = async (req, res) => {
  try {
    const { days = 90 } = req.query; // Default: keep logs for 90 days

    // Use tenant-specific UserActivityLog model
    const UserActivityLog = getUserActivityLogModel(req.orgDb);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const result = await UserActivityLog.deleteMany({
      timestamp: { $lt: cutoffDate },
    });

    res.json({
      message: `Cleaned up logs older than ${days} days`,
      deleted_count: result.deletedCount,
      tenant_info: {
        tenant_id: req.user.tenant_id,
        organization_name: req.user.organization_name,
      },
    });
  } catch (error) {
    console.error(
      `Error cleaning up logs for tenant ${req.user.tenant_id}:`,
      error
    );
    res.status(500).json({ error: "Failed to cleanup old logs" });
  }
};

module.exports = {
  getUserActivityLogs,
  getActivityStats,
  getUserActivitySummary,
  getMostActiveUsers,
  getErrorLogs,
  cleanupOldLogs,
};
