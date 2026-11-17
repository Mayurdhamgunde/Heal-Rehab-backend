const { ObjectId } = require("mongoose").Types;
const {
  generateImageSasToken,
  generatepatientImageSasToken,
} = require("../utils/azureutils");
const moment = require("moment-timezone");
const mongoose = require("mongoose");
const { getTherapyPlanModel } = require("../db/therepy");

// --- Date Query Helpers ---
const getDateRange = (
  timeline,
  startDate,
  endDate,
  defaultTimeline = "this_week",
) => {
  const selected = timeline || defaultTimeline;
  let start, end;

  switch (selected) {
    case "today":
      start = moment().startOf("day");
      end = moment().endOf("day");
      break;
    case "this_month":
      start = moment().startOf("month");
      end = moment().endOf("month");
      break;
    case "this_year":
      start = moment().startOf("year");
      end = moment().endOf("year");
      break;
    case "custom":
      start = startDate
        ? moment(startDate).startOf("day")
        : moment().startOf("day");
      end = endDate ? moment(endDate).endOf("day") : moment().endOf("day");
      break;
    case "this_week":
    default:
      start = moment().startOf("isoWeek"); // Monday to Sunday
      end = moment().endOf("isoWeek");
      break;
  }
  return { $gte: start.toDate(), $lte: end.toDate() };
};

const getPreviousDateRange = (
  timeline,
  startDate,
  endDate,
  defaultTimeline = "this_week",
) => {
  const selected = timeline || defaultTimeline;
  let start, end;

  switch (selected) {
    case "today":
      start = moment().subtract(1, "days").startOf("day");
      end = moment().subtract(1, "days").endOf("day");
      break;
    case "this_month":
      start = moment().subtract(1, "months").startOf("month");
      end = moment().subtract(1, "months").endOf("month");
      break;
    case "this_year":
      start = moment().subtract(1, "years").startOf("year");
      end = moment().subtract(1, "years").endOf("year");
      break;
    case "custom":
      const startM = moment(startDate).startOf("day");
      const endM = moment(endDate).endOf("day");
      const duration = endM.diff(startM, "days") + 1;
      start = moment(startM).subtract(duration, "days").startOf("day");
      end = moment(endM).subtract(duration, "days").endOf("day");
      break;
    case "this_week":
    default:
      start = moment().subtract(1, "weeks").startOf("isoWeek");
      end = moment().subtract(1, "weeks").endOf("isoWeek");
      break;
  }
  return { $gte: start.toDate(), $lte: end.toDate() };
};

// --- Time-Series Grouping Helpers ---
// Determines how to bucket the data for the trend line based on the selected timeline
const getTimeSeriesFormat = (timeline, dateField) => {
  if (timeline === "today")
    return { format: "%Y-%m-%d %H:00", date: dateField };
  if (timeline === "this_year") return { format: "%Y-%m", date: dateField };
  return { format: "%Y-%m-%d", date: dateField }; // Default to daily
};

// --- Controllers ---

const getNewPatientsToday = async (req, res) => {
  try {
    const { orgDb } = req;
    const { timeline, startDate, endDate } = req.query;

    const currentQuery = getDateRange(
      timeline,
      startDate,
      endDate,
      "this_week",
    );
    const prevQuery = getPreviousDateRange(
      timeline,
      startDate,
      endDate,
      "this_week",
    );
    const timeGroup = getTimeSeriesFormat(
      timeline,
      "$patient_registration_date",
    );

    // Fetch current count, previous count, and time-series trend concurrently
    const [currentCount, previousCount, timeSeriesData] = await Promise.all([
      orgDb
        .collection("patients")
        .countDocuments({ patient_registration_date: currentQuery }),
      orgDb
        .collection("patients")
        .countDocuments({ patient_registration_date: prevQuery }),
      orgDb
        .collection("patients")
        .aggregate([
          { $match: { patient_registration_date: currentQuery } },
          { $group: { _id: { $dateToString: timeGroup }, val: { $sum: 1 } } },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, name: "$_id", val: 1 } },
        ])
        .toArray(),
    ]);

    // Fetch up to 3 recent patient images
    const patientsWithImages = await orgDb
      .collection("patients")
      .find({
        patient_registration_date: currentQuery,
        patient_image: { $exists: true, $ne: "", $type: "string" },
      })
      .sort({ patient_registration_date: -1 })
      .limit(3)
      .project({ patient_image: 1 })
      .toArray();

    const recentImages = await Promise.all(
      patientsWithImages.map(async (patient) => {
        try {
          return await generatepatientImageSasToken(patient.patient_image);
        } catch (err) {
          return null;
        }
      }),
    );
    const validImages = recentImages.filter((img) => img !== null);

    res.status(200).json({
      success: true,
      count: currentCount,
      previousCount: previousCount,
      timeSeries: timeSeriesData, // New array for stock-market style graph
      recentImages: validImages,
    });
  } catch (error) {
    console.error("Error fetching new patients:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

const getAgeDistribution = async (req, res) => {
  try {
    const { orgDb } = req;
    const { timeline, startDate, endDate } = req.query;
    const dateQuery = getDateRange(timeline, startDate, endDate, "this_week");

    const pipeline = [
      {
        $match: {
          patient_registration_date: dateQuery,
          date_of_birth: { $exists: true, $type: "date" },
          status: { $ne: "Archived" },
        },
      },
      {
        $project: {
          ageInYears: {
            $floor: {
              $divide: [
                { $subtract: [new Date(), "$date_of_birth"] },
                31557600000,
              ],
            },
          },
        },
      },
      {
        $bucket: {
          groupBy: "$ageInYears",
          boundaries: [0, 18, 26, 36, 46, 56],
          default: "56+",
          output: { count: { $sum: 1 } },
        },
      },
    ];

    const distribution = await orgDb
      .collection("patients")
      .aggregate(pipeline)
      .toArray();
    res.status(200).json({ success: true, data: distribution });
  } catch (error) {
    console.error("Error fetching age distribution:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

const getDemographicBreakdown = async (req, res) => {
  try {
    const { orgDb } = req;
    const { timeline, startDate, endDate } = req.query;
    const dateQuery = getDateRange(timeline, startDate, endDate, "this_week");

    const pipeline = [
      {
        $match: {
          status: { $ne: "Archived" },
          patient_registration_date: dateQuery,
        },
      },
      {
        $facet: {
          maritalStatus: [
            {
              $group: {
                _id: { $ifNull: ["$marital_status", "Unknown"] },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
          ],
          occupation: [
            {
              $group: {
                _id: { $ifNull: ["$occupation", "Unknown"] },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
          ],
          education: [
            {
              $group: {
                _id: { $ifNull: ["$education", "Unknown"] },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
          ],
        },
      },
    ];

    const demographics = await orgDb
      .collection("patients")
      .aggregate(pipeline)
      .toArray();
    res.status(200).json({ success: true, data: demographics[0] });
  } catch (error) {
    console.error("Error fetching demographic breakdown:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

const getReferralSourceDistribution = async (req, res) => {
  try {
    const { orgDb } = req;
    const { timeline, startDate, endDate } = req.query;
    const dateQuery = getDateRange(timeline, startDate, endDate, "this_week");

    const pipeline = [
      {
        $match: {
          status: { $ne: "Archived" },
          patient_registration_date: dateQuery,
        },
      },
      {
        $group: {
          _id: { $ifNull: ["$referral_source", "Unknown"] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ];

    const referrals = await orgDb
      .collection("patients")
      .aggregate(pipeline)
      .toArray();
    res.status(200).json({ success: true, data: referrals });
  } catch (error) {
    console.error("Error fetching referral distribution:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

const getGeographicDistribution = async (req, res) => {
  try {
    const { orgDb } = req;
    const { timeline, startDate, endDate } = req.query;
    const dateQuery = getDateRange(timeline, startDate, endDate, "this_week");

    const pipeline = [
      {
        $match: {
          patient_registration_date: dateQuery,
          "address.city": { $exists: true, $ne: "" },
          status: { $ne: "Archived" },
        },
      },
      {
        $group: {
          _id: {
            state: { $toLower: "$address.state" },
            city: { $toLower: "$address.city" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ];

    const geography = await orgDb
      .collection("patients")
      .aggregate(pipeline)
      .toArray();
    const formattedData = geography.map((item) => ({
      state: item._id.state || "Unknown",
      city: item._id.city || "Unknown",
      count: item.count,
    }));

    res.status(200).json({ success: true, data: formattedData });
  } catch (error) {
    console.error("Error fetching geographic distribution:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

const getLocationVsHomeCityCrossTab = async (req, res) => {
  try {
    const { orgDb } = req;
    const { timeline, startDate, endDate } = req.query;
    const dateQuery = getDateRange(timeline, startDate, endDate, "this_week");

    const pipeline = [
      {
        $match: {
          patient_registration_date: dateQuery,
          location_id: { $exists: true, $ne: "" },
          "address.city": { $exists: true, $ne: "" },
          status: { $ne: "Archived" },
        },
      },
      {
        $group: {
          _id: {
            location_id: "$location_id",
            location_name: "$location_name",
            home_city: { $toLower: "$address.city" },
          },
          patient_count: { $sum: 1 },
        },
      },
      { $sort: { "_id.location_id": 1, patient_count: -1 } },
    ];

    const crossTab = await orgDb
      .collection("patients")
      .aggregate(pipeline)
      .toArray();
    const formattedData = crossTab.map((item) => ({
      treatment_location_id: item._id.location_id,
      treatment_location_name: item._id.location_name || "Unknown",
      home_city: item._id.home_city,
      patient_count: item.patient_count,
    }));

    res.status(200).json({ success: true, data: formattedData });
  } catch (error) {
    console.error("Error fetching location vs home city cross tab:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

const getRegistrationsByLocationOverTime = async (req, res) => {
  try {
    const { orgDb } = req;
    const { timeline, startDate, endDate } = req.query;
    const dateQuery = getDateRange(timeline, startDate, endDate, "this_week");

    const pipeline = [
      {
        $match: {
          status: { $ne: "Archived" },
          patient_registration_date: dateQuery,
        },
      },
      {
        $group: {
          _id: {
            location_id: { $ifNull: ["$location_id", "Unassigned"] },
            location_name: { $ifNull: ["$location_name", "Unassigned"] },
            year: { $year: "$patient_registration_date" },
            month: { $month: "$patient_registration_date" },
          },
          new_registrations: { $sum: 1 },
        },
      },
      {
        $sort: { "_id.year": 1, "_id.month": 1, "_id.location_id": 1 },
      },
    ];

    const registrationsOverTime = await orgDb
      .collection("patients")
      .aggregate(pipeline)
      .toArray();
    const formattedData = registrationsOverTime.map((item) => ({
      location_id: item._id.location_id,
      location_name: item._id.location_name,
      period: `${item._id.year}-${String(item._id.month).padStart(2, "0")}`,
      registrations: item.new_registrations,
    }));

    res.status(200).json({ success: true, data: formattedData });
  } catch (error) {
    console.error("Error fetching registrations by location over time:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

const getPlanDropoutMetrics = async (req, res) => {
  try {
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const currentDate = new Date();

    const { timeline, startDate, endDate } = req.query;
    const currentQuery = getDateRange(
      timeline,
      startDate,
      endDate,
      "this_year",
    );
    const prevQuery = getPreviousDateRange(
      timeline,
      startDate,
      endDate,
      "this_year",
    );
    const timeGroup = getTimeSeriesFormat(timeline, "$createdAt");

    // Reusable project stage to ensure uniform field evaluation
    const commonProject = {
      $project: {
        status: 1,
        closure_reason: 1,
        closure_date: 1,
        createdAt: 1,
        therapy_end_date: {
          $dateFromString: {
            dateString: "$therapy_end",
            format: "%Y-%m-%d",
            onError: null,
          },
        },
      },
    };

    // Centralized overall Pipeline factory
    const buildOverallPipeline = (dateMatch) => [
      commonProject,
      { $match: { createdAt: dateMatch } },
      {
        $group: {
          _id: null,
          total_plans: { $sum: 1 },
          completed_on_time: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ["$status", ["Completed", "completed"]] },
                    { $eq: ["$closure_reason", "Completed"] },
                    { $lte: ["$closure_date", "$therapy_end_date"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          completed_incomplete: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ["$status", ["Completed", "completed"]] },
                    { $in: ["$closure_reason", ["Incomplete", "Dropout"]] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          exceeding_plans: {
            $sum: {
              $cond: [
                {
                  $or: [
                    {
                      $and: [
                        { $eq: ["$status", "Active"] },
                        { $gt: [currentDate, "$therapy_end_date"] },
                      ],
                    },
                    {
                      $and: [
                        { $in: ["$status", ["Completed", "completed"]] },
                        { $gt: ["$closure_date", "$therapy_end_date"] },
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          total_plans: 1,
          completed_on_time: 1,
          completed_incomplete: 1,
          exceeding_plans: 1,
          on_time_percentage: {
            $cond: [
              { $gt: ["$total_plans", 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ["$completed_on_time", "$total_plans"] },
                      100,
                    ],
                  },
                  2,
                ],
              },
              0,
            ],
          },
          dropout_percentage: {
            $cond: [
              { $gt: ["$total_plans", 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ["$completed_incomplete", "$total_plans"] },
                      100,
                    ],
                  },
                  2,
                ],
              },
              0,
            ],
          },
        },
      },
    ];

    // Pipeline specifically built to generate the timeline arrays for the sparklines
    const timeSeriesPipeline = [
      commonProject,
      { $match: { createdAt: currentQuery } },
      {
        $group: {
          _id: { $dateToString: timeGroup },
          total_plans: { $sum: 1 },
          completed_on_time: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ["$status", ["Completed", "completed"]] },
                    { $eq: ["$closure_reason", "Completed"] },
                    { $lte: ["$closure_date", "$therapy_end_date"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          completed_incomplete: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ["$status", ["Completed", "completed"]] },
                    { $in: ["$closure_reason", ["Incomplete", "Dropout"]] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          name: "$_id",
          on_time_percentage: {
            $cond: [
              { $gt: ["$total_plans", 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ["$completed_on_time", "$total_plans"] },
                      100,
                    ],
                  },
                  2,
                ],
              },
              0,
            ],
          },
          dropout_percentage: {
            $cond: [
              { $gt: ["$total_plans", 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ["$completed_incomplete", "$total_plans"] },
                      100,
                    ],
                  },
                  2,
                ],
              },
              0,
            ],
          },
        },
      },
    ];

    // Fetch pipelines concurrently
    const [currentMetrics, prevMetrics, timeSeriesData] = await Promise.all([
      TherapyPlan.aggregate(buildOverallPipeline(currentQuery)),
      TherapyPlan.aggregate(buildOverallPipeline(prevQuery)),
      TherapyPlan.aggregate(timeSeriesPipeline),
    ]);

    const defaultMetrics = {
      total_plans: 0,
      completed_on_time: 0,
      completed_incomplete: 0,
      exceeding_plans: 0,
      on_time_percentage: 0,
      dropout_percentage: 0,
    };

    const currentResult = currentMetrics[0] || defaultMetrics;
    const prevResult = prevMetrics[0] || defaultMetrics;

    res.status(200).json({
      success: true,
      data: currentResult,
      previousData: prevResult,
      timeSeries: timeSeriesData, // Passed to frontend for proper charting
    });
  } catch (error) {
    console.error("Error fetching plan dropout metrics:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

module.exports = {
  getNewPatientsToday,
  getAgeDistribution,
  getDemographicBreakdown,
  getReferralSourceDistribution,
  getGeographicDistribution,
  getLocationVsHomeCityCrossTab,
  getRegistrationsByLocationOverTime,
  getPlanDropoutMetrics,
};
