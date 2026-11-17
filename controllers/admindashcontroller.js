const { ObjectId } = require("mongoose").Types;
const { generateImageSasToken } = require("../utils/azureutils");
const moment = require("moment-timezone");
const mongoose = require("mongoose");

const calculateDateRangeHelper = (month, year, startDate, endDate) => {
  let dateFilter = {};
  let periodLabel = "All Time";

  if (startDate || endDate) {
    const customFilter = {};

    if (startDate) {
      const startDateObj = new Date(startDate);
      if (isNaN(startDateObj.getTime())) {
        throw new Error("Invalid startDate format. Use YYYY-MM-DD format");
      }
      customFilter.$gte = startDate;
    }

    if (endDate) {
      const endDateObj = new Date(endDate);
      if (isNaN(endDateObj.getTime())) {
        throw new Error("Invalid endDate format. Use YYYY-MM-DD format");
      }
      customFilter.$lte = endDate;
    }

    if (startDate && endDate) {
      const startDateObj = new Date(startDate);
      const endDateObj = new Date(endDate);
      if (startDateObj > endDateObj) {
        throw new Error("startDate must be before or equal to endDate");
      }
      periodLabel = `${startDate} to ${endDate}`;
    } else if (startDate) {
      periodLabel = `From ${startDate}`;
    } else if (endDate) {
      periodLabel = `Until ${endDate}`;
    }

    return { dateFilter: customFilter, periodLabel };
  }

  if (month && year) {
    const monthNum = parseInt(month);
    const yearNum = parseInt(year);

    if (isNaN(monthNum) || isNaN(yearNum) || monthNum < 1 || monthNum > 12) {
      throw new Error(
        "Month must be between 1-12 and year must be a valid number",
      );
    }

    const startDateObj = new Date(Date.UTC(yearNum, monthNum - 1, 1));
    const endDateObj = new Date(Date.UTC(yearNum, monthNum, 0));

    const startDateStr = startDateObj.toISOString().split("T")[0];
    const endDateStr = endDateObj.toISOString().split("T")[0];

    dateFilter = {
      $gte: startDateStr,
      $lte: endDateStr,
    };

    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    periodLabel = `${monthNames[monthNum - 1]} ${yearNum}`;

    return { dateFilter, periodLabel };
  }

  return { dateFilter: {}, periodLabel };
};

const getDailyReportDashboard = async (req, res) => {
  try {
    const { orgDb } = req;
    const { location_id, startDate, endDate, date } = req.query;

    // Determine the date to query
    let queryDate;
    if (date) {
      queryDate = date;
    } else if (startDate && !endDate) {
      queryDate = startDate;
    } else if (!startDate && !endDate) {
      // Default to today
      const today = new Date();
      queryDate = today.toISOString().split("T")[0];
    }

    // Build query
    const query = {};

    if (queryDate) {
      query.therepy_date = queryDate;
    } else if (startDate && endDate) {
      // Date range query
      if (new Date(startDate) > new Date(endDate)) {
        return res.status(400).json({
          success: false,
          error: "startDate must be before or equal to endDate",
        });
      }
      query.therepy_date = {
        $gte: startDate,
        $lte: endDate,
      };
    }

    if (location_id) {
      query.location_id = location_id;
    }

    // Fetch all doctors
    const doctors = await orgDb.collection("doctors").find({}).toArray();

    // Process each doctor to get appointments
    const dashboardData = await Promise.all(
      doctors.map(async (doctor) => {
        const appointmentQuery = {
          ...query,
          doctor_id: new ObjectId(doctor._id),
        };

        const appointments = await orgDb
          .collection("therepys")
          .find(appointmentQuery)
          .toArray();

        let doctorPhoto = null;
        if (doctor.doctors_photo) {
          doctorPhoto = await generateImageSasToken(doctor.doctors_photo);
        }

        const appointmentTimings = appointments.map((appointment) => ({
          start_time: appointment.therepy_start_time,
          end_time: appointment.therepy_end_time,
          patient_name: appointment.patient_name,
          therapy_type: appointment.therepy_type,
          location_name: appointment.location_name,
          date: appointment.therepy_date,
        }));

        return {
          doctor_id: doctor._id,
          doctor_name: `${doctor.doctor_first_name} ${doctor.doctor_last_name}`,
          doctor_photo: doctorPhoto,
          appointment_count: appointments.length,
          appointment_timings: appointmentTimings,
        };
      }),
    );

    // Filter out doctors with no appointments if location filter is applied
    const filteredData =
      location_id || startDate || endDate
        ? dashboardData.filter((doctor) => doctor.appointment_count > 0)
        : dashboardData;

    res.status(200).json({
      success: true,
      filters: {
        date: queryDate || null,
        startDate: startDate || null,
        endDate: endDate || null,
        location_id: location_id || null,
      },
      data: filteredData,
    });
  } catch (error) {
    console.error("Error fetching daily report dashboard data:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
};
const getTherapyClosureReport = async (req, res) => {
  try {
    const {
      month,
      year,
      startDate,
      endDate,
      doctor_id,
      location_id,
      therapy_category,
      min_amount,
      max_amount,
    } = req.query;

    // 1. Determine Date Range & Period Label
    let queryStartDate, queryEndDate, periodLabel;

    if (startDate || endDate) {
      // Custom Range
      queryStartDate = startDate ? new Date(startDate) : new Date("1970-01-01");
      queryEndDate = endDate ? new Date(endDate) : new Date();
      queryEndDate.setHours(23, 59, 59, 999);
      periodLabel = `Custom Range: ${startDate || "Start"} to ${endDate || "Now"}`;
    } else if (month && year) {
      // Monthly Report
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);
      queryStartDate = new Date(Date.UTC(yearNum, monthNum - 1, 1));
      queryEndDate = new Date(Date.UTC(yearNum, monthNum, 0, 23, 59, 59, 999));

      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      periodLabel = `${monthNames[monthNum - 1]} ${yearNum}`;
    } else {
      // Default to Current Month
      const now = new Date();
      queryStartDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
      queryEndDate = new Date(
        Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
      );
      periodLabel = `Current Month (${now.toLocaleString("default", { month: "long" })})`;
    }

    // 2. Build Aggregation Match Stage
    const matchStage = {
      // Strictly match completed plans
      status: { $in: ["Completed", "completed"] },
      // Filter by Closure Date
      closure_date: {
        $gte: queryStartDate,
        $lte: queryEndDate,
      },
    };

    // Apply Filters
    if (doctor_id) {
      // Match if the doctor either started OR completed the plan
      matchStage.$or = [
        { closed_by: new ObjectId(doctor_id) },
        { created_by: new ObjectId(doctor_id) },
      ];
    }

    if (location_id) {
      matchStage.location_id = location_id;
    }

    if (therapy_category) {
      matchStage.patient_therapy_category = {
        $regex: therapy_category,
        $options: "i",
      };
    }

    // Amount Filtering
    if (min_amount || max_amount) {
      matchStage.$expr = matchStage.$expr || { $and: [] };
      const amountField = { $ifNull: ["$final_total_amount", "$total_amount"] };

      if (min_amount) {
        matchStage.$expr.$and.push({
          $gte: [{ $toDouble: amountField }, parseFloat(min_amount)],
        });
      }
      if (max_amount) {
        matchStage.$expr.$and.push({
          $lte: [{ $toDouble: amountField }, parseFloat(max_amount)],
        });
      }
    }

    // 3. Optimized Pipeline
    const pipeline = [
      { $match: matchStage },

      // Lookup 1: Patient Details
      {
        $lookup: {
          from: "patients",
          let: { planId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $in: ["$$planId", { $ifNull: ["$therapy_plans", []] }],
                },
              },
            },
            {
              $project: {
                patient_first_name: 1,
                patient_last_name: 1,
                patient_phone: 1,
              },
            },
          ],
          as: "patient_doc",
        },
      },

      // Lookup 2: Creator Details (Started By)
      {
        $lookup: {
          from: "doctors",
          localField: "created_by",
          foreignField: "_id",
          pipeline: [
            { $project: { doctor_first_name: 1, doctor_last_name: 1 } },
          ],
          as: "creator_doc",
        },
      },

      // Lookup 3: Closer Details (Completed By)
      {
        $lookup: {
          from: "doctors",
          localField: "closed_by",
          foreignField: "_id",
          pipeline: [
            { $project: { doctor_first_name: 1, doctor_last_name: 1 } },
          ],
          as: "closer_doc",
        },
      },

      // Flatten & Project
      {
        $project: {
          _id: 1,
          therapy_start: 1, // <--- ADDED HERE: ensure it's fetched from the DB
          closure_date: 1,
          therapy_name: 1,
          patient_therapy_category: 1,
          closure_reason: 1,
          treatment_outcome: 1,

          // Patient Info
          patient_name: {
            $concat: [
              {
                $ifNull: [
                  { $arrayElemAt: ["$patient_doc.patient_first_name", 0] },
                  "Unknown",
                ],
              },
              " ",
              {
                $ifNull: [
                  { $arrayElemAt: ["$patient_doc.patient_last_name", 0] },
                  "Patient",
                ],
              },
            ],
          },
          patient_phone: {
            $ifNull: [
              { $arrayElemAt: ["$patient_doc.patient_phone", 0] },
              "N/A",
            ],
          },

          // Doctor 1: Started By
          started_by_doctor: {
            $concat: [
              {
                $ifNull: [
                  { $arrayElemAt: ["$creator_doc.doctor_first_name", 0] },
                  "Unknown",
                ],
              },
              " ",
              {
                $ifNull: [
                  { $arrayElemAt: ["$creator_doc.doctor_last_name", 0] },
                  "Doctor",
                ],
              },
            ],
          },

          // Doctor 2: Completed By
          completed_by_doctor: {
            $concat: [
              {
                $ifNull: [
                  { $arrayElemAt: ["$closer_doc.doctor_first_name", 0] },
                  "Unknown",
                ],
              },
              " ",
              {
                $ifNull: [
                  { $arrayElemAt: ["$closer_doc.doctor_last_name", 0] },
                  "Doctor",
                ],
              },
            ],
          },

          // Financial Snapshots
          total_amount: {
            $toDouble: { $ifNull: ["$final_total_amount", "$total_amount"] },
          },
          received_amount: {
            $toDouble: {
              $ifNull: ["$final_received_amount", "$received_amount"],
            },
          },
          balance: { $toDouble: { $ifNull: ["$final_balance", "$balance"] } },

          // Session Stats
          completed_sessions: {
            $ifNull: ["$final_completed_sessions", "$completed_sessions"],
          },
          estimated_sessions: "$estimated_sessions",
        },
      },

      { $sort: { closure_date: -1 } },
    ];

    const completedPlans = await req.orgDb
      .collection("plans")
      .aggregate(pipeline)
      .toArray();

    // 4. Calculate Summary & Format Data
    let grandTotal = 0;
    let grandReceived = 0;
    let grandBalance = 0;

    const formattedData = completedPlans.map((plan) => {
      const total = plan.total_amount || 0;
      const received = plan.received_amount || 0;
      const balance = plan.balance || 0;

      grandTotal += total;
      grandReceived += received;
      grandBalance += balance;

      return {
        plan_id: plan._id,
        // ---> ADDED HERE: Safely formatting the start date
        therapy_start: plan.therapy_start
          ? new Date(plan.therapy_start).toISOString().split("T")[0]
          : "N/A",
        closure_date: plan.closure_date
          ? new Date(plan.closure_date).toISOString().split("T")[0]
          : "N/A",

        // Two separate doctor names
        started_by_doctor: plan.started_by_doctor,
        completed_by_doctor: plan.completed_by_doctor,

        patient_name: plan.patient_name,
        patient_phone: plan.patient_phone,
        therapy_name: plan.therapy_name || "N/A",
        category: plan.patient_therapy_category || "N/A",
        sessions_completed: plan.completed_sessions || 0,
        sessions_estimated: plan.estimated_sessions || 0,
        sessions_formatted: `${plan.completed_sessions || 0} / ${plan.estimated_sessions || 0}`,
        total_amount: total,
        received_amount: received,
        balance: balance,
        outcome: plan.treatment_outcome || "N/A",
        reason: plan.closure_reason || "N/A",
      };
    });

    // 5. Send JSON Response
    return res.status(200).json({
      success: true,
      message: "Therapy closure report retrieved successfully",
      period: periodLabel,
      generated_at: new Date().toISOString(),
      filters_applied: req.query,
      summary: {
        total_records: formattedData.length,
        total_amount: parseFloat(grandTotal.toFixed(2)),
        total_received: parseFloat(grandReceived.toFixed(2)),
        total_balance: parseFloat(grandBalance.toFixed(2)),
      },
      data: formattedData,
    });
  } catch (error) {
    console.error("Error generating therapy closure report:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};
const exportTherapyClosureReportToPDF = async (req, res) => {
  try {
    const {
      month,
      year,
      startDate,
      endDate,
      doctor_id,
      location_id,
      therapy_category,
    } = req.query;

    // 1. Determine Date Range
    let queryStartDate, queryEndDate, periodLabel;
    if (startDate || endDate) {
      queryStartDate = startDate ? new Date(startDate) : new Date("1970-01-01");
      queryEndDate = endDate ? new Date(endDate) : new Date();
      queryEndDate.setHours(23, 59, 59, 999);
      periodLabel = `Custom Range: ${startDate || "Start"} to ${endDate || "Now"}`;
    } else if (month && year) {
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);
      queryStartDate = new Date(Date.UTC(yearNum, monthNum - 1, 1));
      queryEndDate = new Date(Date.UTC(yearNum, monthNum, 0, 23, 59, 59, 999));
      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      periodLabel = `${monthNames[monthNum - 1]} ${yearNum}`;
    } else {
      const now = new Date();
      queryStartDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
      queryEndDate = new Date(
        Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
      );
      periodLabel = `Current Month (${now.toLocaleString("default", { month: "long" })})`;
    }

    // 2. Build Aggregation Match Stage
    const matchStage = {
      status: { $in: ["Completed", "completed"] },
      closure_date: { $gte: queryStartDate, $lte: queryEndDate },
    };

    if (doctor_id) {
      matchStage.$or = [
        { closed_by: new ObjectId(doctor_id) },
        { created_by: new ObjectId(doctor_id) },
      ];
    }
    if (location_id) matchStage.location_id = location_id;
    if (therapy_category) {
      matchStage.patient_therapy_category = {
        $regex: therapy_category,
        $options: "i",
      };
    }

    // 3. Pipeline
    const pipeline = [
      { $match: matchStage },
      {
        $lookup: {
          from: "patients",
          let: { planId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $in: ["$$planId", { $ifNull: ["$therapy_plans", []] }],
                },
              },
            },
            { $project: { patient_first_name: 1, patient_last_name: 1 } },
          ],
          as: "patient_doc",
        },
      },
      {
        $lookup: {
          from: "doctors",
          localField: "created_by",
          foreignField: "_id",
          pipeline: [
            { $project: { doctor_first_name: 1, doctor_last_name: 1 } },
          ],
          as: "creator_doc",
        },
      },
      {
        $lookup: {
          from: "doctors",
          localField: "closed_by",
          foreignField: "_id",
          pipeline: [
            { $project: { doctor_first_name: 1, doctor_last_name: 1 } },
          ],
          as: "closer_doc",
        },
      },
      {
        $project: {
          _id: 1,
          therapy_start: 1,
          closure_date: 1,
          therapy_name: 1,
          patient_therapy_category: 1,
          closure_reason: 1,
          treatment_outcome: 1,
          patient_name: {
            $concat: [
              {
                $ifNull: [
                  { $arrayElemAt: ["$patient_doc.patient_first_name", 0] },
                  "Unknown",
                ],
              },
              " ",
              {
                $ifNull: [
                  { $arrayElemAt: ["$patient_doc.patient_last_name", 0] },
                  "Patient",
                ],
              },
            ],
          },
          started_by_doctor: {
            $concat: [
              {
                $ifNull: [
                  { $arrayElemAt: ["$creator_doc.doctor_first_name", 0] },
                  "Unknown",
                ],
              },
              " ",
              {
                $ifNull: [
                  { $arrayElemAt: ["$creator_doc.doctor_last_name", 0] },
                  "Doctor",
                ],
              },
            ],
          },
          completed_by_doctor: {
            $concat: [
              {
                $ifNull: [
                  { $arrayElemAt: ["$closer_doc.doctor_first_name", 0] },
                  "Unknown",
                ],
              },
              " ",
              {
                $ifNull: [
                  { $arrayElemAt: ["$closer_doc.doctor_last_name", 0] },
                  "Doctor",
                ],
              },
            ],
          },
        },
      },
      { $sort: { closure_date: -1 } },
    ];

    const completedPlans = await req.orgDb
      .collection("plans")
      .aggregate(pipeline)
      .toArray();

    // 4. Summarize & Format
    const formattedData = completedPlans.map((plan) => {
      return {
        patient_name: plan.patient_name,
        therapy_start: plan.therapy_start
          ? new Date(plan.therapy_start).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })
          : "N/A",
        closure_date: plan.closure_date
          ? new Date(plan.closure_date).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })
          : "N/A",
        started_by_doctor: plan.started_by_doctor,
        completed_by_doctor: plan.completed_by_doctor,
        therapy_name: plan.therapy_name || "N/A",
        category: plan.patient_therapy_category || "N/A",
        outcome: plan.treatment_outcome || "N/A",
        reason: plan.closure_reason || "N/A",
      };
    });

    // 5. Build PDF
    const doc = new PDFDocument({
      margin: 30,
      size: "A4",
      layout: "landscape",
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=therapy_closure_report_${new Date().toISOString().split("T")[0]}.pdf`,
    );
    doc.pipe(res);

    // Title
    doc
      .fontSize(20)
      .fillColor("#007B8E")
      .text("Therapy Closure Report", { align: "center" });
    doc
      .fontSize(10)
      .fillColor("#555555")
      .text(`Period: ${periodLabel}`, { align: "center" });
    doc.moveDown(1);

    // ─── Column Layout (left to right, A4 landscape = ~842px, margin 30 each side → 782px usable) ───
    //
    // Col         Width   X (cumulative from 30)
    // Patient      100    30
    // Start Date    65    130
    // End Date      65    195
    // Started By    80    260
    // Closed By     80    340
    // Plan Name     90    420
    // Category      65    510
    // Outcome       60    575
    // Reason       (remaining) 635

    const MARGIN_LEFT = 30;
    const cols = {
      patient: { x: 30, w: 100 },
      startDate: { x: 130, w: 65 },
      closeDate: { x: 195, w: 65 },
      startedBy: { x: 260, w: 80 },
      completedBy: { x: 340, w: 80 },
      therapy: { x: 420, w: 90 },
      category: { x: 510, w: 65 },
      outcome: { x: 575, w: 60 },
      reason: { x: 635, w: 140 },
    };

    const drawHeaders = (y) => {
      doc.fontSize(8).fillColor("#007B8E");
      doc.text("Patient Name", cols.patient.x, y, { width: cols.patient.w });
      doc.text("Start Date", cols.startDate.x, y, { width: cols.startDate.w });
      doc.text("End Date", cols.closeDate.x, y, { width: cols.closeDate.w });
      doc.text("Started By", cols.startedBy.x, y, { width: cols.startedBy.w });
      doc.text("Closed By", cols.completedBy.x, y, {
        width: cols.completedBy.w,
      });
      doc.text("Plan Name", cols.therapy.x, y, { width: cols.therapy.w });
      doc.text("Category", cols.category.x, y, { width: cols.category.w });
      doc.text("Outcome", cols.outcome.x, y, { width: cols.outcome.w });
      doc.text("Reason", cols.reason.x, y, { width: cols.reason.w });
      doc
        .moveTo(MARGIN_LEFT, y + 13)
        .lineTo(775, y + 13)
        .stroke("#007B8E");
    };

    const tableTop = doc.y;
    drawHeaders(tableTop);

    doc.fontSize(7).fillColor("#000000");
    let yPosition = tableTop + 20;

    for (const record of formattedData) {
      if (yPosition > 520) {
        doc.addPage();
        yPosition = 50;
        drawHeaders(yPosition);
        yPosition += 20;
        doc.fontSize(7).fillColor("#000000");
      }

      doc.text(record.patient_name, cols.patient.x, yPosition, {
        width: cols.patient.w,
        ellipsis: true,
      });
      doc.text(record.therapy_start, cols.startDate.x, yPosition, {
        width: cols.startDate.w,
      });
      doc.text(record.closure_date, cols.closeDate.x, yPosition, {
        width: cols.closeDate.w,
      });
      doc.text(record.started_by_doctor, cols.startedBy.x, yPosition, {
        width: cols.startedBy.w,
        ellipsis: true,
      });
      doc.text(record.completed_by_doctor, cols.completedBy.x, yPosition, {
        width: cols.completedBy.w,
        ellipsis: true,
      });
      doc.text(record.therapy_name, cols.therapy.x, yPosition, {
        width: cols.therapy.w,
        ellipsis: true,
      });
      doc.text(record.category, cols.category.x, yPosition, {
        width: cols.category.w,
        ellipsis: true,
      });
      doc.text(record.outcome, cols.outcome.x, yPosition, {
        width: cols.outcome.w,
        ellipsis: true,
      });
      doc.text(record.reason, cols.reason.x, yPosition, {
        width: cols.reason.w,
        ellipsis: true,
      });

      yPosition += 20;
    }

    doc.end();
  } catch (error) {
    console.error("Error generating PDF:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error generating PDF file" });
  }
};

const exportTherapyClosureReportToExcel = async (req, res) => {
  try {
    const {
      month,
      year,
      startDate,
      endDate,
      doctor_id,
      location_id,
      therapy_category,
    } = req.query;

    // 1. Determine Date Range (Same logic as PDF)
    let queryStartDate, queryEndDate;
    if (startDate || endDate) {
      queryStartDate = startDate ? new Date(startDate) : new Date("1970-01-01");
      queryEndDate = endDate ? new Date(endDate) : new Date();
      queryEndDate.setHours(23, 59, 59, 999);
    } else if (month && year) {
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);
      queryStartDate = new Date(Date.UTC(yearNum, monthNum - 1, 1));
      queryEndDate = new Date(Date.UTC(yearNum, monthNum, 0, 23, 59, 59, 999));
    } else {
      const now = new Date();
      queryStartDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
      queryEndDate = new Date(
        Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
      );
    }

    const matchStage = {
      status: { $in: ["Completed", "completed"] },
      closure_date: { $gte: queryStartDate, $lte: queryEndDate },
    };

    if (doctor_id) {
      matchStage.$or = [
        { closed_by: new ObjectId(doctor_id) },
        { created_by: new ObjectId(doctor_id) },
      ];
    }
    if (location_id) matchStage.location_id = location_id;
    if (therapy_category)
      matchStage.patient_therapy_category = {
        $regex: therapy_category,
        $options: "i",
      };

    const pipeline = [
      { $match: matchStage },
      {
        $lookup: {
          from: "patients",
          let: { planId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $in: ["$$planId", { $ifNull: ["$therapy_plans", []] }],
                },
              },
            },
            {
              $project: {
                patient_first_name: 1,
                patient_last_name: 1,
                patient_phone: 1,
              },
            },
          ],
          as: "patient_doc",
        },
      },
      {
        $lookup: {
          from: "doctors",
          localField: "created_by",
          foreignField: "_id",
          pipeline: [
            { $project: { doctor_first_name: 1, doctor_last_name: 1 } },
          ],
          as: "creator_doc",
        },
      },
      {
        $lookup: {
          from: "doctors",
          localField: "closed_by",
          foreignField: "_id",
          pipeline: [
            { $project: { doctor_first_name: 1, doctor_last_name: 1 } },
          ],
          as: "closer_doc",
        },
      },
      {
        $project: {
          _id: 1,
          therapy_start: 1, // <--- Fetched from DB
          closure_date: 1,
          therapy_name: 1,
          patient_therapy_category: 1,
          closure_reason: 1,
          treatment_outcome: 1,
          patient_name: {
            $concat: [
              {
                $ifNull: [
                  { $arrayElemAt: ["$patient_doc.patient_first_name", 0] },
                  "Unknown",
                ],
              },
              " ",
              {
                $ifNull: [
                  { $arrayElemAt: ["$patient_doc.patient_last_name", 0] },
                  "Patient",
                ],
              },
            ],
          },
          patient_phone: {
            $ifNull: [
              { $arrayElemAt: ["$patient_doc.patient_phone", 0] },
              "N/A",
            ],
          },
          started_by_doctor: {
            $concat: [
              {
                $ifNull: [
                  { $arrayElemAt: ["$creator_doc.doctor_first_name", 0] },
                  "Unknown",
                ],
              },
              " ",
              {
                $ifNull: [
                  { $arrayElemAt: ["$creator_doc.doctor_last_name", 0] },
                  "Doctor",
                ],
              },
            ],
          },
          completed_by_doctor: {
            $concat: [
              {
                $ifNull: [
                  { $arrayElemAt: ["$closer_doc.doctor_first_name", 0] },
                  "Unknown",
                ],
              },
              " ",
              {
                $ifNull: [
                  { $arrayElemAt: ["$closer_doc.doctor_last_name", 0] },
                  "Doctor",
                ],
              },
            ],
          },
        },
      },
      { $sort: { closure_date: -1 } },
    ];

    const completedPlans = await req.orgDb
      .collection("plans")
      .aggregate(pipeline)
      .toArray();

    // 4. Excel Setup
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Therapy Closure Report");

    // ADDED NEW COLUMN FOR START DATE HERE
    worksheet.columns = [
      { header: "Patient Name", key: "patient_name", width: 20 },
      { header: "Start Date", key: "therapy_start", width: 15 },
      { header: "End Date", key: "closure_date", width: 15 },
      { header: "Started By", key: "started_by", width: 20 },
      { header: "Completed By", key: "completed_by", width: 20 },
      { header: "Plan Name", key: "therapy_name", width: 25 },
      { header: "Category", key: "category", width: 18 },
      { header: "Outcome", key: "outcome", width: 20 },
      { header: "Reason", key: "reason", width: 30 },
    ];

    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF007B8E" },
    };

    let grandTotal = 0;
    let grandBalance = 0;

    completedPlans.forEach((plan) => {
      grandTotal += plan.total_amount || 0;
      grandBalance += plan.balance || 0;

      worksheet.addRow({
        // Map the Start Date to row data
        patient_name: plan.patient_name,
        therapy_start: plan.therapy_start
          ? new Date(plan.therapy_start).toLocaleDateString("en-IN")
          : "N/A",
        closure_date: plan.closure_date
          ? new Date(plan.closure_date).toLocaleDateString("en-IN")
          : "N/A",
        started_by: plan.started_by_doctor,
        completed_by: plan.completed_by_doctor,
        therapy_name: plan.therapy_name || "N/A",
        category: plan.patient_therapy_category || "N/A",
        outcome: plan.treatment_outcome || "N/A",
        reason: plan.closure_reason || "N/A",
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=therapy_closure_report_${new Date().toISOString().split("T")[0]}.xlsx`,
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error exporting to Excel:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error generating Excel" });
  }
};

const getMonthlyReferralDashboard = async (req, res) => {
  try {
    const { orgDb } = req;
    const { month, year, startDate, endDate } = req.query;

    let queryStartDate, queryEndDate, periodLabel;

    // Custom date range takes priority
    if (startDate || endDate) {
      if (startDate) {
        queryStartDate = new Date(startDate);
        if (isNaN(queryStartDate.getTime())) {
          return res.status(400).json({
            success: false,
            error: "Invalid startDate format. Use YYYY-MM-DD format",
          });
        }
      } else {
        queryStartDate = new Date("1970-01-01");
      }

      if (endDate) {
        queryEndDate = new Date(endDate);
        queryEndDate.setHours(23, 59, 59, 999);
        if (isNaN(queryEndDate.getTime())) {
          return res.status(400).json({
            success: false,
            error: "Invalid endDate format. Use YYYY-MM-DD format",
          });
        }
      } else {
        queryEndDate = new Date();
      }

      if (queryStartDate > queryEndDate) {
        return res.status(400).json({
          success: false,
          error: "startDate must be before or equal to endDate",
        });
      }

      periodLabel =
        startDate && endDate
          ? `${startDate} to ${endDate}`
          : startDate
            ? `From ${startDate}`
            : `Until ${endDate}`;
    } else if (month && year) {
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);

      if (isNaN(monthNum) || isNaN(yearNum) || monthNum < 1 || monthNum > 12) {
        return res.status(400).json({
          success: false,
          error: "Month must be between 1-12 and year must be a valid number",
        });
      }

      queryStartDate = new Date(Date.UTC(yearNum, monthNum - 1, 1));
      queryEndDate = new Date(Date.UTC(yearNum, monthNum, 1));

      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      periodLabel = `${monthNames[monthNum - 1]} ${yearNum}`;
    } else {
      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();
      queryStartDate = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
      queryEndDate = new Date(Date.UTC(currentYear, currentMonth, 1));

      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      periodLabel = `${monthNames[currentMonth - 1]} ${currentYear}`;
    }

    // Optimized pipeline
    const pipeline = [
      {
        // Filter first to reduce documents early in pipeline
        $match: {
          patient_registration_date: {
            $gte: queryStartDate,
            $lt: queryEndDate,
          },
        },
      },
      {
        // Project only needed fields to reduce memory usage
        $project: {
          _id: 1,
          referral_source: 1,
          patient_first_name: 1,
          patient_last_name: 1,
          patient_email: 1,
          patient_phone: 1,
          patient_registration_date: 1,
          doctor_name: 1,
          referral_details: 1,
        },
      },
      {
        $group: {
          _id: "$referral_source",
          referralCount: { $sum: 1 },
          patients: {
            $push: {
              patient_id: "$_id",
              patient_name: {
                $concat: ["$patient_first_name", " ", "$patient_last_name"],
              },
              patient_email: "$patient_email",
              patient_phone: "$patient_phone",
              registration_date: "$patient_registration_date",
              doctor_name: "$doctor_name",
              referral_details: "$referral_details",
            },
          },
        },
      },
      {
        $sort: { referralCount: -1 },
      },
    ];

    const referralData = await orgDb
      .collection("patients")
      .aggregate(pipeline)
      .toArray();

    // Calculate total referrals more efficiently
    const totalReferrals = referralData.reduce(
      (acc, group) => acc + group.referralCount,
      0,
    );

    res.status(200).json({
      success: true,
      period: periodLabel,
      filters: {
        month: month || null,
        year: year || null,
        startDate: startDate || null,
        endDate: endDate || null,
      },
      totalReferrals,
      referralDetails: referralData,
    });
  } catch (error) {
    console.error("Error fetching monthly referral dashboard data:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
};

// controllers/referralDetailsController.js
const getMonthlyReferralDetailsCount = async (req, res) => {
  try {
    const { orgDb } = req;
    const { month, year, startDate, endDate } = req.query;

    let queryStartDate, queryEndDate, periodLabel;

    // Custom date range takes priority
    if (startDate || endDate) {
      if (startDate) {
        queryStartDate = new Date(startDate);
        if (isNaN(queryStartDate.getTime())) {
          return res.status(400).json({
            success: false,
            error: "Invalid startDate format. Use YYYY-MM-DD format",
          });
        }
      } else {
        queryStartDate = new Date("1970-01-01");
      }

      if (endDate) {
        queryEndDate = new Date(endDate);
        queryEndDate.setHours(23, 59, 59, 999);
        if (isNaN(queryEndDate.getTime())) {
          return res.status(400).json({
            success: false,
            error: "Invalid endDate format. Use YYYY-MM-DD format",
          });
        }
      } else {
        queryEndDate = new Date();
      }

      if (queryStartDate > queryEndDate) {
        return res.status(400).json({
          success: false,
          error: "startDate must be before or equal to endDate",
        });
      }

      periodLabel =
        startDate && endDate
          ? `${startDate} to ${endDate}`
          : startDate
            ? `From ${startDate}`
            : `Until ${endDate}`;
    } else if (month && year) {
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);

      if (isNaN(monthNum) || isNaN(yearNum) || monthNum < 1 || monthNum > 12) {
        return res.status(400).json({
          success: false,
          error: "Month must be between 1-12 and year must be a valid number",
        });
      }

      queryStartDate = new Date(Date.UTC(yearNum, monthNum - 1, 1));
      queryEndDate = new Date(Date.UTC(yearNum, monthNum, 1));

      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      periodLabel = `${monthNames[monthNum - 1]} ${yearNum}`;
    } else {
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();
      queryStartDate = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
      queryEndDate = new Date(Date.UTC(currentYear, currentMonth, 1));

      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      periodLabel = `${monthNames[currentMonth - 1]} ${currentYear}`;
    }

    const pipeline = [
      {
        $addFields: {
          regDate: { $toDate: "$patient_registration_date" },
        },
      },
      {
        $match: {
          regDate: {
            $gte: queryStartDate,
            $lt: queryEndDate,
          },
          referral_details: { $ne: "" },
        },
      },
      {
        $group: {
          _id: "$referral_details",
          count: { $sum: 1 },
        },
      },
      {
        $sort: { count: -1 },
      },
    ];

    const referralDetailsCount = await orgDb
      .collection("patients")
      .aggregate(pipeline)
      .toArray();

    res.status(200).json({
      success: true,
      period: periodLabel,
      filters: {
        month: month || null,
        year: year || null,
        startDate: startDate || null,
        endDate: endDate || null,
      },
      referralDetailsCount,
    });
  } catch (error) {
    console.error("Error fetching monthly referral details count:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
};
/**
 * Get comprehensive information about every doctor and their therapy types
 * Returns detailed analytics including therapy type counts, completion rates, and performance metrics
 */

const getDoctorTherapyTypesInfo = async (req, res) => {
  try {
    const { orgDb } = req;
    const {
      month,
      year,
      startDate,
      endDate,
      doctorId,
      locationId,
      locationName,
      includeInactive = false,
      sortBy = "totalSessions",
      sortOrder = "desc",
    } = req.query;

    // -----------------------------
    // 1. BUILD DATE FILTER (same logic)
    // -----------------------------
    let dateFilter = {};
    let periodLabel = "All Time";

    const buildDateError = (msg) =>
      res.status(400).json({ success: false, error: msg });

    if (startDate || endDate) {
      const custom = {};
      if (startDate) {
        const d = new Date(startDate);
        if (isNaN(d)) return buildDateError("Invalid startDate format");
        custom.$gte = startDate;
      }
      if (endDate) {
        const d = new Date(endDate);
        if (isNaN(d)) return buildDateError("Invalid endDate format");
        const inc = new Date(d);
        inc.setDate(inc.getDate() + 1);
        custom.$lt = inc.toISOString().split("T")[0];
      }
      if (startDate && endDate && new Date(startDate) >= new Date(endDate)) {
        return buildDateError("startDate must be before endDate");
      }

      dateFilter.therepy_date = custom;
      periodLabel =
        startDate && endDate
          ? `${startDate} to ${endDate}`
          : startDate
            ? `From ${startDate}`
            : `Until ${endDate}`;
    } else if (month || year) {
      const m = parseInt(month || new Date().getMonth() + 1);
      const y = parseInt(year || new Date().getFullYear());
      if (isNaN(m) || isNaN(y) || m < 1 || m > 12) {
        return buildDateError("Invalid month/year");
      }

      const s = new Date(Date.UTC(y, m - 1, 1));
      const e = new Date(Date.UTC(y, m, 1));

      dateFilter.therepy_date = {
        $gte: s.toISOString().split("T")[0],
        $lt: e.toISOString().split("T")[0],
      };

      const names = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      periodLabel = `${names[m - 1]} ${y}`;
    }

    // -----------------------------
    // 2. BUILD LOCATION FILTER
    // -----------------------------
    let locationFilter = {};
    let locationFilterLabel = "None";

    if (locationId) {
      locationFilter.location_id = locationId;
      locationFilterLabel = `Location ID: ${locationId}`;
    } else if (locationName) {
      locationFilter.location_name = { $regex: locationName, $options: "i" };
      locationFilterLabel = `Location: ${locationName}`;
    }

    // -----------------------------
    // 3. FETCH DOCTORS (1st query)
    // -----------------------------
    const doctorQuery = doctorId ? { _id: new ObjectId(doctorId) } : {};

    const doctors = await orgDb
      .collection("doctors")
      .find(doctorQuery)
      .toArray();

    // Map doctor lookup
    const doctorMap = new Map();
    doctors.forEach((d) => doctorMap.set(d._id.toString(), d));

    // -----------------------------
    // 4. AGGREGATE THERAPY SESSIONS (2nd query) — FASTER
    // -----------------------------
    const sessionMatch = {
      ...dateFilter,
      ...locationFilter,
    };

    const sessionAgg = await orgDb
      .collection("therepys")
      .aggregate([
        { $match: sessionMatch },

        // Group by doctor
        {
          $group: {
            _id: "$doctor_id",
            sessions: { $push: "$$ROOT" },
            totalSessions: { $sum: 1 },
            completedSessions: {
              $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
            },
            cancelledSessions: {
              $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
            },
            consultationSessions: {
              $sum: { $cond: ["$is_consultation", 1, 0] },
            },
            totalDuration: { $sum: "$session_duration" },
          },
        },
      ])
      .toArray();

    // -----------------------------
    // 5. BUILD RESPONSE FOR EACH DOCTOR (NO CHANGE TO OUTPUT)
    // -----------------------------
    const analytics = [];

    for (const row of sessionAgg) {
      const doc = doctorMap.get(row._id.toString());
      if (!doc) continue;

      const doctorSessions = row.sessions;

      // Count therapy types
      const therapyTypes = {
        "In Clinic": {
          count: 0,
          completed: 0,
          cancelled: 0,
          pending: 0,
          scheduled: 0,
        },
        "In Home": {
          count: 0,
          completed: 0,
          cancelled: 0,
          pending: 0,
          scheduled: 0,
        },
        "IP/ICU": {
          count: 0,
          completed: 0,
          cancelled: 0,
          pending: 0,
          scheduled: 0,
        },
        Online: {
          count: 0,
          completed: 0,
          cancelled: 0,
          pending: 0,
          scheduled: 0,
        },
      };

      const locationsWorked = new Set();

      doctorSessions.forEach((s) => {
        const type = therapyTypes[s.therepy_type];
        const st = (s.status || "").toLowerCase();

        if (type) {
          type.count++;
          if (st === "completed") type.completed++;
          else if (st === "cancelled") type.cancelled++;
          else if (st === "scheduled") type.scheduled++;
          else type.pending++;
        }

        if (s.location_name) locationsWorked.add(s.location_name);
      });

      const mostCommon = Object.entries(therapyTypes).reduce(
        (max, [key, val]) =>
          val.count > max.count ? { type: key, count: val.count } : max,
        { type: "None", count: 0 },
      );

      const avgDuration =
        row.completedSessions > 0
          ? Math.round(row.totalDuration / row.completedSessions)
          : 0;

      let doctorPhoto = null;
      if (doc.doctors_photo) {
        try {
          doctorPhoto = await generateImageSasToken(doc.doctors_photo);
        } catch {}
      }

      // Unique patients (fast)
      const uniquePatients = new Set(doctorSessions.map((x) => x.patient_id))
        .size;

      // Date range
      const dates = doctorSessions.map((s) => new Date(s.therepy_date));
      const dateRange = {
        firstSession: dates.length ? new Date(Math.min(...dates)) : null,
        lastSession: dates.length ? new Date(Math.max(...dates)) : null,
      };

      analytics.push({
        doctor_id: doc._id,
        doctor_name: `${doc.doctor_first_name} ${doc.doctor_last_name}`,
        doctor_email: doc.doctor_email,
        doctor_phone: doc.doctor_phone,
        doctor_photo: doctorPhoto,
        doctor_specialization: doc.doctor_specialization,
        doctor_status: doc.status || "active",

        totalSessions: row.totalSessions,
        completedSessions: row.completedSessions,
        cancelledSessions: row.cancelledSessions,
        consultationSessions: row.consultationSessions,
        uniquePatients,

        completionRate:
          row.totalSessions > 0
            ? Math.round((row.completedSessions / row.totalSessions) * 100)
            : 0,

        cancellationRate:
          row.totalSessions > 0
            ? Math.round((row.cancelledSessions / row.totalSessions) * 100)
            : 0,

        avgSessionDuration: avgDuration,
        totalDuration: row.totalDuration,

        recentSessions: row.totalSessions, // matches your logic

        mostCommonTherapyType: mostCommon.type,
        mostCommonTherapyCount: mostCommon.count,

        therapyTypes,

        therapyTypeSummary: {
          inClinic: therapyTypes["In Clinic"].count,
          inHome: therapyTypes["In Home"].count,
          ipIcu: therapyTypes["IP/ICU"].count,
          online: therapyTypes["Online"].count,
        },

        locationsWorked: [...locationsWorked],
        locationsCount: locationsWorked.size,

        dateRange,
      });
    }

    // Include/Exclude inactive
    let finalAnalytics = includeInactive
      ? analytics
      : analytics.filter((x) => x.doctor_status === "active");

    // Remove zero-session doctors when location filter is used
    if (locationId || locationName) {
      finalAnalytics = finalAnalytics.filter((d) => d.totalSessions > 0);
    }

    // Sorting (unchanged)
    finalAnalytics.sort((a, b) => {
      let A, B;
      if (sortBy === "doctorName") {
        A = a.doctor_name.toLowerCase();
        B = b.doctor_name.toLowerCase();
      } else if (sortBy === "completionRate") {
        A = a.completionRate;
        B = b.completionRate;
      } else {
        A = a.totalSessions;
        B = b.totalSessions;
      }
      return sortOrder === "asc" ? (A > B ? 1 : -1) : A < B ? 1 : -1;
    });

    // Aggregates
    const aggregateStats = {
      totalDoctors: finalAnalytics.length,
      totalSessions: finalAnalytics.reduce((s, d) => s + d.totalSessions, 0),
      totalCompletedSessions: finalAnalytics.reduce(
        (s, d) => s + d.completedSessions,
        0,
      ),
      totalCancelledSessions: finalAnalytics.reduce(
        (s, d) => s + d.cancelledSessions,
        0,
      ),
      totalUniquePatients: finalAnalytics.reduce(
        (s, d) => s + d.uniquePatients,
        0,
      ),
      averageCompletionRate:
        finalAnalytics.length > 0
          ? Math.round(
              finalAnalytics.reduce((s, d) => s + d.completionRate, 0) /
                finalAnalytics.length,
            )
          : 0,

      therapyTypeTotals: {
        inClinic: finalAnalytics.reduce(
          (s, d) => s + d.therapyTypeSummary.inClinic,
          0,
        ),
        inHome: finalAnalytics.reduce(
          (s, d) => s + d.therapyTypeSummary.inHome,
          0,
        ),
        ipIcu: finalAnalytics.reduce(
          (s, d) => s + d.therapyTypeSummary.ipIcu,
          0,
        ),
        online: finalAnalytics.reduce(
          (s, d) => s + d.therapyTypeSummary.online,
          0,
        ),
      },
    };

    // Top performers
    const top = {
      mostSessions: finalAnalytics.reduce(
        (a, b) => (!a || b.totalSessions > a.totalSessions ? b : a),
        null,
      ),
      highestCompletionRate: finalAnalytics.reduce(
        (a, b) => (!a || b.completionRate > a.completionRate ? b : a),
        null,
      ),
      mostPatients: finalAnalytics.reduce(
        (a, b) => (!a || b.uniquePatients > a.uniquePatients ? b : a),
        null,
      ),
    };

    // -----------------------------
    // 6. FINAL RESPONSE (UNCHANGED)
    // -----------------------------
    res.status(200).json({
      success: true,
      message: `Retrieved therapy analytics for ${finalAnalytics.length} doctors`,
      filters: {
        period: periodLabel,
        month: month ? parseInt(month) : null,
        year: year ? parseInt(year) : null,
        startDate: startDate || null,
        endDate: endDate || null,
        doctorId,
        locationId: locationId || null,
        locationName: locationName || null,
        locationFilter: locationFilterLabel,
        includeInactive,
        sortBy,
        sortOrder,
      },
      aggregateStats,
      topPerformers: {
        mostSessions: top.mostSessions
          ? {
              doctor_name: top.mostSessions.doctor_name,
              totalSessions: top.mostSessions.totalSessions,
              doctor_photo: top.mostSessions.doctor_photo,
            }
          : null,

        highestCompletionRate: top.highestCompletionRate
          ? {
              doctor_name: top.highestCompletionRate.doctor_name,
              completionRate: top.highestCompletionRate.completionRate,
              doctor_photo: top.highestCompletionRate.doctor_photo,
            }
          : null,

        mostPatients: top.mostPatients
          ? {
              doctor_name: top.mostPatients.doctor_name,
              uniquePatients: top.mostPatients.uniquePatients,
              doctor_photo: top.mostPatients.doctor_photo,
            }
          : null,
      },

      doctors: finalAnalytics,
    });
  } catch (err) {
    console.error("Therapy analytics error:", err);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
};

const getDoctorAssessmentsInfo = async (req, res) => {
  try {
    const { orgDb } = req;
    const {
      month,
      year,
      startDate,
      endDate,
      doctorId,
      locationId,
      includeInactive = false,
      sortBy = "totalAssessments",
      sortOrder = "desc",
    } = req.query;

    let dateFilter = {};
    let periodLabel = "All Time";

    const buildDateError = (msg) =>
      res.status(400).json({ success: false, error: msg });

    if (startDate || endDate) {
      const custom = {};
      if (startDate) {
        const d = new Date(startDate);
        if (isNaN(d)) return buildDateError("Invalid startDate format");
        custom.$gte = new Date(startDate);
      }
      if (endDate) {
        const d = new Date(endDate);
        if (isNaN(d)) return buildDateError("Invalid endDate format");
        // Include the full end day
        const inc = new Date(d);
        inc.setDate(inc.getDate() + 1);
        custom.$lt = inc;
      }
      if (startDate && endDate && new Date(startDate) >= new Date(endDate)) {
        return buildDateError("startDate must be before endDate");
      }

      dateFilter.date_taken = custom;
      periodLabel =
        startDate && endDate
          ? `${startDate} to ${endDate}`
          : startDate
            ? `From ${startDate}`
            : `Until ${endDate}`;
    } else if (month || year) {
      const m = parseInt(month || new Date().getMonth() + 1);
      const y = parseInt(year || new Date().getFullYear());
      if (isNaN(m) || isNaN(y) || m < 1 || m > 12) {
        return buildDateError("Invalid month/year");
      }

      const s = new Date(Date.UTC(y, m - 1, 1));
      const e = new Date(Date.UTC(y, m, 1));

      dateFilter.date_taken = { $gte: s, $lt: e };

      const names = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      periodLabel = `${names[m - 1]} ${y}`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. FETCH DOCTORS
    // ─────────────────────────────────────────────────────────────────────────
    const doctorQuery = doctorId ? { _id: new ObjectId(doctorId) } : {};
    const doctors = await orgDb
      .collection("doctors")
      .find(doctorQuery)
      .toArray();

    const doctorMap = new Map();
    doctors.forEach((d) => doctorMap.set(d._id.toString(), d));

    // ─────────────────────────────────────────────────────────────────────────
    // 3. AGGREGATE ASSESSMENTS  (group by doctor_id, then by assessment_name)
    //    Also collect unique patient_ids per doctor
    // ─────────────────────────────────────────────────────────────────────────
    const assessmentMatch = { ...dateFilter };

    // Restrict to specific doctor if requested
    if (doctorId) {
      assessmentMatch.doctor_id = new ObjectId(doctorId);
    }

    const assessmentAgg = await orgDb
      .collection("patient_assessments")
      .aggregate([
        { $match: assessmentMatch },

        // Group by (doctor_id, assessment_name) to get per-template counts
        {
          $group: {
            _id: {
              doctor_id: "$doctor_id",
              assessment_name: "$assessment_name",
              template_id: "$template_id",
            },
            assessmentCount: { $sum: 1 },
            completedCount: {
              $sum: { $cond: [{ $eq: ["$status", "Completed"] }, 1, 0] },
            },
            draftCount: {
              $sum: { $cond: [{ $eq: ["$status", "Draft"] }, 1, 0] },
            },
            // Collect all patient ids for this doctor+template combo
            patientIds: { $addToSet: "$patient_id" },
            latestDate: { $max: "$date_taken" },
            earliestDate: { $min: "$date_taken" },
          },
        },

        // Re-group by doctor only so we have per-template breakdown + overall unique patients
        {
          $group: {
            _id: "$_id.doctor_id",
            totalAssessments: { $sum: "$assessmentCount" },
            totalCompleted: { $sum: "$completedCount" },
            totalDraft: { $sum: "$draftCount" },
            // Flatten all patient id arrays across templates (uniqueness resolved in JS)
            allPatientIds: { $push: "$patientIds" },
            assessmentBreakdown: {
              $push: {
                assessment_name: "$_id.assessment_name",
                template_id: "$_id.template_id",
                count: "$assessmentCount",
                completed: "$completedCount",
                draft: "$draftCount",
                unique_patients: { $size: "$patientIds" },
                latest_date: "$latestDate",
                earliest_date: "$earliestDate",
              },
            },
            latestAssessmentDate: { $max: "$latestDate" },
            earliestAssessmentDate: { $min: "$earliestDate" },
          },
        },
      ])
      .toArray();

    // ─────────────────────────────────────────────────────────────────────────
    // 4. COUNT PATIENTS ASSIGNED TO EACH DOCTOR  (patient.doctor_id)
    //    Optionally filtered by location_id
    // ─────────────────────────────────────────────────────────────────────────
    const patientMatchBase = locationId ? { location_id: locationId } : {};

    // One aggregation: group by doctor_id → count
    const assignedPatientAgg = await orgDb
      .collection("patients")
      .aggregate([
        {
          $match: {
            ...patientMatchBase,
            status: { $ne: "Archived" }, // exclude archived patients
          },
        },
        {
          $group: {
            _id: "$doctor_id",
            assignedCount: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const assignedPatientMap = new Map();
    assignedPatientAgg.forEach((row) => {
      if (row._id) {
        assignedPatientMap.set(row._id.toString(), row.assignedCount);
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. BUILD PER-DOCTOR RESPONSE OBJECTS
    // ─────────────────────────────────────────────────────────────────────────
    const analytics = [];

    for (const row of assessmentAgg) {
      const doc = doctorMap.get(row._id.toString());
      if (!doc) continue; // assessment exists but doctor was deleted — skip

      // Flatten nested patient id arrays and count unique across all templates
      const allPatientIdSet = new Set();
      row.allPatientIds.forEach((arr) =>
        arr.forEach((pid) => pid && allPatientIdSet.add(pid.toString())),
      );
      const uniquePatients = allPatientIdSet.size;

      // Assigned patients count (from patient.doctor_id)
      const assignedPatients = assignedPatientMap.get(row._id.toString()) || 0;

      // Sort assessment breakdown by count desc for readability
      const assessmentBreakdown = (row.assessmentBreakdown || []).sort(
        (a, b) => b.count - a.count,
      );

      // Most-used assessment template
      const mostUsed =
        assessmentBreakdown.length > 0 ? assessmentBreakdown[0] : null;

      // SAS token for doctor photo
      let doctorPhoto = null;
      if (doc.doctors_photo) {
        try {
          doctorPhoto = await generateImageSasToken(doc.doctors_photo);
        } catch (_) {
          // Non-critical — swallow token generation failures
        }
      }

      analytics.push({
        doctor_id: doc._id,
        doctor_name: `${doc.doctor_first_name} ${doc.doctor_last_name}`,
        doctor_email: doc.doctor_email,
        doctor_phone: doc.doctor_phone,
        doctor_photo: doctorPhoto,
        doctor_specialization: doc.specialization || null,
        doctor_status: doc.status || "Active",

        // ── Assessment summary ──────────────────────────────────────────────
        totalAssessments: row.totalAssessments,
        totalCompleted: row.totalCompleted,
        totalDraft: row.totalDraft,
        completionRate:
          row.totalAssessments > 0
            ? Math.round((row.totalCompleted / row.totalAssessments) * 100)
            : 0,

        // ── Patient counts ──────────────────────────────────────────────────
        uniquePatients, // patients who received ≥1 assessment in this period
        assignedPatients, // patients whose doctor_id === this doctor (total active roster)

        // ── Breakdown by template ───────────────────────────────────────────
        assessmentBreakdown,

        // ── Most-used template quick access ────────────────────────────────
        mostUsedAssessment: mostUsed
          ? {
              name: mostUsed.assessment_name,
              count: mostUsed.count,
            }
          : null,

        // ── Date span ───────────────────────────────────────────────────────
        dateRange: {
          earliest: row.earliestAssessmentDate || null,
          latest: row.latestAssessmentDate || null,
        },
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. INCLUDE INACTIVE FILTER  (mirrors getDoctorTherapyTypesInfo)
    // ─────────────────────────────────────────────────────────────────────────
    let finalAnalytics =
      includeInactive === "true" || includeInactive === true
        ? analytics
        : analytics.filter(
            (x) => x.doctor_status === "Active" || x.doctor_status === "active",
          );

    // ─────────────────────────────────────────────────────────────────────────
    // 7. SORTING
    // ─────────────────────────────────────────────────────────────────────────
    finalAnalytics.sort((a, b) => {
      let A, B;
      switch (sortBy) {
        case "doctorName":
          A = a.doctor_name.toLowerCase();
          B = b.doctor_name.toLowerCase();
          break;
        case "uniquePatients":
          A = a.uniquePatients;
          B = b.uniquePatients;
          break;
        case "assignedPatients":
          A = a.assignedPatients;
          B = b.assignedPatients;
          break;
        default: // "totalAssessments"
          A = a.totalAssessments;
          B = b.totalAssessments;
      }
      return sortOrder === "asc" ? (A > B ? 1 : -1) : A < B ? 1 : -1;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 8. AGGREGATE STATS  (mirrors getDoctorTherapyTypesInfo)
    // ─────────────────────────────────────────────────────────────────────────
    const aggregateStats = {
      totalDoctors: finalAnalytics.length,
      totalAssessments: finalAnalytics.reduce(
        (s, d) => s + d.totalAssessments,
        0,
      ),
      totalCompleted: finalAnalytics.reduce((s, d) => s + d.totalCompleted, 0),
      totalDraft: finalAnalytics.reduce((s, d) => s + d.totalDraft, 0),
      totalUniquePatients: finalAnalytics.reduce(
        (s, d) => s + d.uniquePatients,
        0,
      ),
      averageCompletionRate:
        finalAnalytics.length > 0
          ? Math.round(
              finalAnalytics.reduce((s, d) => s + d.completionRate, 0) /
                finalAnalytics.length,
            )
          : 0,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 9. TOP PERFORMERS
    // ─────────────────────────────────────────────────────────────────────────
    const top = {
      mostAssessments: finalAnalytics.reduce(
        (a, b) => (!a || b.totalAssessments > a.totalAssessments ? b : a),
        null,
      ),
      mostUniquePatients: finalAnalytics.reduce(
        (a, b) => (!a || b.uniquePatients > a.uniquePatients ? b : a),
        null,
      ),
      highestCompletionRate: finalAnalytics.reduce(
        (a, b) => (!a || b.completionRate > a.completionRate ? b : a),
        null,
      ),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 10. FINAL RESPONSE
    // ─────────────────────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: `Retrieved assessment analytics for ${finalAnalytics.length} doctors`,
      filters: {
        period: periodLabel,
        month: month ? parseInt(month) : null,
        year: year ? parseInt(year) : null,
        startDate: startDate || null,
        endDate: endDate || null,
        doctorId: doctorId || null,
        locationId: locationId || null,
        includeInactive,
        sortBy,
        sortOrder,
      },
      aggregateStats,
      topPerformers: {
        mostAssessments: top.mostAssessments
          ? {
              doctor_name: top.mostAssessments.doctor_name,
              totalAssessments: top.mostAssessments.totalAssessments,
              doctor_photo: top.mostAssessments.doctor_photo,
            }
          : null,
        mostUniquePatients: top.mostUniquePatients
          ? {
              doctor_name: top.mostUniquePatients.doctor_name,
              uniquePatients: top.mostUniquePatients.uniquePatients,
              doctor_photo: top.mostUniquePatients.doctor_photo,
            }
          : null,
        highestCompletionRate: top.highestCompletionRate
          ? {
              doctor_name: top.highestCompletionRate.doctor_name,
              completionRate: top.highestCompletionRate.completionRate,
              doctor_photo: top.highestCompletionRate.doctor_photo,
            }
          : null,
      },
      doctors: finalAnalytics,
    });
  } catch (err) {
    console.error("Assessment analytics error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
};
/**
 * Get simplified therapy type summary for quick dashboard display
 */
const getDoctorTherapyTypesSummary = async (req, res) => {
  try {
    const { orgDb } = req;

    // Use MongoDB aggregation pipeline for efficient data processing
    const summary = await orgDb
      .collection("doctors")
      .aggregate([
        {
          $lookup: {
            from: "therepys",
            localField: "_id",
            foreignField: "doctor_id",
            as: "sessions",
          },
        },
        {
          $project: {
            doctor_id: "$_id",
            doctor_name: {
              $concat: ["$doctor_first_name", " ", "$doctor_last_name"],
            },
            totalSessions: { $size: "$sessions" },
            therapyTypes: {
              "In Clinic": {
                $size: {
                  $filter: {
                    input: "$sessions",
                    cond: { $eq: ["$$this.therepy_type", "In Clinic"] },
                  },
                },
              },
              "In Home": {
                $size: {
                  $filter: {
                    input: "$sessions",
                    cond: { $eq: ["$$this.therepy_type", "In Home"] },
                  },
                },
              },
              "IP/ICU": {
                $size: {
                  $filter: {
                    input: "$sessions",
                    cond: { $eq: ["$$this.therepy_type", "IP/ICU"] },
                  },
                },
              },
              Online: {
                $size: {
                  $filter: {
                    input: "$sessions",
                    cond: { $eq: ["$$this.therepy_type", "Online"] },
                  },
                },
              },
            },
            sessionTypes: "$sessions.therepy_type",
          },
        },
        {
          $addFields: {
            mostCommonType: {
              $let: {
                vars: {
                  counts: [
                    { type: "In Clinic", count: "$therapyTypes.In Clinic" },
                    { type: "In Home", count: "$therapyTypes.In Home" },
                    { type: "IP/ICU", count: "$therapyTypes.IP/ICU" },
                    { type: "Online", count: "$therapyTypes.Online" },
                  ],
                },
                in: {
                  $cond: {
                    if: { $gt: ["$totalSessions", 0] },
                    then: {
                      $getField: {
                        field: "type",
                        input: {
                          $arrayElemAt: [
                            {
                              $sortArray: {
                                input: "$$counts",
                                sortBy: { count: -1 },
                              },
                            },
                            0,
                          ],
                        },
                      },
                    },
                    else: "None",
                  },
                },
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            sessionTypes: 0,
          },
        },
      ])
      .toArray();

    res.status(200).json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error("Error fetching doctor therapy types summary:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
};

/**
 * Unified API for appointment timeline data
 * Automatically provides appropriate data for each timeframe:
 * - daily: Shows current week (or specified month/custom range)
 * - weekly: Shows current month (or specified quarter/year/custom range)
 * - monthly: Shows current year (or specified custom range)
 * - yearly: Shows last 5 years (or specified custom range)
 */
const getAppointmentChartData = async (req, res) => {
  const { orgDb } = req;
  const {
    timeframe = "daily",
    scope,
    customStartDate,
    customEndDate,
    month,
    week,
    year,
    location_id,
    startDate,
    endDate,
  } = req.query;

  try {
    // Validate timeframe
    if (!["daily", "weekly", "monthly", "yearly"].includes(timeframe)) {
      return res.status(400).json({
        message: "timeframe must be one of: daily, weekly, monthly, yearly",
      });
    }

    let calculatedStartDate, calculatedEndDate, label;

    // Use custom date range if provided
    if (startDate || endDate) {
      if (startDate) {
        calculatedStartDate = new Date(startDate);
        if (isNaN(calculatedStartDate.getTime())) {
          return res.status(400).json({
            success: false,
            error: "Invalid startDate format. Use YYYY-MM-DD format",
          });
        }
      }

      if (endDate) {
        calculatedEndDate = new Date(endDate);
        if (isNaN(calculatedEndDate.getTime())) {
          return res.status(400).json({
            success: false,
            error: "Invalid endDate format. Use YYYY-MM-DD format",
          });
        }
      }

      if (startDate && endDate && calculatedStartDate > calculatedEndDate) {
        return res.status(400).json({
          success: false,
          error: "startDate must be before or equal to endDate",
        });
      }

      label =
        startDate && endDate
          ? `${startDate} to ${endDate}`
          : startDate
            ? `From ${startDate}`
            : `Until ${endDate}`;
    } else {
      // Use existing calculateDateRange function
      const result = calculateDateRange(
        timeframe,
        scope,
        customStartDate,
        customEndDate,
        month,
        week,
        year,
      );
      calculatedStartDate = result.startDate;
      calculatedEndDate = result.endDate;
      label = result.label;
    }

    // Format dates for MongoDB query
    const startDateStr = calculatedStartDate.toISOString().split("T")[0];
    const endDateStr = calculatedEndDate.toISOString().split("T")[0];

    // Build query with optional location filter
    const query = {
      therepy_date: {
        $gte: startDateStr,
        $lte: endDateStr,
      },
    };

    if (location_id) {
      query.location_id = location_id;
    }

    // Get all appointments
    const therapies = await orgDb.collection("therepys").find(query).toArray();

    // Process data based on the requested timeframe
    let chartData;
    switch (timeframe) {
      case "daily":
        chartData = processDailyData(
          therapies,
          calculatedStartDate,
          calculatedEndDate,
        );
        break;
      case "weekly":
        chartData = processWeeklyData(
          therapies,
          calculatedStartDate,
          calculatedEndDate,
        );
        break;
      case "monthly":
        chartData = processMonthlyData(
          therapies,
          calculatedStartDate,
          calculatedEndDate,
        );
        break;
      case "yearly":
        chartData = processYearlyData(
          therapies,
          calculatedStartDate,
          calculatedEndDate,
        );
        break;
    }

    res.json({
      timeframe,
      period: label,
      dateRange: {
        start: startDateStr,
        end: endDateStr,
      },
      filters: {
        location_id: location_id || null,
        startDate: startDate || null,
        endDate: endDate || null,
      },
      data: chartData,
    });
  } catch (error) {
    console.error(`Error fetching appointment chart data:`, error);
    res.status(500).json({
      error: `An error occurred while fetching appointment chart data.`,
      details: error.message,
    });
  }
};

/**
 * Calculate appropriate date range based on timeframe and parameters
 */
const calculateDateRange = (
  timeframe,
  scope,
  customStartDate,
  customEndDate,
  month,
  week,
  year,
) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let startDate, endDate, label;

  // Handle custom date range if provided
  if (customStartDate && customEndDate) {
    startDate = new Date(customStartDate);
    endDate = new Date(customEndDate);
    label = `${
      timeframe.charAt(0).toUpperCase() + timeframe.slice(1)
    } (Custom Range)`;
    return { startDate, endDate, label };
  }

  switch (timeframe) {
    case "daily":
      if (month) {
        // Parse YYYY-MM format
        const [yearVal, monthVal] = month
          .split("-")
          .map((num) => parseInt(num, 10));
        startDate = new Date(yearVal, monthVal - 1, 1); // Month is 0-indexed in JS
        endDate = new Date(yearVal, monthVal, 0); // Last day of the month
        label = `Daily for ${startDate.toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        })}`;
      } else if (scope === "month") {
        // Show daily data for the entire current month
        startDate = new Date(today.getFullYear(), today.getMonth(), 1);
        endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        label = `Daily for ${startDate.toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        })}`;
      } else {
        // Default: Show daily data for current week (Sunday to Saturday)
        const dayOfWeek = today.getDay();
        startDate = new Date(today);
        startDate.setDate(today.getDate() - dayOfWeek); // Start from Sunday
        endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6); // End on Saturday
        label = "Daily (This Week)";
      }
      break;

    case "weekly":
      if (year) {
        const yearVal = parseInt(year, 10);
        startDate = new Date(yearVal, 0, 1);
        endDate = new Date(yearVal, 11, 31);
        label = `Weekly for ${yearVal}`;
      } else if (week) {
        // Parse YYYY-WW format
        const [yearVal, weekVal] = week
          .split("-W")
          .map((num) => parseInt(num, 10));

        // Calculate first day of the week (using ISO week definition)
        startDate = new Date(yearVal, 0, 1 + (weekVal - 1) * 7);
        // Adjust to get the first day of the week (Monday in ISO)
        const dayOfWeek = startDate.getDay();
        const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        startDate.setDate(startDate.getDate() - diff);

        // End date is 6 days after start date
        endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6);

        label = `Week ${weekVal} of ${yearVal}`;
      } else if (scope === "year") {
        // Show weekly data for the entire year
        startDate = new Date(today.getFullYear(), 0, 1);
        endDate = new Date(today.getFullYear(), 11, 31);
        label = `Weekly for ${today.getFullYear()}`;
      } else {
        // Default: Show weekly data for last 3 months
        startDate = new Date(today);
        startDate.setMonth(today.getMonth() - 3);
        endDate = new Date(today);
        label = "Weekly (Last 3 Months)";
      }
      break;

    case "monthly":
      if (year) {
        const yearVal = parseInt(year, 10);
        startDate = new Date(yearVal, 0, 1);
        endDate = new Date(yearVal, 11, 31);
        label = `Monthly for ${yearVal}`;
      } else if (scope === "5years") {
        // Show monthly data for the last 5 years
        startDate = new Date(today);
        startDate.setFullYear(today.getFullYear() - 5);
        endDate = new Date(today);
        label = "Monthly (Last 5 Years)";
      } else {
        // Default: Show monthly data for current year
        startDate = new Date(today.getFullYear(), 0, 1);
        endDate = new Date(today.getFullYear(), 11, 31);
        label = `Monthly (${today.getFullYear()})`;
      }
      break;

    case "yearly":
      if (year) {
        // Show specific range of years (year is treated as start year)
        const startYear = parseInt(year, 10);
        const endYear = startYear + 4; // Show 5 years range
        startDate = new Date(startYear, 0, 1);
        endDate = new Date(endYear, 11, 31);
        label = `Yearly (${startYear} - ${endYear})`;
      } else {
        // Default: Show last 5 years for yearly data
        startDate = new Date(today);
        startDate.setFullYear(today.getFullYear() - 5);
        startDate = new Date(startDate.getFullYear(), 0, 1);
        endDate = new Date(today.getFullYear(), 11, 31);
        label = "Yearly (Last 5 Years)";
      }
      break;
  }

  return { startDate, endDate, label };
};

/**
 * Process data for daily visualization
 * Fix: Ensure correct date matching
 */
/**
 * Process data for daily visualization with fixed date handling
 */
const processDailyData = (therapies, startDate, endDate) => {
  const result = [];
  const dateMap = new Map();

  // Initialize map with all dates in range using UTC
  let currentDate = new Date(
    Date.UTC(
      startDate.getFullYear(),
      startDate.getMonth(),
      startDate.getDate(),
    ),
  );
  const endDateUTC = new Date(
    Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()),
  );

  while (currentDate <= endDateUTC) {
    const year = currentDate.getUTCFullYear();
    const month = String(currentDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(currentDate.getUTCDate()).padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;

    dateMap.set(dateStr, {
      date: dateStr,
      label: currentDate.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      shortLabel: currentDate.toLocaleDateString("en-US", { weekday: "short" }),
      count: 0,
      completed: 0,
      cancelled: 0,
      pending: 0,
    });

    // Move to next day in UTC
    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
  }

  // Count appointments for each date - using direct string comparison
  therapies.forEach((therapy) => {
    if (dateMap.has(therapy.therepy_date)) {
      const dateData = dateMap.get(therapy.therepy_date);
      dateData.count++;

      // Update status counts
      if (therapy.status === "completed") dateData.completed++;
      else if (therapy.status === "cancelled") dateData.cancelled++;
      else if (therapy.status === "pending") dateData.pending++;
    }
  });

  // Convert map to array
  dateMap.forEach((dateData) => {
    result.push(dateData);
  });

  return result.sort((a, b) => a.date.localeCompare(b.date));
};
/**
 * Process data for weekly visualization with fixed date handling
 */
const processWeeklyData = (therapies, startDate, endDate) => {
  const result = [];
  const weekMap = new Map();

  // Helper function to get ISO week number and year
  const getWeekYear = (dateStr) => {
    // Convert YYYY-MM-DD string to Date
    const [year, month, day] = dateStr.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    // ISO week calculation
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
    const week =
      Math.floor(
        (date - new Date(Date.UTC(date.getUTCFullYear(), 0, 4))) / 86400000 / 7,
      ) + 1;

    return { week, year: date.getUTCFullYear() };
  };

  // Initialize with all weeks in the range
  let currentDate = new Date(startDate);
  while (currentDate <= endDate) {
    // Generate date string in YYYY-MM-DD format using UTC
    const year = currentDate.getUTCFullYear();
    const month = String(currentDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(currentDate.getUTCDate()).padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;

    const weekInfo = getWeekYear(dateStr);
    const weekKey = `${weekInfo.year}-W${weekInfo.week
      .toString()
      .padStart(2, "0")}`;

    if (!weekMap.has(weekKey)) {
      // Calculate week start date (Sunday) based on current date
      const weekStart = new Date(currentDate);
      const dayOfWeek = weekStart.getDay();
      weekStart.setDate(weekStart.getDate() - dayOfWeek);

      // Calculate week end date (Saturday)
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);

      // Store the week information
      weekMap.set(weekKey, {
        weekKey,
        date: dateStr,
        label: `${weekStart.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })} - ${weekEnd.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })}`,
        shortLabel: `W${weekInfo.week}`,
        count: 0,
        completed: 0,
        cancelled: 0,
        pending: 0,
      });
    }

    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // Process all therapies using string dates directly
  therapies.forEach((therapy) => {
    const weekInfo = getWeekYear(therapy.therepy_date);
    const weekKey = `${weekInfo.year}-W${weekInfo.week
      .toString()
      .padStart(2, "0")}`;

    if (weekMap.has(weekKey)) {
      const weekData = weekMap.get(weekKey);
      weekData.count++;

      // Update status counts
      if (therapy.status === "completed") weekData.completed++;
      else if (therapy.status === "cancelled") weekData.cancelled++;
      else if (therapy.status === "pending") weekData.pending++;
    }
  });

  // Convert map to array
  weekMap.forEach((weekData) => {
    result.push(weekData);
  });

  return result.sort((a, b) => a.weekKey.localeCompare(b.weekKey));
};

/**
 * Process data for monthly visualization with fixed date handling
 */
const processMonthlyData = (therapies, startDate, endDate) => {
  const result = [];
  const monthMap = new Map();

  // Initialize with all months in the range
  let currentDate = new Date(
    Date.UTC(startDate.getFullYear(), startDate.getMonth(), 1),
  );
  const lastDate = new Date(
    Date.UTC(endDate.getFullYear(), endDate.getMonth() + 1, 0),
  );

  while (currentDate <= lastDate) {
    const year = currentDate.getUTCFullYear();
    const month = currentDate.getUTCMonth() + 1;
    const monthKey = `${year}-${month.toString().padStart(2, "0")}`;
    const monthStr = `${year}-${month.toString().padStart(2, "0")}-01`;

    monthMap.set(monthKey, {
      monthKey,
      date: monthStr,
      label: currentDate.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      }),
      shortLabel: currentDate.toLocaleDateString("en-US", { month: "short" }),
      count: 0,
      completed: 0,
      cancelled: 0,
      pending: 0,
    });

    currentDate.setUTCMonth(currentDate.getUTCMonth() + 1);
  }

  // Process all therapies using month extraction from date strings
  therapies.forEach((therapy) => {
    // Extract year and month from YYYY-MM-DD format
    const [year, month] = therapy.therepy_date.split("-");
    const monthKey = `${year}-${month}`;

    if (monthMap.has(monthKey)) {
      const monthData = monthMap.get(monthKey);
      monthData.count++;

      // Update status counts
      if (therapy.status === "completed") monthData.completed++;
      else if (therapy.status === "cancelled") monthData.cancelled++;
      else if (therapy.status === "pending") monthData.pending++;
    }
  });

  // Convert map to array
  monthMap.forEach((monthData) => {
    result.push(monthData);
  });

  return result.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
};

/**
 * Process data for yearly visualization with fixed date handling
 */
const processYearlyData = (therapies, startDate, endDate) => {
  const result = [];
  const yearMap = new Map();

  // Initialize with all years in the range
  for (
    let year = startDate.getFullYear();
    year <= endDate.getFullYear();
    year++
  ) {
    const yearKey = year.toString();
    yearMap.set(yearKey, {
      yearKey,
      date: `${year}-01-01`,
      label: year.toString(),
      shortLabel: year.toString(),
      count: 0,
      completed: 0,
      cancelled: 0,
      pending: 0,
    });
  }

  // Process all therapies using direct year extraction from date string
  therapies.forEach((therapy) => {
    // Extract year from YYYY-MM-DD format
    const year = therapy.therepy_date.split("-")[0];

    if (yearMap.has(year)) {
      const yearData = yearMap.get(year);
      yearData.count++;

      // Update status counts
      if (therapy.status === "completed") yearData.completed++;
      else if (therapy.status === "cancelled") yearData.cancelled++;
      else if (therapy.status === "pending") yearData.pending++;
    }
  });

  // Convert map to array
  yearMap.forEach((yearData) => {
    result.push(yearData);
  });

  return result.sort((a, b) => parseInt(a.yearKey) - parseInt(b.yearKey));
};
/**
 * Get all timeline data at once for dashboard display
 */
const getAppointmentDashboardData = async (req, res) => {
  const { orgDb } = req;

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Calculate date ranges
    const dayOfWeek = today.getDay();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - dayOfWeek);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const yearStart = new Date(today.getFullYear(), 0, 1);
    const yearEnd = new Date(today.getFullYear(), 11, 31, 23, 59, 59);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Format dates
    const weekStartStr = weekStart.toISOString().split("T")[0];
    const weekEndStr = weekEnd.toISOString().split("T")[0];
    const yearStartStr = yearStart.toISOString().split("T")[0];
    const yearEndStr = yearEnd.toISOString().split("T")[0];
    const todayStr = today.toISOString().split("T")[0];
    const tomorrowStr = tomorrow.toISOString().split("T")[0];

    // Optimized aggregation with indexed field first
    const results = await orgDb
      .collection("therepys")
      .aggregate([
        {
          $match: {
            therepy_date: { $gte: yearStartStr, $lte: yearEndStr },
          },
        },
        {
          $facet: {
            yearStats: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  completed: {
                    $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
                  },
                  cancelled: {
                    $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
                  },
                  pending: {
                    $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
                  },
                },
              },
            ],
            dailyCounts: [
              {
                $match: {
                  therepy_date: { $in: [todayStr, tomorrowStr] },
                },
              },
              {
                $group: {
                  _id: "$therepy_date",
                  count: { $sum: 1 },
                },
              },
            ],
            weeklyData: [
              {
                $match: {
                  therepy_date: { $gte: weekStartStr, $lte: weekEndStr },
                },
              },
              {
                $group: {
                  _id: "$therepy_date",
                  count: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
            monthlyData: [
              {
                $group: {
                  _id: { $substr: ["$therepy_date", 5, 2] },
                  count: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ])
      .toArray();

    const data = results[0];

    // Extract daily counts efficiently
    const dailyCountsMap = new Map(
      data.dailyCounts.map((d) => [d._id, d.count]),
    );
    const todayCount = dailyCountsMap.get(todayStr) || 0;
    const tomorrowCount = dailyCountsMap.get(tomorrowStr) || 0;

    // Process weekly data
    const weeklyDataMap = new Map(data.weeklyData.map((d) => [d._id, d.count]));
    const dailyData = [];
    const current = new Date(weekStart);
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    while (current <= weekEnd) {
      const dateStr = current.toISOString().split("T")[0];
      dailyData.push({
        date: dateStr,
        day: dayNames[current.getDay()],
        count: weeklyDataMap.get(dateStr) || 0,
      });
      current.setDate(current.getDate() + 1);
    }

    // Process monthly data
    const monthlyDataMap = new Map(
      data.monthlyData.map((d) => [d._id, d.count]),
    );
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const monthlyData = months.map((month, i) => ({
      month,
      count: monthlyDataMap.get(String(i + 1).padStart(2, "0")) || 0,
    }));

    // Extract year stats
    const yearStats = data.yearStats[0] || {
      total: 0,
      completed: 0,
      cancelled: 0,
      pending: 0,
    };

    res.json({
      overview: {
        today: todayCount,
        tomorrow: tomorrowCount,
        thisYear: yearStats.total,
        byStatus: {
          completed: yearStats.completed,
          cancelled: yearStats.cancelled,
          pending: yearStats.pending,
        },
      },
      dailyChart: {
        timeframe: "daily",
        period: "This Week",
        data: dailyData,
      },
      monthlyChart: {
        timeframe: "monthly",
        period: `Year ${today.getFullYear()}`,
        data: monthlyData,
      },
    });
  } catch (error) {
    console.error("Error fetching appointment dashboard data:", error);
    res.status(500).json({
      error: "An error occurred while fetching appointment dashboard data.",
      details: error.message,
    });
  }
};

const getMonthlyLeaderboard = async (req, res) => {
  try {
    const { orgDb } = req;
    const { month, year, location_id, startDate, endDate } = req.query;

    // Validate month/year vs custom range
    if ((month && !year) || (!month && year)) {
      if (!startDate && !endDate) {
        return res.status(400).json({
          success: false,
          error:
            "Both month and year are required together, or use startDate/endDate for custom range",
        });
      }
    }

    // Calculate date range
    let dateFilter, periodLabel;
    try {
      const result = calculateDateRangeHelper(month, year, startDate, endDate);
      dateFilter = result.dateFilter;
      periodLabel = result.periodLabel;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    // Build therapy match filter
    const matchQuery = {};
    if (Object.keys(dateFilter).length > 0) {
      matchQuery.therepy_date = dateFilter;
    }
    if (location_id) {
      matchQuery.location_id = location_id;
    }

    // 🔥 Optimized MongoDB pipeline
    const leaderboardData = await orgDb
      .collection("therepys")
      .aggregate([
        { $match: matchQuery },

        // Group to count doctor therapy sessions
        {
          $group: {
            _id: "$doctor_id",
            therapy_count: { $sum: 1 },
          },
        },

        // Sort by highest therapy count
        { $sort: { therapy_count: -1 } },

        // Lookup doctor details in one go (avoids N+1 fetches)
        {
          $lookup: {
            from: "doctors",
            localField: "_id",
            foreignField: "_id",
            as: "doctor",
          },
        },

        { $unwind: { path: "$doctor", preserveNullAndEmptyArrays: true } },
      ])
      .toArray();

    // Convert each record into required response format
    const leaderboard = await Promise.all(
      leaderboardData.map(async (d) => {
        let doctorPhoto = null;

        if (d.doctor?.doctors_photo) {
          doctorPhoto = await generateImageSasToken(d.doctor.doctors_photo);
        }

        return {
          doctor_id: d._id?.toString() || null,
          doctor_name: d.doctor
            ? `${d.doctor.doctor_first_name} ${d.doctor.doctor_last_name}`
            : "Unknown",
          doctor_photo: doctorPhoto,
          therapy_count: d.therapy_count,
        };
      }),
    );

    return res.status(200).json({
      success: true,
      period: periodLabel,
      filters: {
        month: month || null,
        year: year || null,
        startDate: startDate || null,
        endDate: endDate || null,
        location_id: location_id || null,
      },
      data: leaderboard,
    });
  } catch (error) {
    console.error("Error fetching monthly leaderboard data:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
};

const countPractoReferralsByYear = async (req, res) => {
  try {
    const { orgDb } = req;

    // Enhanced aggregation pipeline that does more work in MongoDB
    const pipeline = [
      // Convert patient_registration_date to Date
      {
        $addFields: {
          regDate: { $toDate: "$patient_registration_date" },
        },
      },
      // Group by year, month, and referral_details
      {
        $group: {
          _id: {
            year: { $year: "$regDate" },
            month: { $month: "$regDate" },
            referral_details: "$referral_details",
          },
          count: { $sum: 1 },
        },
      },
      // Sort by year and month
      {
        $sort: {
          "_id.year": 1,
          "_id.month": 1,
        },
      },
      // Group again to calculate totals per year/month
      {
        $group: {
          _id: {
            year: "$_id.year",
            month: "$_id.month",
          },
          details: {
            $push: {
              referral: "$_id.referral_details",
              count: "$count",
            },
          },
          total: { $sum: "$count" },
        },
      },
      // Add practo count using $reduce
      {
        $addFields: {
          practo: {
            $reduce: {
              input: "$details",
              initialValue: 0,
              in: {
                $cond: [
                  { $eq: ["$$this.referral", "Practo"] },
                  { $add: ["$$value", "$$this.count"] },
                  "$$value",
                ],
              },
            },
          },
        },
      },
      // Calculate grand totals using $group with $facet
      {
        $facet: {
          monthlyData: [
            {
              $project: {
                _id: 0,
                year: "$_id.year",
                month: "$_id.month",
                practo: 1,
                total: 1,
              },
            },
          ],
          grandTotals: [
            {
              $group: {
                _id: null,
                practo: { $sum: "$practo" },
                all: { $sum: "$total" },
              },
            },
          ],
        },
      },
    ];

    const [results] = await orgDb
      .collection("patients")
      .aggregate(pipeline)
      .toArray();

    const { monthlyData, grandTotals } = results;

    // Build pivot object and array efficiently
    const pivotData = {};
    const pivotArray = monthlyData.map((item) => {
      const { year, month, practo, total } = item;

      // Build nested object
      if (!pivotData[year]) pivotData[year] = {};
      pivotData[year][month] = { practo, total };

      // Return array item with month name
      return {
        year,
        month: getMonthName(month),
        practo,
        total,
      };
    });

    // Send response
    res.status(200).json({
      success: true,
      data: {
        pivotObject: pivotData,
        pivotArray,
        grandTotals: grandTotals[0] || { practo: 0, all: 0 },
      },
    });
  } catch (error) {
    console.error("Error generating monthly pivot data:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
};

/**
 * Helper function to map month number to month abbreviation or name.
 * Adjust as needed for your display preferences.
 */
function getMonthName(monthNumber) {
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return monthNames[monthNumber - 1] || monthNumber;
}

const getSocialMediaPivot = async (req, res) => {
  try {
    const { orgDb } = req;

    const socialMediaSubCategories = [
      "Google",
      "Facebook",
      "Instagram",
      "YouTube",
      "WhatsApp",
      "",
    ];

    // Optimized aggregation pipeline - let MongoDB do more work
    const pipeline = [
      {
        $addFields: {
          regDate: { $toDate: "$patient_registration_date" },
        },
      },
      {
        $match: {
          $or: [
            { referral_source: "Social Media" },
            {
              referral_source: "Other",
              referral_details: { $in: socialMediaSubCategories },
            },
          ],
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$regDate" },
            month: { $month: "$regDate" },
            details: "$referral_details",
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: {
          "_id.year": 1,
          "_id.month": 1,
        },
      },
    ];

    const aggregationResults = await orgDb
      .collection("patients")
      .aggregate(pipeline)
      .toArray();

    // Pre-allocate structures
    const pivotData = {};
    const grandTotals = {};
    const pivotArray = [];
    const yearMonthMap = new Map(); // For faster pivotArray construction

    // Single-pass data transformation
    for (const item of aggregationResults) {
      const { year, month, details } = item._id;
      const count = item.count;
      const subcategory = details === "" ? "(blank)" : details;

      // Build pivotData
      const yearData = (pivotData[year] ??= {});
      const monthData = (yearData[month] ??= { total: 0 });
      monthData[subcategory] = (monthData[subcategory] || 0) + count;
      monthData.total += count;

      // Build grandTotals
      grandTotals[subcategory] = (grandTotals[subcategory] || 0) + count;

      // Track year-month combinations for pivotArray
      const ymKey = `${year}-${month}`;
      if (!yearMonthMap.has(ymKey)) {
        yearMonthMap.set(ymKey, { year, month });
      }
    }

    // Calculate grand total
    grandTotals.total = Object.values(grandTotals).reduce(
      (acc, val) => acc + val,
      0,
    );

    // Build pivotArray efficiently
    const sortedYearMonths = Array.from(yearMonthMap.values()).sort(
      (a, b) => a.year - b.year || a.month - b.month,
    );

    for (const { year, month } of sortedYearMonths) {
      const subObj = pivotData[year][month];
      const rowEntry = {
        year,
        month: getMonthName(month),
        total: subObj.total,
      };

      for (const cat of socialMediaSubCategories) {
        const key = cat === "" ? "(blank)" : cat;
        rowEntry[key] = subObj[key] || 0;
      }

      pivotArray.push(rowEntry);
    }

    res.status(200).json({
      success: true,
      data: {
        pivotObject: pivotData,
        pivotArray,
        grandTotals,
      },
    });
  } catch (error) {
    console.error("Error generating social media pivot data:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
};

/**
 * Helper function to map month number to a short name.
 */
function getMonthName(monthNumber) {
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return monthNames[monthNumber - 1] || monthNumber;
}

const getActivePlansWithPaymentsAndSessions = async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");

    // Extract and validate query parameters
    const {
      sortBy = "newest",
      limit = 20,
      offset = 0,
      page,
      patient_name,
      therapy_name,
      payment_status,
      session_status,
      plan_status,
      min_amount,
      max_amount,
      min_balance,
      max_balance,
      min_sessions,
      max_sessions,
      therapy_category,
      payment_type,
      payment_progress_min,
      payment_progress_max,
      created_after,
      created_before,
      reporting_period,
      report_year,
      report_quarter,
      report_month,
      include_zero_balance,
      overdue_only,
      high_balance_only,
      last_payment_after,
      last_payment_before,
    } = req.query;

    // Optimized pagination calculation
    const parsedLimit = Math.max(1, Math.min(1000, parseInt(limit) || 20));
    const parsedPage = parseInt(page) || null;
    const parsedOffset =
      parsedPage && parsedPage > 0
        ? (parsedPage - 1) * parsedLimit
        : Math.max(0, parseInt(offset) || 0);

    const paginationParams = {
      limit: parsedLimit,
      offset: parsedOffset,
      page: parsedPage || Math.floor(parsedOffset / parsedLimit) + 1,
    };

    // Reusable safe conversion functions
    const safeToDouble = (field) => ({
      $cond: [
        { $and: [{ $ne: [field, null] }, { $ne: [field, ""] }] },
        { $convert: { input: field, to: "double", onError: 0, onNull: 0 } },
        0,
      ],
    });

    const safeParseFloat = (value, defaultValue = 0) => {
      if (value == null || value === "") return defaultValue;
      const parsed = parseFloat(value);
      return isNaN(parsed) ? defaultValue : parsed;
    };

    const safeParseInt = (value, defaultValue = 0) => {
      if (value == null || value === "") return defaultValue;
      const parsed = parseInt(value);
      return isNaN(parsed) ? defaultValue : parsed;
    };

    // Build optimized base query
    const baseQuery = {};
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const targetYear = report_year ? parseInt(report_year) : currentYear;

    // Date range calculation for reporting period
    let startDate, endDate;
    if (reporting_period === "yearly") {
      startDate = new Date(targetYear, 0, 1);
      endDate = new Date(targetYear, 11, 31, 23, 59, 59);
    } else if (reporting_period === "quarterly") {
      const quarter = report_quarter
        ? parseInt(report_quarter)
        : Math.ceil((currentDate.getMonth() + 1) / 3);
      const startMonth = (quarter - 1) * 3;
      startDate = new Date(targetYear, startMonth, 1);
      endDate = new Date(targetYear, startMonth + 3, 0, 23, 59, 59);
    } else if (reporting_period === "monthly") {
      const month = report_month
        ? parseInt(report_month) - 1
        : currentDate.getMonth();
      startDate = new Date(targetYear, month, 1);
      endDate = new Date(targetYear, month + 1, 0, 23, 59, 59);
    }

    // Apply date filters
    if (startDate && endDate) {
      baseQuery.$or = [
        { createdAt: { $gte: startDate, $lte: endDate } },
        { created_date: { $gte: startDate, $lte: endDate } },
      ];
    }

    // Apply text filters with regex
    if (therapy_name)
      baseQuery.therapy_name = { $regex: therapy_name, $options: "i" };
    if (therapy_category)
      baseQuery.patient_therapy_category = {
        $regex: therapy_category,
        $options: "i",
      };
    if (payment_type) baseQuery.payment_type = payment_type;

    // Apply numeric amount filters
    if (min_amount || max_amount) {
      const amountConditions = [];
      if (min_amount)
        amountConditions.push({
          $gte: [safeToDouble("$total_amount"), parseFloat(min_amount)],
        });
      if (max_amount)
        amountConditions.push({
          $lte: [safeToDouble("$total_amount"), parseFloat(max_amount)],
        });
      baseQuery.$expr = { $and: amountConditions };
    }

    // Apply session count filters
    if (min_sessions || max_sessions) {
      baseQuery.estimated_sessions = {};
      if (min_sessions)
        baseQuery.estimated_sessions.$gte = parseInt(min_sessions);
      if (max_sessions)
        baseQuery.estimated_sessions.$lte = parseInt(max_sessions);
    }

    // Apply creation date filters
    if (created_after || created_before) {
      const dateConditions = [];
      if (created_after) {
        dateConditions.push({
          $or: [
            { createdAt: { $gte: new Date(created_after) } },
            { created_date: { $gte: new Date(created_after) } },
          ],
        });
      }
      if (created_before) {
        dateConditions.push({
          $or: [
            { createdAt: { $lte: new Date(created_before) } },
            { created_date: { $lte: new Date(created_before) } },
          ],
        });
      }
      if (!baseQuery.$and) baseQuery.$and = [];
      baseQuery.$and.push(...dateConditions);
    }

    // Apply last payment date filters
    if (last_payment_after || last_payment_before) {
      const paymentDateQuery = {};
      if (last_payment_after)
        paymentDateQuery.$gte = new Date(last_payment_after);
      if (last_payment_before)
        paymentDateQuery.$lte = new Date(last_payment_before);
      if (!baseQuery.$and) baseQuery.$and = [];
      baseQuery.$and.push({
        $or: [
          { last_payment_date: paymentDateQuery },
          { "payment_history.date": paymentDateQuery },
        ],
      });
    }

    // Fetch plans with optimized projection
    const allPlans = await req.orgDb
      .collection("plans")
      .find(baseQuery)
      .toArray();

    if (!allPlans.length) {
      return res.status(200).json({
        message: "No therapy plans found for the specified criteria",
        plans_report: [],
        summary: {
          total_plans: 0,
          total_revenue_received: 0,
          total_pending_balance: 0,
          total_completed_sessions: 0,
          total_scheduled_sessions: 0,
          total_remaining_sessions: 0,
          reporting_period: {
            type: reporting_period || "all",
            year: targetYear,
            quarter: report_quarter || null,
            month: report_month || null,
            start_date: startDate
              ? startDate.toISOString().split("T")[0]
              : null,
            end_date: endDate ? endDate.toISOString().split("T")[0] : null,
          },
        },
        filters_applied: req.query,
        pagination: {
          current_page: paginationParams.page,
          items_per_page: paginationParams.limit,
          total_items: 0,
          total_pages: 0,
          has_next: false,
          has_previous: false,
          next_page: null,
          previous_page: null,
        },
      });
    }

    // Optimized ObjectId conversion using Set for deduplication
    const planObjectIds = allPlans.map((plan) => {
      try {
        return typeof plan._id === "string" ? new ObjectId(plan._id) : plan._id;
      } catch {
        return plan._id;
      }
    });

    // Fetch patients with optimized projection
    const patients = await req.orgDb
      .collection("patients")
      .find(
        { therapy_plans: { $in: planObjectIds } },
        {
          projection: {
            patient_first_name: 1,
            patient_last_name: 1,
            patient_phone: 1,
            therapy_plans: 1,
          },
        },
      )
      .toArray();

    // Build patient map more efficiently
    const planToPatientMap = {};
    for (const patient of patients) {
      if (Array.isArray(patient.therapy_plans)) {
        const patientInfo = {
          name: `${patient.patient_first_name || "Unknown"} ${
            patient.patient_last_name || "Patient"
          }`,
          phone: patient.patient_phone || "N/A",
          patient_id: patient._id,
        };
        for (const planId of patient.therapy_plans) {
          planToPatientMap[planId.toString()] = patientInfo;
        }
      }
    }

    // Get current date for calculations
    const today = currentDate.toISOString().split("T")[0];
    currentDate.setHours(0, 0, 0, 0);

    // Initialize summary totals
    let totalRevenue = 0;
    let totalPendingBalance = 0;
    let totalCompletedSessions = 0;
    let totalScheduledSessions = 0;
    let totalRemainingSessions = 0;

    // Process plans with optimized logic
    let plansWithDetails = allPlans.map((plan) => {
      const patientInfo = planToPatientMap[plan._id.toString()] || {
        name: "Unknown Patient",
        phone: "N/A",
        patient_id: null,
      };

      const therapySessions = plan.therapy_sessions || [];

      // Optimized session counting
      let completedSessions = 0;
      let scheduledSessions = 0;

      for (const session of therapySessions) {
        const status = session.status?.toLowerCase();
        if (status === "completed") completedSessions++;
        else if (status === "scheduled" || status === "in_progress")
          scheduledSessions++;
      }

      const estimatedSessions = safeParseInt(plan.estimated_sessions);
      const effectiveEstimatedSessions =
        estimatedSessions > 0 ? estimatedSessions : therapySessions.length;
      const remainingSessions = Math.max(
        0,
        effectiveEstimatedSessions - completedSessions - scheduledSessions,
      );

      // Calculate payment statistics
      const totalAmount = safeParseFloat(plan.total_amount);
      const receivedAmount = safeParseFloat(plan.received_amount);
      const storedBalance = safeParseFloat(plan.balance);
      const balance =
        storedBalance > 0 ? storedBalance : totalAmount - receivedAmount;
      const addonsAmount = safeParseFloat(plan.addons_amount);

      // Payment history processing
      const paymentHistory = plan.payment_history || [];
      const totalPayments = paymentHistory.length;
      const lastPaymentDate =
        plan.last_payment_date ||
        (totalPayments > 0 ? paymentHistory[totalPayments - 1].date : null);

      const recentPayments = paymentHistory
        .slice(-3)
        .reverse()
        .map((payment) => ({
          amount: safeParseFloat(payment.amount),
          date: payment.date,
          type: payment.type || "recurring",
          payment_number: payment.payment_number,
        }));

      // Determine plan status
      let planStatus = "unknown";
      let daysRemaining = null;

      if (plan.therapy_start && plan.therapy_end) {
        const startDate = new Date(plan.therapy_start);
        const endDate = new Date(plan.therapy_end);

        if (today < plan.therapy_start) {
          planStatus = "upcoming";
          daysRemaining = Math.ceil((startDate - currentDate) / 86400000);
        } else if (today <= plan.therapy_end) {
          planStatus = "active";
          daysRemaining = Math.ceil((endDate - currentDate) / 86400000);
        } else {
          planStatus = "completed";
          daysRemaining = Math.ceil((currentDate - endDate) / 86400000) * -1;
        }
      }

      // Update summary totals
      totalRevenue += receivedAmount;
      totalPendingBalance += balance;
      totalCompletedSessions += completedSessions;
      totalScheduledSessions += scheduledSessions;
      totalRemainingSessions += remainingSessions;

      // Calculate progress percentages
      const sessionProgress =
        effectiveEstimatedSessions > 0
          ? Math.round((completedSessions / effectiveEstimatedSessions) * 100)
          : 0;
      const paymentProgress =
        totalAmount > 0 ? Math.round((receivedAmount / totalAmount) * 100) : 0;

      // Determine payment urgency
      let paymentUrgency = "low";
      if (planStatus === "completed" && balance > 0) {
        paymentUrgency = "high";
      } else if (planStatus === "active" && balance > totalAmount * 0.5) {
        paymentUrgency = "medium";
      }

      return {
        plan_id: plan._id,
        therapy_name: plan.therapy_name || "N/A",
        patient_info: {
          patient_id: patientInfo.patient_id,
          patient_name: patientInfo.name,
          patient_phone: patientInfo.phone,
        },
        timeline: {
          therapy_start: plan.therapy_start,
          therapy_end: plan.therapy_end,
          days_remaining: daysRemaining,
          duration: plan.therapy_duration,
          plan_status: planStatus,
        },
        payment_summary: {
          total_amount: totalAmount,
          received_amount: receivedAmount,
          balance: balance,
          addons_amount: addonsAmount,
          payment_progress_percentage: paymentProgress,
          total_payments_made: totalPayments,
          last_payment_date: lastPaymentDate,
          payment_type: plan.payment_type || "recurring",
          per_session_amount: safeParseFloat(plan.per_session_amount),
          payment_urgency: paymentUrgency,
        },
        session_summary: {
          estimated_sessions: effectiveEstimatedSessions,
          completed_sessions: completedSessions,
          scheduled_sessions: scheduledSessions,
          remaining_sessions: remainingSessions,
          session_progress_percentage: sessionProgress,
          sessions_per_week: plan.sessions_per_week || "N/A",
        },
        recent_payments: recentPayments,
        status_indicators: {
          payment_status: balance > 0 ? "pending" : "completed",
          session_status: remainingSessions > 0 ? "ongoing" : "completed",
          plan_status: planStatus,
          priority: paymentUrgency,
        },
        additional_info: {
          patient_diagnosis: plan.patient_diagnosis,
          patient_symptoms: plan.patient_symptoms,
          therapy_category: plan.patient_therapy_category,
          notes_count: Array.isArray(plan.notes) ? plan.notes.length : 0,
          created_date: plan.createdAt || plan.created_date,
          goal_achievement: safeParseFloat(plan.goal_achievement),
          current_status: plan.status,
          total_therapy_sessions: therapySessions.length,
        },
      };
    });

    // Apply post-processing filters
    if (patient_name) {
      const lowerPatientName = patient_name.toLowerCase();
      plansWithDetails = plansWithDetails.filter((plan) =>
        plan.patient_info.patient_name.toLowerCase().includes(lowerPatientName),
      );
    }

    if (payment_status && payment_status !== "all") {
      plansWithDetails = plansWithDetails.filter(
        (plan) => plan.status_indicators.payment_status === payment_status,
      );
    }

    if (session_status && session_status !== "all") {
      plansWithDetails = plansWithDetails.filter(
        (plan) => plan.status_indicators.session_status === session_status,
      );
    }

    if (plan_status && plan_status !== "all") {
      plansWithDetails = plansWithDetails.filter(
        (plan) => plan.timeline.plan_status === plan_status,
      );
    }

    if (min_balance || max_balance) {
      const minBal = min_balance ? parseFloat(min_balance) : null;
      const maxBal = max_balance ? parseFloat(max_balance) : null;
      plansWithDetails = plansWithDetails.filter((plan) => {
        const balance = plan.payment_summary.balance;
        return (!minBal || balance >= minBal) && (!maxBal || balance <= maxBal);
      });
    }

    if (payment_progress_min || payment_progress_max) {
      const minProg = payment_progress_min
        ? parseInt(payment_progress_min)
        : null;
      const maxProg = payment_progress_max
        ? parseInt(payment_progress_max)
        : null;
      plansWithDetails = plansWithDetails.filter((plan) => {
        const progress = plan.payment_summary.payment_progress_percentage;
        return (
          (!minProg || progress >= minProg) && (!maxProg || progress <= maxProg)
        );
      });
    }

    if (include_zero_balance === "false") {
      plansWithDetails = plansWithDetails.filter(
        (plan) => plan.payment_summary.balance > 0,
      );
    }

    if (overdue_only === "true") {
      plansWithDetails = plansWithDetails.filter(
        (plan) =>
          plan.timeline.plan_status === "completed" &&
          plan.payment_summary.balance > 0,
      );
    }

    if (high_balance_only === "true") {
      plansWithDetails = plansWithDetails.filter(
        (plan) =>
          plan.payment_summary.balance >
          plan.payment_summary.total_amount * 0.5,
      );
    }

    // Optimized sorting with lookup table
    const statusOrder = { completed: 1, active: 2, upcoming: 3, unknown: 4 };

    plansWithDetails.sort((a, b) => {
      switch (sortBy) {
        case "newest":
          return (
            new Date(b.additional_info.created_date || 0) -
            new Date(a.additional_info.created_date || 0)
          );
        case "oldest":
          return (
            new Date(a.additional_info.created_date || 0) -
            new Date(b.additional_info.created_date || 0)
          );
        case "amount_desc":
          return (
            b.payment_summary.total_amount - a.payment_summary.total_amount
          );
        case "amount_asc":
          return (
            a.payment_summary.total_amount - b.payment_summary.total_amount
          );
        case "completed_desc":
          return (
            b.session_summary.completed_sessions -
            a.session_summary.completed_sessions
          );
        case "completed_asc":
          return (
            a.session_summary.completed_sessions -
            b.session_summary.completed_sessions
          );
        case "scheduled_desc":
          return (
            b.session_summary.scheduled_sessions -
            a.session_summary.scheduled_sessions
          );
        case "scheduled_asc":
          return (
            a.session_summary.scheduled_sessions -
            b.session_summary.scheduled_sessions
          );
        case "remaining_desc":
          return (
            b.session_summary.remaining_sessions -
            a.session_summary.remaining_sessions
          );
        case "remaining_asc":
          return (
            a.session_summary.remaining_sessions -
            b.session_summary.remaining_sessions
          );
        case "balance_desc":
          return b.payment_summary.balance - a.payment_summary.balance;
        case "balance_asc":
          return a.payment_summary.balance - b.payment_summary.balance;
        case "payment_progress_desc":
          return (
            b.payment_summary.payment_progress_percentage -
            a.payment_summary.payment_progress_percentage
          );
        case "payment_progress_asc":
          return (
            a.payment_summary.payment_progress_percentage -
            b.payment_summary.payment_progress_percentage
          );
        case "patient_name":
          return a.patient_info.patient_name.localeCompare(
            b.patient_info.patient_name,
          );
        case "therapy_name":
          return a.therapy_name.localeCompare(b.therapy_name);
        case "plan_status":
          return (
            (statusOrder[a.timeline.plan_status] || 4) -
            (statusOrder[b.timeline.plan_status] || 4)
          );
        default:
          return (
            new Date(b.additional_info.created_date || 0) -
            new Date(a.additional_info.created_date || 0)
          );
      }
    });

    // Pagination
    const totalCount = plansWithDetails.length;
    const totalPages = Math.ceil(totalCount / paginationParams.limit);
    const validatedPage = Math.min(
      paginationParams.page,
      Math.max(1, totalPages),
    );
    const validatedOffset = (validatedPage - 1) * paginationParams.limit;
    const paginatedPlans = plansWithDetails.slice(
      validatedOffset,
      validatedOffset + paginationParams.limit,
    );

    // Pagination metadata
    const paginationMeta = {
      current_page: validatedPage,
      items_per_page: paginationParams.limit,
      total_items: totalCount,
      total_pages: totalPages,
      has_next: validatedPage < totalPages,
      has_previous: validatedPage > 1,
      next_page: validatedPage < totalPages ? validatedPage + 1 : null,
      previous_page: validatedPage > 1 ? validatedPage - 1 : null,
      start_index: validatedOffset + 1,
      end_index: Math.min(validatedOffset + paginationParams.limit, totalCount),
      showing_count: paginatedPlans.length,
      links: {
        first: totalPages > 0 ? 1 : null,
        last: totalPages > 0 ? totalPages : null,
        prev: validatedPage > 1 ? validatedPage - 1 : null,
        next: validatedPage < totalPages ? validatedPage + 1 : null,
      },
      page_range: {
        start: Math.max(1, validatedPage - 2),
        end: Math.min(totalPages, validatedPage + 2),
      },
    };

    // Build summary with optimized calculations
    const paymentCompletionSum = plansWithDetails.reduce(
      (sum, plan) => sum + plan.payment_summary.payment_progress_percentage,
      0,
    );
    const sessionCompletionSum = plansWithDetails.reduce(
      (sum, plan) => sum + plan.session_summary.session_progress_percentage,
      0,
    );

    const planCount = plansWithDetails.length;

    // Use single pass for status breakdowns
    const statusBreakdowns = {
      active: 0,
      completed: 0,
      upcoming: 0,
      unknown: 0,
      payment_completed: 0,
      payment_pending: 0,
      session_completed: 0,
      session_ongoing: 0,
      urgency_high: 0,
      urgency_medium: 0,
      urgency_low: 0,
    };

    const therapyCategorySet = new Set();
    const paymentTypeSet = new Set();

    for (const plan of plansWithDetails) {
      statusBreakdowns[plan.timeline.plan_status]++;
      statusBreakdowns[`payment_${plan.status_indicators.payment_status}`]++;
      statusBreakdowns[`session_${plan.status_indicators.session_status}`]++;
      statusBreakdowns[`urgency_${plan.payment_summary.payment_urgency}`]++;

      if (
        plan.additional_info.therapy_category &&
        plan.additional_info.therapy_category !== "N/A"
      ) {
        therapyCategorySet.add(plan.additional_info.therapy_category);
      }
      if (
        plan.payment_summary.payment_type &&
        plan.payment_summary.payment_type !== "N/A"
      ) {
        paymentTypeSet.add(plan.payment_summary.payment_type);
      }
    }

    const summary = {
      total_plans: totalCount,
      showing_plans: paginatedPlans.length,
      total_revenue_received: Math.round(totalRevenue * 100) / 100,
      total_pending_balance: Math.round(totalPendingBalance * 100) / 100,
      total_completed_sessions: totalCompletedSessions,
      total_scheduled_sessions: totalScheduledSessions,
      total_remaining_sessions: totalRemainingSessions,
      average_payment_completion:
        planCount > 0 ? Math.round(paymentCompletionSum / planCount) : 0,
      average_session_completion:
        planCount > 0 ? Math.round(sessionCompletionSum / planCount) : 0,
      reporting_period: {
        type: reporting_period || "all",
        year: targetYear,
        quarter: report_quarter || null,
        month: report_month || null,
        start_date: startDate ? startDate.toISOString().split("T")[0] : null,
        end_date: endDate ? endDate.toISOString().split("T")[0] : null,
      },
      plans_by_status: {
        active: statusBreakdowns.active,
        completed: statusBreakdowns.completed,
        upcoming: statusBreakdowns.upcoming,
        unknown: statusBreakdowns.unknown,
      },
      payment_status_breakdown: {
        completed: statusBreakdowns.payment_completed,
        pending: statusBreakdowns.payment_pending,
      },
      session_status_breakdown: {
        completed: statusBreakdowns.session_completed,
        ongoing: statusBreakdowns.session_ongoing,
      },
      payment_urgency_breakdown: {
        high: statusBreakdowns.urgency_high,
        medium: statusBreakdowns.urgency_medium,
        low: statusBreakdowns.urgency_low,
      },
      therapy_categories: Array.from(therapyCategorySet),
      payment_types: Array.from(paymentTypeSet),
    };

    return res.status(200).json({
      message: `Therapy plans report for ${
        reporting_period || "all periods"
      } retrieved successfully`,
      summary,
      plans_report: paginatedPlans,
      pagination: paginationMeta,
      filters_applied: req.query,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error in getActivePlansWithPaymentsAndSessions:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

const getAllPlansWithRemainingPayments = async (req, res) => {
  try {
    // Extract and validate query parameters
    const {
      sortBy = "urgency",
      limit = 10,
      offset = 0,
      page,
      patient_name,
      therapy_name,
      plan_status,
      payment_urgency,
      min_balance,
      max_balance,
      min_amount,
      max_amount,
      min_sessions,
      max_sessions,
      therapy_category,
      payment_type,
      payment_progress_min,
      payment_progress_max,
      last_payment_after,
      last_payment_before,
      created_after,
      created_before,
      overdue_only,
      high_balance_only,
      location_name,
      location_address,
      location_id,
    } = req.query;

    // Enhanced pagination logic
    const limitNum = Math.min(parseInt(limit) || 10, 100);
    let offsetNum = parseInt(offset) || 0;

    if (page && !isNaN(parseInt(page))) {
      const pageNum = Math.max(1, parseInt(page));
      offsetNum = (pageNum - 1) * limitNum;
    }

    // Validate pagination parameters
    if (offsetNum < 0 || limitNum <= 0) {
      return res.status(400).json({
        message: "Invalid pagination parameters",
        error:
          offsetNum < 0
            ? "Offset cannot be negative"
            : "Limit must be greater than 0",
      });
    }

    // Helper functions (defined once, reused throughout)
    const safeParseFloat = (value, defaultValue = 0) => {
      if (value === null || value === undefined || value === "")
        return defaultValue;
      const parsed = parseFloat(value);
      return isNaN(parsed) ? defaultValue : parsed;
    };

    const safeParseInt = (value, defaultValue = 0) => {
      if (value === null || value === undefined || value === "")
        return defaultValue;
      const parsed = parseInt(value);
      return isNaN(parsed) ? defaultValue : parsed;
    };

    // Optimized safeToDouble helper for aggregation
    const safeToDouble = (field) => ({
      $cond: [
        {
          $and: [
            { $ne: [field, null] },
            { $ne: [field, ""] },
            { $ne: [field, undefined] },
          ],
        },
        { $convert: { input: field, to: "double", onError: 0, onNull: 0 } },
        0,
      ],
    });

    // Build optimized base query
    const baseQuery = {};

    // Only add balance filter if only_pending is true
    if (req.query.only_pending === "true") {
      baseQuery.$or = [
        { $expr: { $gt: [safeToDouble("$balance"), 0] } },
        {
          $expr: {
            $gt: [
              {
                $subtract: [
                  safeToDouble("$total_amount"),
                  safeToDouble("$received_amount"),
                ],
              },
              0,
            ],
          },
        },
      ];
    }

    // Build filters efficiently
    if (therapy_name)
      baseQuery.therapy_name = { $regex: therapy_name, $options: "i" };
    if (therapy_category)
      baseQuery.patient_therapy_category = {
        $regex: therapy_category,
        $options: "i",
      };
    if (payment_type) baseQuery.payment_type = payment_type;
    if (location_name)
      baseQuery.location_name = { $regex: location_name, $options: "i" };
    if (location_address)
      baseQuery.location_address = { $regex: location_address, $options: "i" };
    if (location_id) baseQuery.location_id = location_id;

    // Amount range filter
    if (min_amount || max_amount) {
      baseQuery.$expr = baseQuery.$expr || { $and: [] };
      if (!Array.isArray(baseQuery.$expr.$and)) {
        baseQuery.$expr = { $and: [baseQuery.$expr] };
      }
      if (min_amount)
        baseQuery.$expr.$and.push({
          $gte: [safeToDouble("$total_amount"), parseFloat(min_amount)],
        });
      if (max_amount)
        baseQuery.$expr.$and.push({
          $lte: [safeToDouble("$total_amount"), parseFloat(max_amount)],
        });
    }

    // Session range filter
    if (min_sessions || max_sessions) {
      baseQuery.estimated_sessions = {};
      if (min_sessions)
        baseQuery.estimated_sessions.$gte = parseInt(min_sessions);
      if (max_sessions)
        baseQuery.estimated_sessions.$lte = parseInt(max_sessions);
    }

    // Date range filters
    if (created_after || created_before) {
      baseQuery.$and = baseQuery.$and || [];
      if (created_after) {
        baseQuery.$and.push({
          $or: [
            { createdAt: { $gte: new Date(created_after) } },
            { created_date: { $gte: new Date(created_after) } },
          ],
        });
      }
      if (created_before) {
        baseQuery.$and.push({
          $or: [
            { createdAt: { $lte: new Date(created_before) } },
            { created_date: { $lte: new Date(created_before) } },
          ],
        });
      }
    }

    // Payment date range filters
    if (last_payment_after || last_payment_before) {
      const paymentDateQuery = {};
      if (last_payment_after)
        paymentDateQuery.$gte = new Date(last_payment_after);
      if (last_payment_before)
        paymentDateQuery.$lte = new Date(last_payment_before);
      baseQuery.$and = baseQuery.$and || [];
      baseQuery.$and.push({
        $or: [
          { last_payment_date: paymentDateQuery },
          { "payment_history.date": paymentDateQuery },
        ],
      });
    }

    // Fetch plans and patients in parallel for better performance
    const [plansWithBalance, patients] = await Promise.all([
      req.orgDb.collection("plans").find(baseQuery).toArray(),
      // Optimistically fetch patients - we'll filter later if needed
      req.orgDb
        .collection("patients")
        .find(
          {},
          {
            projection: {
              patient_first_name: 1,
              patient_last_name: 1,
              patient_phone: 1,
              therapy_plans: 1,
            },
          },
        )
        .toArray(),
    ]);

    // Early return if no plans found
    if (!plansWithBalance.length) {
      return res.status(200).json({
        message: "No therapy plans found matching the specified criteria",
        plans_with_payments: [],
        summary: {
          total_plans_with_payments: 0,
          total_revenue_received: 0,
          total_pending_balance: 0,
          total_completed_sessions: 0,
          total_scheduled_sessions: 0,
          total_remaining_sessions: 0,
        },
        pagination: {
          total_count: 0,
          current_page: page
            ? parseInt(page)
            : Math.floor(offsetNum / limitNum) + 1,
          total_pages: 0,
          page_size: limitNum,
          offset: offsetNum,
          has_next_page: false,
          has_previous_page: offsetNum > 0,
          next_page: null,
          previous_page: null,
        },
        filters_applied: req.query,
      });
    }

    // Create plan to patient map more efficiently
    const planToPatientMap = new Map();
    for (const patient of patients) {
      if (patient.therapy_plans && Array.isArray(patient.therapy_plans)) {
        const patientInfo = {
          name: `${patient.patient_first_name || "Unknown"} ${
            patient.patient_last_name || "Patient"
          }`,
          phone: patient.patient_phone || "N/A",
          patient_id: patient._id,
        };
        for (const planId of patient.therapy_plans) {
          planToPatientMap.set(planId.toString(), patientInfo);
        }
      }
    }

    // Pre-calculate date info once
    const currentDate = new Date();
    const today = currentDate.toISOString().split("T")[0];
    currentDate.setHours(0, 0, 0, 0);

    // Initialize summary totals
    let totalRevenue = 0;
    let totalPendingBalance = 0;
    let totalCompletedSessions = 0;
    let totalScheduledSessions = 0;
    let totalRemainingSessions = 0;

    // Process plans efficiently
    let plansWithDetails = plansWithBalance.map((plan) => {
      const patientInfo = planToPatientMap.get(plan._id.toString()) || {
        name: "Unknown Patient",
        phone: "N/A",
        patient_id: null,
      };

      // Calculate session statistics
      const therapySessions = plan.therapy_sessions || [];
      let completedSessions = 0;
      let scheduledSessions = 0;

      // Single loop for session counting
      for (const session of therapySessions) {
        const status = session.status?.toLowerCase();
        if (status === "completed") completedSessions++;
        else if (status === "scheduled" || status === "in_progress")
          scheduledSessions++;
      }

      const estimatedSessions = safeParseInt(plan.estimated_sessions);
      const effectiveEstimatedSessions =
        estimatedSessions > 0 ? estimatedSessions : therapySessions.length;
      const remainingSessions = Math.max(
        0,
        effectiveEstimatedSessions - completedSessions - scheduledSessions,
      );

      // Calculate payment statistics
      const totalAmount = safeParseFloat(plan.total_amount);
      const receivedAmount = safeParseFloat(plan.received_amount);
      const storedBalance = safeParseFloat(plan.balance);
      const calculatedBalance = totalAmount - receivedAmount;
      const balance = storedBalance > 0 ? storedBalance : calculatedBalance;
      const addonsAmount = safeParseFloat(plan.addons_amount);

      // Payment history processing
      const paymentHistory = plan.payment_history || [];
      const totalPayments = paymentHistory.length;
      const lastPaymentDate =
        plan.last_payment_date ||
        (paymentHistory.length > 0
          ? paymentHistory[paymentHistory.length - 1].date
          : null);

      // Recent payments (last 3) - optimized slice and map
      const recentPayments = paymentHistory
        .slice(-3)
        .reverse()
        .map((payment) => ({
          amount: safeParseFloat(payment.amount),
          date: payment.date,
          type: payment.type || "recurring",
          payment_number: payment.payment_number,
        }));

      // Determine plan status
      let planStatus = "unknown";
      let daysRemaining = null;

      if (plan.therapy_start && plan.therapy_end) {
        const startDate = new Date(plan.therapy_start);
        const endDate = new Date(plan.therapy_end);

        if (today < plan.therapy_start) {
          planStatus = "upcoming";
          daysRemaining = Math.ceil((startDate - currentDate) / 86400000);
        } else if (today >= plan.therapy_start && today <= plan.therapy_end) {
          planStatus = "active";
          daysRemaining = Math.ceil((endDate - currentDate) / 86400000);
        } else {
          planStatus = "completed";
          daysRemaining = Math.ceil((currentDate - endDate) / 86400000) * -1;
        }
      }

      // Update summary totals
      totalRevenue += receivedAmount;
      totalPendingBalance += balance;
      totalCompletedSessions += completedSessions;
      totalScheduledSessions += scheduledSessions;
      totalRemainingSessions += remainingSessions;

      // Progress calculations
      const sessionProgress =
        effectiveEstimatedSessions > 0
          ? Math.round((completedSessions / effectiveEstimatedSessions) * 100)
          : 0;
      const paymentProgress =
        totalAmount > 0 ? Math.round((receivedAmount / totalAmount) * 100) : 0;

      // Determine payment urgency
      let paymentUrgency = "low";
      if (planStatus === "completed" && balance > 0) {
        paymentUrgency = "high";
      } else if (planStatus === "active" && balance > totalAmount * 0.5) {
        paymentUrgency = "medium";
      }

      return {
        plan_id: plan._id,
        therapy_name: plan.therapy_name || "N/A",
        patient_info: {
          patient_id: patientInfo.patient_id,
          patient_name: patientInfo.name,
          patient_phone: patientInfo.phone,
        },
        location_info: {
          location_id: plan.location_id || "N/A",
          location_name: plan.location_name || "N/A",
          location_address: plan.location_address || "N/A",
        },
        timeline: {
          therapy_start: plan.therapy_start,
          therapy_end: plan.therapy_end,
          days_remaining: daysRemaining,
          duration: plan.therapy_duration,
          plan_status: planStatus,
        },
        payment_summary: {
          total_amount: totalAmount,
          received_amount: receivedAmount,
          balance: balance,
          addons_amount: addonsAmount,
          payment_progress_percentage: paymentProgress,
          total_payments_made: totalPayments,
          last_payment_date: lastPaymentDate,
          payment_type: plan.payment_type || "recurring",
          per_session_amount: safeParseFloat(plan.per_session_amount),
          payment_urgency: paymentUrgency,
        },
        session_summary: {
          estimated_sessions: effectiveEstimatedSessions,
          completed_sessions: completedSessions,
          scheduled_sessions: scheduledSessions,
          remaining_sessions: remainingSessions,
          session_progress_percentage: sessionProgress,
          sessions_per_week: plan.sessions_per_week || "N/A",
        },
        recent_payments: recentPayments,
        status_indicators: {
          payment_status: balance > 0 ? "pending" : "completed",
          session_status: remainingSessions > 0 ? "ongoing" : "completed",
          plan_status: planStatus,
          priority: paymentUrgency,
        },
        additional_info: {
          patient_diagnosis: plan.patient_diagnosis,
          patient_symptoms: plan.patient_symptoms,
          therapy_category: plan.patient_therapy_category,
          notes_count: Array.isArray(plan.notes) ? plan.notes.length : 0,
          created_date: plan.createdAt || plan.created_date,
          goal_achievement: safeParseFloat(plan.goal_achievement),
          current_status: plan.status,
          total_therapy_sessions: therapySessions.length,
        },
      };
    });

    // Apply post-processing filters
    if (patient_name) {
      const searchTerm = patient_name.toLowerCase();
      plansWithDetails = plansWithDetails.filter((plan) =>
        plan.patient_info.patient_name.toLowerCase().includes(searchTerm),
      );
    }

    if (plan_status && plan_status !== "all") {
      plansWithDetails = plansWithDetails.filter(
        (plan) => plan.timeline.plan_status === plan_status,
      );
    }

    if (payment_urgency) {
      plansWithDetails = plansWithDetails.filter(
        (plan) => plan.payment_summary.payment_urgency === payment_urgency,
      );
    }

    if (min_balance || max_balance) {
      const minBal = min_balance ? parseFloat(min_balance) : -Infinity;
      const maxBal = max_balance ? parseFloat(max_balance) : Infinity;
      plansWithDetails = plansWithDetails.filter((plan) => {
        const balance = plan.payment_summary.balance;
        return balance >= minBal && balance <= maxBal;
      });
    }

    if (payment_progress_min || payment_progress_max) {
      const minProg = payment_progress_min
        ? parseInt(payment_progress_min)
        : -Infinity;
      const maxProg = payment_progress_max
        ? parseInt(payment_progress_max)
        : Infinity;
      plansWithDetails = plansWithDetails.filter((plan) => {
        const progress = plan.payment_summary.payment_progress_percentage;
        return progress >= minProg && progress <= maxProg;
      });
    }

    if (overdue_only === "true") {
      plansWithDetails = plansWithDetails.filter(
        (plan) =>
          plan.timeline.plan_status === "completed" &&
          plan.payment_summary.balance > 0,
      );
    }

    if (high_balance_only === "true") {
      plansWithDetails = plansWithDetails.filter(
        (plan) =>
          plan.payment_summary.balance >
          plan.payment_summary.total_amount * 0.5,
      );
    }

    // Optimized sorting with lookup tables
    const urgencyOrder = { high: 1, medium: 2, low: 3 };
    const statusOrder = { completed: 1, active: 2, upcoming: 3, unknown: 4 };

    plansWithDetails.sort((a, b) => {
      switch (sortBy) {
        case "newest":
          return (
            new Date(b.additional_info.created_date || 0) -
            new Date(a.additional_info.created_date || 0)
          );
        case "oldest":
          return (
            new Date(a.additional_info.created_date || 0) -
            new Date(b.additional_info.created_date || 0)
          );
        case "balance_desc":
          return b.payment_summary.balance - a.payment_summary.balance;
        case "balance_asc":
          return a.payment_summary.balance - b.payment_summary.balance;
        case "amount_desc":
          return (
            b.payment_summary.total_amount - a.payment_summary.total_amount
          );
        case "amount_asc":
          return (
            a.payment_summary.total_amount - b.payment_summary.total_amount
          );
        case "completed_desc":
          return (
            b.session_summary.completed_sessions -
            a.session_summary.completed_sessions
          );
        case "completed_asc":
          return (
            a.session_summary.completed_sessions -
            b.session_summary.completed_sessions
          );
        case "scheduled_desc":
          return (
            b.session_summary.scheduled_sessions -
            a.session_summary.scheduled_sessions
          );
        case "scheduled_asc":
          return (
            a.session_summary.scheduled_sessions -
            b.session_summary.scheduled_sessions
          );
        case "remaining_desc":
          return (
            b.session_summary.remaining_sessions -
            a.session_summary.remaining_sessions
          );
        case "remaining_asc":
          return (
            a.session_summary.remaining_sessions -
            b.session_summary.remaining_sessions
          );
        case "payment_progress_desc":
          return (
            b.payment_summary.payment_progress_percentage -
            a.payment_summary.payment_progress_percentage
          );
        case "payment_progress_asc":
          return (
            a.payment_summary.payment_progress_percentage -
            b.payment_summary.payment_progress_percentage
          );
        case "last_payment_desc":
          return (
            (b.payment_summary.last_payment_date
              ? new Date(b.payment_summary.last_payment_date)
              : new Date(0)) -
            (a.payment_summary.last_payment_date
              ? new Date(a.payment_summary.last_payment_date)
              : new Date(0))
          );
        case "last_payment_asc":
          return (
            (a.payment_summary.last_payment_date
              ? new Date(a.payment_summary.last_payment_date)
              : new Date(0)) -
            (b.payment_summary.last_payment_date
              ? new Date(b.payment_summary.last_payment_date)
              : new Date(0))
          );
        case "patient_name":
          return a.patient_info.patient_name.localeCompare(
            b.patient_info.patient_name,
          );
        case "therapy_name":
          return a.therapy_name.localeCompare(b.therapy_name);
        case "plan_status":
          return (
            (statusOrder[a.timeline.plan_status] || 4) -
            (statusOrder[b.timeline.plan_status] || 4)
          );
        case "urgency":
        default:
          const urgencyDiff =
            (urgencyOrder[a.payment_summary.payment_urgency] || 3) -
            (urgencyOrder[b.payment_summary.payment_urgency] || 3);
          return urgencyDiff !== 0
            ? urgencyDiff
            : b.payment_summary.balance - a.payment_summary.balance;
      }
    });

    // Pagination calculations
    const totalCount = plansWithDetails.length;
    const totalPages = Math.ceil(totalCount / limitNum);
    const currentPage = page
      ? parseInt(page)
      : Math.floor(offsetNum / limitNum) + 1;

    // Validate page exists
    if (offsetNum >= totalCount && totalCount > 0) {
      return res.status(400).json({
        message: "Invalid pagination parameters",
        error: `Requested page ${currentPage} does not exist. Total pages: ${totalPages}`,
        pagination: {
          total_count: totalCount,
          total_pages: totalPages,
          requested_page: currentPage,
          page_size: limitNum,
        },
      });
    }

    // Apply pagination
    const paginatedPlans = plansWithDetails.slice(
      offsetNum,
      offsetNum + limitNum,
    );

    // Pagination metadata
    const hasNextPage = offsetNum + limitNum < totalCount;
    const hasPreviousPage = offsetNum > 0;

    // Calculate summary statistics efficiently
    let activeCount = 0,
      completedCount = 0,
      upcomingCount = 0;
    let highUrgency = 0,
      mediumUrgency = 0,
      lowUrgency = 0;
    let totalPaymentProgress = 0;

    for (const plan of plansWithDetails) {
      // Count status
      switch (plan.timeline.plan_status) {
        case "active":
          activeCount++;
          break;
        case "completed":
          completedCount++;
          break;
        case "upcoming":
          upcomingCount++;
          break;
      }
      // Count urgency
      switch (plan.payment_summary.payment_urgency) {
        case "high":
          highUrgency++;
          break;
        case "medium":
          mediumUrgency++;
          break;
        case "low":
          lowUrgency++;
          break;
      }
      totalPaymentProgress += plan.payment_summary.payment_progress_percentage;
    }

    const summary = {
      total_plans_with_payments: totalCount,
      showing_plans: paginatedPlans.length,
      total_revenue_received: Math.round(totalRevenue * 100) / 100,
      total_pending_balance: Math.round(totalPendingBalance * 100) / 100,
      total_completed_sessions: totalCompletedSessions,
      total_scheduled_sessions: totalScheduledSessions,
      total_remaining_sessions: totalRemainingSessions,
      average_payment_completion:
        plansWithDetails.length > 0
          ? Math.round(totalPaymentProgress / plansWithDetails.length)
          : 0,
      plans_by_status: {
        active: activeCount,
        completed: completedCount,
        upcoming: upcomingCount,
      },
      payment_urgency_breakdown: {
        high: highUrgency,
        medium: mediumUrgency,
        low: lowUrgency,
      },
    };

    return res.status(200).json({
      message:
        "All therapy plans with remaining payments retrieved successfully",
      summary,
      plans_with_payments: paginatedPlans,
      pagination: {
        total_count: totalCount,
        current_page: currentPage,
        total_pages: totalPages,
        page_size: limitNum,
        offset: offsetNum,
        showing_from: offsetNum + 1,
        showing_to: Math.min(offsetNum + limitNum, totalCount),
        has_next_page: hasNextPage,
        has_previous_page: hasPreviousPage,
        next_page: hasNextPage ? currentPage + 1 : null,
        previous_page: hasPreviousPage ? currentPage - 1 : null,
        first_page: 1,
        last_page: totalPages,
      },
      filters_applied: req.query,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error in getAllPlansWithRemainingPayments:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};
const { getPatientModel } = require("../db/patientSchema");
const { getPaymentModel } = require("../db/paymentSchema");
const { getTherapyPlanModel } = require("../db/therepy");

const getPaymentCollectionAnalysis = async (req, res) => {
  try {
    // Get models using the connection
    const Patient = getPatientModel(req.orgDb);
    const Payment = getPaymentModel(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);

    // Extract and validate query parameters
    const {
      sortBy = "date",
      limit = 10,
      offset = 0,
      page,
      patient_name,
      doctor_name,
      doctor_id,
      payment_type,
      therapy_type,
      min_amount,
      max_amount,
      date_from,
      date_to,
      therapy_plan_id,
      patient_id,
      has_addon_services,
      group_by,
      location_id,
    } = req.query;

    // Enhanced pagination logic
    const limitNum = Math.min(parseInt(limit) || 10, 100);
    let offsetNum = parseInt(offset) || 0;

    if (page && !isNaN(parseInt(page))) {
      const pageNum = Math.max(1, parseInt(page));
      offsetNum = (pageNum - 1) * limitNum;
    }

    // Validate pagination parameters
    if (offsetNum < 0 || limitNum <= 0) {
      return res.status(400).json({
        message: "Invalid pagination parameters",
        error:
          offsetNum < 0
            ? "Offset cannot be negative"
            : "Limit must be greater than 0",
      });
    }

    // ---------------------------------------------------------
    // STEP 1: Pre-fetch IDs for Name Search
    // ---------------------------------------------------------
    let filterPatientIds = null;
    let filterDoctorIds = null;

    if (patient_name) {
      const patients = await Patient.find(
        {
          $or: [
            { patient_first_name: { $regex: patient_name, $options: "i" } },
            { patient_last_name: { $regex: patient_name, $options: "i" } },
          ],
        },
        { _id: 1 },
      ).lean();

      filterPatientIds = patients.map((p) => p._id);

      // Early exit if no patients found
      if (filterPatientIds.length === 0) {
        return res.status(200).json({
          message: "No payments found matching the specified criteria",
          analysis: [],
          summary: getEmptySummary(),
          pagination: getEmptyPagination(page, limitNum, offsetNum),
          filters_applied: req.query,
        });
      }
    }

    if (doctor_name) {
      const doctors = await req.orgDb
        .collection("doctors")
        .find(
          {
            $or: [
              { doctor_first_name: { $regex: doctor_name, $options: "i" } },
              { doctor_last_name: { $regex: doctor_name, $options: "i" } },
            ],
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      filterDoctorIds = doctors.map((d) => d._id);

      // Early exit if no doctors found
      if (filterDoctorIds.length === 0) {
        return res.status(200).json({
          message: "No payments found matching the specified criteria",
          analysis: [],
          summary: getEmptySummary(),
          pagination: getEmptyPagination(page, limitNum, offsetNum),
          filters_applied: req.query,
        });
      }
    }

    // ---------------------------------------------------------
    // STEP 2: Build Optimized Aggregation Pipeline
    // ---------------------------------------------------------
    const pipeline = [];
    const matchStage = {};

    // Filters
    if (filterDoctorIds !== null) {
      matchStage.doctor_id = { $in: filterDoctorIds };
    } else if (doctor_id) {
      matchStage.doctor_id = new mongoose.Types.ObjectId(doctor_id);
    }

    if (filterPatientIds !== null) {
      matchStage.patient_id = { $in: filterPatientIds };
    } else if (patient_id) {
      matchStage.patient_id = new mongoose.Types.ObjectId(patient_id);
    }

    if (therapy_plan_id) {
      matchStage.therapy_plan_id = new mongoose.Types.ObjectId(therapy_plan_id);
    }

    // Payment type filter (normalize)
    if (payment_type) {
      const typeUpper = payment_type.toUpperCase();
      matchStage.type = {
        $in: [
          payment_type,
          typeUpper,
          payment_type.toLowerCase(),
          payment_type.charAt(0).toUpperCase() +
            payment_type.slice(1).toLowerCase(),
        ],
      };
    }

    if (therapy_type) matchStage.therepy_type = therapy_type;

    // Amount range filter
    if (min_amount || max_amount) {
      matchStage.amount = {};
      if (min_amount) matchStage.amount.$gte = parseFloat(min_amount);
      if (max_amount) matchStage.amount.$lte = parseFloat(max_amount);
    }

    // Date range filters
    if (date_from || date_to) {
      matchStage.date = {};
      if (date_from) {
        const startDate = new Date(date_from);
        startDate.setHours(0, 0, 0, 0);
        matchStage.date.$gte = startDate;
      }
      if (date_to) {
        const endDate = new Date(date_to);
        endDate.setHours(23, 59, 59, 999);
        matchStage.date.$lte = endDate;
      }
    }

    // Addon services filter
    if (has_addon_services === "true") {
      matchStage.addon_services = { $exists: true, $ne: [] };
    } else if (has_addon_services === "false") {
      matchStage.$or = [
        { addon_services: { $exists: false } },
        { addon_services: [] },
      ];
    }

    // OPTIMIZED: Handle location filter at payment level first
    // Check if payment has location_id field directly
    if (location_id) {
      matchStage.$or = [
        { location_id: location_id }, // Direct match on payment
        { location_id: { $exists: false } }, // Or doesn't exist (will check therapy plan)
      ];
    }

    // Add initial match stage
    if (Object.keys(matchStage).length > 0) {
      pipeline.push({ $match: matchStage });
    }

    // --- NEW: Lookup Invoice Details ---
    pipeline.push({
      $lookup: {
        from: "invoices",
        localField: "invoice_id",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              invoice_number: 1,
              recipient_snapshot: 1,
              recipient_type: 1,
            },
          },
        ],
        as: "invoice_info",
      },
    });

    pipeline.push({
      $unwind: { path: "$invoice_info", preserveNullAndEmptyArrays: true },
    });
    // -----------------------------------

    // OPTIMIZED: Conditionally lookup therapy plans only when needed
    const needsTherapyPlanLookup =
      !group_by || // Need details for ungrouped data
      location_id || // Need location filtering
      group_by === "location"; // Need location for grouping

    if (needsTherapyPlanLookup) {
      // Lookup therapy plans with minimal projection
      pipeline.push({
        $lookup: {
          from: "plans",
          localField: "therapy_plan_id",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                therapy_name: 1,
                total_amount: 1,
                received_amount: 1,
                balance: 1,
                patient_therapy_category: 1,
                location_id: 1,
                location_name: 1,
              },
            },
          ],
          as: "therapyPlan",
        },
      });

      // Extract location fields - handle both payment-level and plan-level locations
      pipeline.push({
        $addFields: {
          therapyPlanFirst: { $arrayElemAt: ["$therapyPlan", 0] },
          // Use payment's location if exists, otherwise use plan's location
          effective_location_id: {
            $ifNull: [
              "$location_id",
              {
                $ifNull: [
                  { $arrayElemAt: ["$therapyPlan.location_id", 0] },
                  null,
                ],
              },
            ],
          },
          effective_location_name: {
            $ifNull: [
              "$location_name",
              {
                $ifNull: [
                  { $arrayElemAt: ["$therapyPlan.location_name", 0] },
                  "Unknown Location",
                ],
              },
            ],
          },
        },
      });

      // Apply location filter on effective location
      if (location_id) {
        pipeline.push({
          $match: {
            effective_location_id: location_id,
          },
        });
      }
    }

    // Sorting stage
    const sortStage = {};
    switch (sortBy) {
      case "date":
      case "date_desc":
        sortStage.date = -1;
        break;
      case "date_asc":
        sortStage.date = 1;
        break;
      case "amount_desc":
        sortStage.amount = -1;
        break;
      case "amount_asc":
        sortStage.amount = 1;
        break;
      case "payment_type":
        sortStage.type = 1;
        break;
      default:
        sortStage.date = -1;
    }
    pipeline.push({ $sort: sortStage });

    // OPTIMIZED: Build summary aggregation based on what's needed
    const summaryGroupStage = {
      _id: null,
      total_amount: { $sum: "$amount" },
      total_addon_amount: {
        $sum: {
          $reduce: {
            input: { $ifNull: ["$addon_services", []] },
            initialValue: 0,
            in: {
              $add: [
                "$$value",
                { $toDouble: { $ifNull: ["$$this.amount", 0] } },
              ],
            },
          },
        },
      },
      unique_patients: { $addToSet: "$patient_id" },
      unique_doctors: { $addToSet: "$doctor_id" },
      unique_plans: { $addToSet: "$therapy_plan_id" },
      payment_types: { $push: { type: "$type", amount: "$amount" } },
      therapy_types: { $push: { type: "$therepy_type", amount: "$amount" } },
      doctor_collections: {
        $push: { doctor_id: "$doctor_id", amount: "$amount" },
      },
      monthly_data: { $push: { date: "$date", amount: "$amount" } },
    };

    // Add location breakdown only if we have location data
    if (needsTherapyPlanLookup) {
      summaryGroupStage.location_breakdown = {
        $push: {
          location_id: "$effective_location_id",
          location_name: "$effective_location_name",
          amount: "$amount",
        },
      };
    }

    // Use $facet for parallel processing
    const facetPipeline = [
      ...pipeline,
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [{ $skip: offsetNum }, { $limit: limitNum }],
          summary: [{ $group: summaryGroupStage }],
        },
      },
    ];

    // OPTIMIZED: Execute aggregation and conditional lookups in parallel
    const lookupPromises = [Payment.aggregate(facetPipeline).exec()];

    // Only fetch patients/doctors if needed for display
    if (!group_by || sortBy === "patient_name" || sortBy === "doctor_name") {
      lookupPromises.push(
        patient_name || !group_by
          ? Patient.find(
              patient_name ? { _id: { $in: filterPatientIds } } : {},
              {
                patient_first_name: 1,
                patient_last_name: 1,
                patient_phone: 1,
                patient_email: 1,
                status: 1,
              },
            ).lean()
          : Promise.resolve([]),
      );

      lookupPromises.push(
        req.orgDb
          .collection("doctors")
          .find(doctor_name ? { _id: { $in: filterDoctorIds } } : {}, {
            projection: {
              doctor_first_name: 1,
              doctor_last_name: 1,
              doctor_email: 1,
              doctor_phone: 1,
            },
          })
          .toArray(),
      );
    } else {
      lookupPromises.push(Promise.resolve([]), Promise.resolve([]));
    }

    const [aggregationResult, patientLookup, doctorLookup] =
      await Promise.all(lookupPromises);

    const result = aggregationResult[0];
    const totalCount = result.metadata[0]?.total || 0;
    const payments = result.data || [];
    const summaryData = result.summary[0] || {};

    // Early return if no payments found
    if (totalCount === 0) {
      return res.status(200).json({
        message: "No payments found matching the specified criteria",
        analysis: [],
        summary: getEmptySummary(),
        pagination: getEmptyPagination(page, limitNum, offsetNum),
        filters_applied: req.query,
      });
    }

    // Create lookup maps only if needed
    const patientMap = new Map();
    const doctorMap = new Map();

    if (patientLookup.length > 0) {
      for (const patient of patientLookup) {
        patientMap.set(patient._id.toString(), {
          name: `${patient.patient_first_name || "Unknown"} ${
            patient.patient_last_name || "Patient"
          }`,
          phone: patient.patient_phone || "N/A",
          email: patient.patient_email || "N/A",
          status: patient.status || "Active",
        });
      }
    }

    if (doctorLookup.length > 0) {
      for (const doctor of doctorLookup) {
        doctorMap.set(doctor._id.toString(), {
          name: `${doctor.doctor_first_name || "Unknown"} ${
            doctor.doctor_last_name || "Doctor"
          }`.trim(),
          email: doctor.doctor_email || "N/A",
          phone: doctor.doctor_phone || "N/A",
        });
      }
    }

    // Process summary data
    const summary = buildSummary(
      summaryData,
      doctorMap,
      needsTherapyPlanLookup,
    );

    // Process payments for response
    let analysisData = payments.map((payment) => {
      // Use existing formatPaymentData logic, but we need to override the patient info
      // if invoice info is present inside the payment object now.
      const formatted = formatPaymentData(
        payment,
        patientMap,
        doctorMap,
        needsTherapyPlanLookup,
      );

      // --- Custom Logic for Invoice Recipients ---
      if (payment.invoice_info && payment.invoice_info.recipient_snapshot) {
        formatted.patient_info.patient_name =
          payment.invoice_info.recipient_snapshot.name;
        formatted.patient_info.patient_phone =
          payment.invoice_info.recipient_snapshot.phone || "N/A";
        formatted.patient_info.patient_email =
          payment.invoice_info.recipient_snapshot.email || "N/A";

        // Optionally indicate it's an invoice payment
        formatted.payment_details.invoice_number =
          payment.invoice_info.invoice_number;
        formatted.patient_info.recipient_type =
          payment.invoice_info.recipient_type;
      }
      return formatted;
    });

    // Re-sort for patient_name and doctor_name
    if (sortBy === "patient_name" || sortBy === "doctor_name") {
      analysisData.sort((a, b) => {
        if (sortBy === "patient_name") {
          return a.patient_info.patient_name.localeCompare(
            b.patient_info.patient_name,
          );
        } else {
          return a.doctor_info.doctor_name.localeCompare(
            b.doctor_info.doctor_name,
          );
        }
      });
    }

    // Group by functionality
    let groupedData = null;
    if (group_by && group_by !== "none") {
      groupedData = groupPayments(analysisData, group_by);
    }

    // Pagination
    const totalPages = Math.ceil(totalCount / limitNum);
    const currentPage = page
      ? parseInt(page)
      : Math.floor(offsetNum / limitNum) + 1;

    const paginatedData = groupedData || analysisData;

    return res.status(200).json({
      message: "Payment collection analysis retrieved successfully",
      summary,
      analysis: paginatedData,
      grouped_data: groupedData
        ? { grouped_by: group_by, data: groupedData }
        : null,
      pagination: groupedData
        ? null
        : {
            total_count: totalCount,
            current_page: currentPage,
            total_pages: totalPages,
            page_size: limitNum,
            offset: offsetNum,
            showing_from: offsetNum + 1,
            showing_to: Math.min(offsetNum + limitNum, totalCount),
            has_next_page: offsetNum + limitNum < totalCount,
            has_previous_page: offsetNum > 0,
            next_page:
              offsetNum + limitNum < totalCount ? currentPage + 1 : null,
            previous_page: offsetNum > 0 ? currentPage - 1 : null,
          },
      filters_applied: {
        ...req.query,
        location_filter: location_id || "all",
      },
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error in getPaymentCollectionAnalysis:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Helper function to get empty summary
function getEmptySummary() {
  return {
    overview: {
      total_payments: 0,
      total_amount_collected: 0,
      average_payment_amount: 0,
      total_addon_revenue: 0,
      addon_percentage: 0,
    },
    entity_counts: {
      unique_patients: 0,
      unique_doctors: 0,
      unique_therapy_plans: 0,
    },
    payment_type_breakdown: [],
    therapy_type_breakdown: [],
    top_collecting_doctors: [],
    location_breakdown: [],
    monthly_trend: [],
  };
}

// Helper function to get empty pagination
function getEmptyPagination(page, limitNum, offsetNum) {
  return {
    total_count: 0,
    current_page: page ? parseInt(page) : Math.floor(offsetNum / limitNum) + 1,
    total_pages: 0,
    page_size: limitNum,
    offset: offsetNum,
    has_next_page: false,
    has_previous_page: offsetNum > 0,
  };
}

// Helper function to format payment data
function formatPaymentData(payment, patientMap, doctorMap, includeLocation) {
  const patientInfo = payment.patient_id
    ? patientMap.get(payment.patient_id.toString()) || {
        name: "Unknown Patient",
        phone: "N/A",
        email: "N/A",
        status: "Unknown",
      }
    : { name: "Walk-in Patient", phone: "N/A", email: "N/A", status: "N/A" };

  const doctorInfo = payment.doctor_id
    ? doctorMap.get(payment.doctor_id.toString()) || {
        name: "Unknown Doctor",
        email: "N/A",
        phone: "N/A",
      }
    : { name: "Unknown Doctor", email: "N/A", phone: "N/A" };

  const therapyPlanInfo = payment.therapyPlanFirst || {
    therapy_name: "N/A",
    patient_therapy_category: "N/A",
    total_amount: 0,
    received_amount: 0,
    balance: 0,
  };

  const addonServices = payment.addon_services || [];
  const addonTotal = addonServices.reduce(
    (sum, addon) => sum + (parseFloat(addon.amount) || 0),
    0,
  );
  const paymentAmount = parseFloat(payment.amount) || 0;
  const baseAmount = paymentAmount - addonTotal;

  const paymentType = payment.type || "Unknown";
  const normalizedPaymentType =
    paymentType.toUpperCase() === "CASH" || paymentType.toLowerCase() === "cash"
      ? "Cash"
      : paymentType.toUpperCase() === "ONLINE" ||
          paymentType.toLowerCase() === "online"
        ? "Online"
        : paymentType === "card"
          ? "Card"
          : paymentType;

  const result = {
    payment_id: payment._id,
    payment_details: {
      amount: paymentAmount,
      base_amount: baseAmount,
      addon_amount: addonTotal,
      payment_type: normalizedPaymentType,
      payment_number: payment.payment_number || "N/A",
      date: payment.date,
      therapy_type: payment.therepy_type || "N/A",
    },
    patient_info: {
      patient_id: payment.patient_id,
      patient_name: patientInfo.name,
      patient_phone: patientInfo.phone,
      patient_email: patientInfo.email,
      patient_status: patientInfo.status,
    },
    doctor_info: {
      doctor_id: payment.doctor_id,
      doctor_name: doctorInfo.name,
      doctor_email: doctorInfo.email,
      doctor_phone: doctorInfo.phone,
    },
    therapy_plan_info: {
      therapy_plan_id: payment.therapy_plan_id,
      therapy_name: therapyPlanInfo.therapy_name || "N/A",
      therapy_category: therapyPlanInfo.patient_therapy_category || "N/A",
      plan_total_amount: parseFloat(therapyPlanInfo.total_amount) || 0,
      plan_received_amount: parseFloat(therapyPlanInfo.received_amount) || 0,
      plan_balance: parseFloat(therapyPlanInfo.balance) || 0,
    },
    addon_services: addonServices.map((addon) => ({
      name: addon.name || "N/A",
      amount: parseFloat(addon.amount) || 0,
    })),
    payment_context: {
      balance_after_payment: parseFloat(payment.balance_after_payment) || null,
      received_amount_total: parseFloat(payment.received_amount_total) || null,
      therapy_session_id: payment.therapyId || null,
    },
  };

  // Add location info if available
  if (includeLocation) {
    result.location_info = {
      location_id: payment.effective_location_id || payment.location_id || null,
      location_name:
        payment.effective_location_name || payment.location_name || "N/A",
    };
  }

  return result;
}

// Helper function to build summary
function buildSummary(summaryData, doctorMap, includeLocation) {
  const totalAmountCollected = summaryData.total_amount || 0;
  const totalAddonRevenue = summaryData.total_addon_amount || 0;
  const totalCount = summaryData.unique_patients
    ? summaryData.unique_patients.filter((id) => id).length
    : 0;

  // Process payment type breakdown
  const paymentTypeMap = new Map();
  for (const item of summaryData.payment_types || []) {
    if (item.type) {
      const normalized =
        item.type.toUpperCase() === "CASH" || item.type.toLowerCase() === "cash"
          ? "Cash"
          : item.type.toUpperCase() === "ONLINE" ||
              item.type.toLowerCase() === "online"
            ? "Online"
            : item.type === "card"
              ? "Card"
              : item.type;
      paymentTypeMap.set(
        normalized,
        (paymentTypeMap.get(normalized) || 0) + (item.amount || 0),
      );
    }
  }

  // Process therapy type breakdown
  const therapyTypeMap = new Map();
  for (const item of summaryData.therapy_types || []) {
    if (item.type) {
      therapyTypeMap.set(
        item.type,
        (therapyTypeMap.get(item.type) || 0) + (item.amount || 0),
      );
    }
  }

  // Process doctor collections
  const doctorCollectionsMap = new Map();
  for (const item of summaryData.doctor_collections || []) {
    if (item.doctor_id) {
      const docId = item.doctor_id.toString();
      if (!doctorCollectionsMap.has(docId)) {
        const doctorInfo = doctorMap.get(docId) || { name: "Unknown Doctor" };
        doctorCollectionsMap.set(docId, {
          doctor_name: doctorInfo.name,
          total_collected: 0,
          payment_count: 0,
        });
      }
      const doc = doctorCollectionsMap.get(docId);
      doc.total_collected += item.amount || 0;
      doc.payment_count += 1;
    }
  }

  // Process monthly collections
  const monthlyMap = new Map();
  for (const item of summaryData.monthly_data || []) {
    if (item.date) {
      const date = new Date(item.date);
      const monthKey = `${date.getFullYear()}-${String(
        date.getMonth() + 1,
      ).padStart(2, "0")}`;
      monthlyMap.set(
        monthKey,
        (monthlyMap.get(monthKey) || 0) + (item.amount || 0),
      );
    }
  }

  const summary = {
    overview: {
      total_payments: totalCount,
      total_amount_collected: Math.round(totalAmountCollected * 100) / 100,
      average_payment_amount:
        totalCount > 0
          ? Math.round((totalAmountCollected / totalCount) * 100) / 100
          : 0,
      total_addon_revenue: Math.round(totalAddonRevenue * 100) / 100,
      addon_percentage:
        totalAmountCollected > 0
          ? Math.round((totalAddonRevenue / totalAmountCollected) * 100 * 100) /
            100
          : 0,
    },
    entity_counts: {
      unique_patients: (summaryData.unique_patients || []).filter((id) => id)
        .length,
      unique_doctors: (summaryData.unique_doctors || []).filter((id) => id)
        .length,
      unique_therapy_plans: (summaryData.unique_plans || []).filter((id) => id)
        .length,
    },
    payment_type_breakdown: Array.from(paymentTypeMap.entries())
      .map(([type, amount]) => ({
        payment_type: type,
        total_amount: Math.round(amount * 100) / 100,
        percentage:
          totalAmountCollected > 0
            ? Math.round((amount / totalAmountCollected) * 100 * 100) / 100
            : 0,
      }))
      .sort((a, b) => b.total_amount - a.total_amount),
    therapy_type_breakdown: Array.from(therapyTypeMap.entries())
      .map(([type, amount]) => ({
        therapy_type: type,
        total_amount: Math.round(amount * 100) / 100,
        percentage:
          totalAmountCollected > 0
            ? Math.round((amount / totalAmountCollected) * 100 * 100) / 100
            : 0,
      }))
      .sort((a, b) => b.total_amount - a.total_amount),
    top_collecting_doctors: Array.from(doctorCollectionsMap.values())
      .sort((a, b) => b.total_collected - a.total_collected)
      .slice(0, 10)
      .map((doc) => ({
        doctor_name: doc.doctor_name,
        total_collected: Math.round(doc.total_collected * 100) / 100,
        payment_count: doc.payment_count,
        average_per_payment:
          Math.round((doc.total_collected / doc.payment_count) * 100) / 100,
      })),
    monthly_trend: Array.from(monthlyMap.entries())
      .map(([month, amount]) => ({
        month,
        total_amount: Math.round(amount * 100) / 100,
      }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };

  // Add location breakdown if available
  if (includeLocation && summaryData.location_breakdown) {
    const locationMap = new Map();
    for (const item of summaryData.location_breakdown || []) {
      if (item.location_id) {
        const locId = item.location_id.toString();
        if (!locationMap.has(locId)) {
          locationMap.set(locId, {
            location_id: locId,
            location_name: item.location_name || "Unknown Location",
            total_collected: 0,
            payment_count: 0,
          });
        }
        const loc = locationMap.get(locId);
        loc.total_collected += item.amount || 0;
        loc.payment_count += 1;
      }
    }

    summary.location_breakdown = Array.from(locationMap.values())
      .sort((a, b) => b.total_collected - a.total_collected)
      .map((loc) => ({
        location_id: loc.location_id,
        location_name: loc.location_name,
        total_collected: Math.round(loc.total_collected * 100) / 100,
        payment_count: loc.payment_count,
        average_per_payment:
          Math.round((loc.total_collected / loc.payment_count) * 100) / 100,
        percentage:
          totalAmountCollected > 0
            ? Math.round(
                (loc.total_collected / totalAmountCollected) * 100 * 100,
              ) / 100
            : 0,
      }));
  }

  return summary;
}

// Helper function to group payments
function groupPayments(analysisData, group_by) {
  const groupedData = {};

  for (const item of analysisData) {
    let groupKey;

    switch (group_by) {
      case "doctor":
        groupKey = item.doctor_info.doctor_name;
        break;
      case "payment_type":
        groupKey = item.payment_details.payment_type;
        break;
      case "therapy_type":
        groupKey = item.payment_details.therapy_type;
        break;
      case "date":
        const date = new Date(item.payment_details.date);
        groupKey = date.toISOString().split("T")[0];
        break;
      case "location":
        groupKey = item.location_info
          ? item.location_info.location_name
          : "Unknown Location";
        break;
      default:
        groupKey = "Other";
    }

    if (!groupedData[groupKey]) {
      groupedData[groupKey] = {
        group_name: groupKey,
        payment_count: 0,
        total_amount: 0,
        total_addon_amount: 0,
        payments: [],
      };
    }

    groupedData[groupKey].payment_count += 1;
    groupedData[groupKey].total_amount += item.payment_details.amount;
    groupedData[groupKey].total_addon_amount +=
      item.payment_details.addon_amount;
    groupedData[groupKey].payments.push(item);
  }

  return Object.values(groupedData).sort(
    (a, b) => b.total_amount - a.total_amount,
  );
}
const ExcelJS = require("exceljs");

const exportPaymentCollectionToExcel = async (req, res) => {
  try {
    // Extract all query parameters (same as the analysis endpoint)
    const {
      patient_name,
      doctor_name,
      doctor_id,
      payment_type,
      therapy_type,
      min_amount,
      max_amount,
      date_from,
      date_to,
      therapy_plan_id,
      patient_id,
      has_addon_services,
      location_id,
    } = req.query;

    // Pre-fetch IDs for Name Search
    let filterPatientIds = null;
    let filterDoctorIds = null;

    if (patient_name) {
      const patients = await req.orgDb
        .collection("patients")
        .find(
          {
            $or: [
              { patient_first_name: { $regex: patient_name, $options: "i" } },
              { patient_last_name: { $regex: patient_name, $options: "i" } },
            ],
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      filterPatientIds = patients.map((p) => p._id);
    }

    if (doctor_name) {
      const doctors = await req.orgDb
        .collection("doctors")
        .find(
          {
            $or: [
              { doctor_first_name: { $regex: doctor_name, $options: "i" } },
              { doctor_last_name: { $regex: doctor_name, $options: "i" } },
            ],
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      filterDoctorIds = doctors.map((d) => d._id);
    }

    // Build aggregation pipeline
    const pipeline = [];
    const matchStage = {};

    // Apply all filters
    if (filterDoctorIds !== null) {
      matchStage.doctor_id = { $in: filterDoctorIds };
    } else if (doctor_id) {
      matchStage.doctor_id = new mongoose.Types.ObjectId(doctor_id);
    }

    if (filterPatientIds !== null) {
      matchStage.patient_id = { $in: filterPatientIds };
    } else if (patient_id) {
      matchStage.patient_id = new mongoose.Types.ObjectId(patient_id);
    }

    if (therapy_plan_id)
      matchStage.therapy_plan_id = new mongoose.Types.ObjectId(therapy_plan_id);

    if (payment_type) {
      const typeUpper = payment_type.toUpperCase();
      matchStage.type = {
        $in: [
          payment_type,
          typeUpper,
          payment_type.toLowerCase(),
          payment_type.charAt(0).toUpperCase() +
            payment_type.slice(1).toLowerCase(),
        ],
      };
    }

    if (therapy_type) matchStage.therepy_type = therapy_type;

    if (min_amount || max_amount) {
      matchStage.amount = {};
      if (min_amount) matchStage.amount.$gte = parseFloat(min_amount);
      if (max_amount) matchStage.amount.$lte = parseFloat(max_amount);
    }

    if (date_from || date_to) {
      matchStage.date = {};
      if (date_from) {
        const startDate = new Date(date_from);
        startDate.setHours(0, 0, 0, 0);
        matchStage.date.$gte = startDate;
      }
      if (date_to) {
        const endDate = new Date(date_to);
        endDate.setHours(23, 59, 59, 999);
        matchStage.date.$lte = endDate;
      }
    }

    if (has_addon_services === "true") {
      matchStage.addon_services = { $exists: true, $ne: [] };
    } else if (has_addon_services === "false") {
      matchStage.$or = [
        { addon_services: { $exists: false } },
        { addon_services: [] },
      ];
    }

    if (Object.keys(matchStage).length > 0) {
      pipeline.push({ $match: matchStage });
    }

    // Lookup therapy plans for location
    pipeline.push({
      $lookup: {
        from: "plans",
        localField: "therapy_plan_id",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              therapy_name: 1,
              total_amount: 1,
              received_amount: 1,
              balance: 1,
              patient_therapy_category: 1,
              location_id: 1,
              location_name: 1,
            },
          },
        ],
        as: "therapyPlan",
      },
    });

    pipeline.push({
      $addFields: {
        therapyPlanFirst: { $arrayElemAt: ["$therapyPlan", 0] },
      },
    });

    pipeline.push({
      $addFields: {
        location_id: "$therapyPlanFirst.location_id",
        location_name: "$therapyPlanFirst.location_name",
      },
    });

    // Apply location filter
    if (location_id) {
      pipeline.push({
        $match: {
          location_id: location_id,
        },
      });
    }

    // Sort by date descending
    pipeline.push({ $sort: { date: -1 } });

    // Fetch ALL payments (no pagination)
    const payments = await req.orgDb
      .collection("payments")
      .aggregate(pipeline)
      .toArray();

    // Fetch all patients and doctors for lookup
    const [patientLookup, doctorLookup] = await Promise.all([
      req.orgDb
        .collection("patients")
        .find(
          {},
          {
            projection: {
              patient_first_name: 1,
              patient_last_name: 1,
              patient_phone: 1,
              patient_email: 1,
            },
          },
        )
        .toArray(),
      req.orgDb
        .collection("doctors")
        .find(
          {},
          {
            projection: {
              doctor_first_name: 1,
              doctor_last_name: 1,
              doctor_email: 1,
            },
          },
        )
        .toArray(),
    ]);

    // Create lookup maps
    const patientMap = new Map();
    for (const patient of patientLookup) {
      patientMap.set(patient._id.toString(), {
        name: `${patient.patient_first_name || ""} ${
          patient.patient_last_name || ""
        }`.trim(),
        phone: patient.patient_phone || "N/A",
        email: patient.patient_email || "N/A",
      });
    }

    const doctorMap = new Map();
    for (const doctor of doctorLookup) {
      doctorMap.set(
        doctor._id.toString(),
        `${doctor.doctor_first_name || ""} ${
          doctor.doctor_last_name || ""
        }`.trim(),
      );
    }

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Payment Collection");

    // Define columns - matching frontend table exactly
    worksheet.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Patient", key: "patient_name", width: 20 },
      { header: "Doctor", key: "doctor_name", width: 20 },
      { header: "Therapy", key: "therapy_name", width: 25 },
      { header: "Payment Type", key: "payment_type", width: 12 },
      { header: "Location", key: "location", width: 20 },
      { header: "Base Amount", key: "base_amount", width: 12 },
      { header: "Addon", key: "addon_amount", width: 12 },
      { header: "Total", key: "total_amount", width: 12 },
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF007B8E" },
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };

    // Add data rows
    payments.forEach((payment) => {
      const patientInfo = payment.patient_id
        ? patientMap.get(payment.patient_id.toString()) || {}
        : {};
      const doctorName = payment.doctor_id
        ? doctorMap.get(payment.doctor_id.toString()) || "Unknown"
        : "Unknown";
      const therapyPlan = payment.therapyPlanFirst || {};

      const addonServices = payment.addon_services || [];
      const addonTotal = addonServices.reduce(
        (sum, addon) => sum + (parseFloat(addon.amount) || 0),
        0,
      );
      const paymentAmount = parseFloat(payment.amount) || 0;
      const baseAmount = paymentAmount - addonTotal;

      worksheet.addRow({
        date: new Date(payment.date).toLocaleDateString("en-IN"),
        payment_number: payment.payment_number || "N/A",
        patient_name: patientInfo.name || "Walk-in",
        patient_phone: patientInfo.phone || "N/A",
        doctor_name: doctorName,
        therapy_name: therapyPlan.therapy_name || "N/A",
        therapy_type: payment.therepy_type || "N/A",
        payment_type: payment.type || "N/A",
        location: payment.location_name || "N/A",
        base_amount: baseAmount.toFixed(2),
        addon_amount: addonTotal.toFixed(2),
        total_amount: paymentAmount.toFixed(2),
        plan_balance: parseFloat(therapyPlan.balance || 0).toFixed(2),
      });
    });

    // Add summary row
    const totalAmount = payments.reduce(
      (sum, p) => sum + (parseFloat(p.amount) || 0),
      0,
    );
    worksheet.addRow({});
    const summaryRow = worksheet.addRow({
      date: "TOTAL",
      total_amount: totalAmount.toFixed(2),
    });
    summaryRow.font = { bold: true };
    summaryRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    // Set response headers
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=payment_collection_${
        new Date().toISOString().split("T")[0]
      }.xlsx`,
    );

    // Write to response
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error exporting to Excel:", error);
    return res.status(500).json({
      message: "Error generating Excel file",
      error: error.message,
    });
  }
};

const getPatientTherapyAnalysis = async (req, res) => {
  try {
    // Extract and validate query parameters
    const {
      sortBy = "activity_status",
      limit = 10,
      offset = 0,
      page,
      patient_name,
      therapy_name,
      activity_status,
      doctor_name,
      doctor_id,
      therapy_category,
      location_name,
      location_address,
      location_id,
      min_sessions,
      max_sessions,
      inactive_days = 14,
      payment_status,
      created_after,
      created_before,
      has_upcoming_sessions,
    } = req.query;

    // Enhanced pagination logic
    const limitNum = Math.min(parseInt(limit) || 10, 100);
    let offsetNum = parseInt(offset) || 0;

    if (page && !isNaN(parseInt(page))) {
      const pageNum = Math.max(1, parseInt(page));
      offsetNum = (pageNum - 1) * limitNum;
    }

    if (offsetNum < 0 || limitNum <= 0) {
      return res.status(400).json({
        message: "Invalid pagination parameters",
        error:
          offsetNum < 0
            ? "Offset cannot be negative"
            : "Limit must be greater than 0",
      });
    }

    // Calculate dates
    const currentDate = new Date();
    const today = currentDate.toISOString().split("T")[0];
    currentDate.setHours(0, 0, 0, 0);
    const inactiveDays = parseInt(inactive_days) || 14;
    const inactivityThreshold = new Date(
      currentDate - inactiveDays * 24 * 60 * 60 * 1000,
    );

    // Build match stage for therapy plans
    const planMatchStage = { $match: {} };

    if (therapy_name) {
      planMatchStage.$match.therapy_name = {
        $regex: therapy_name,
        $options: "i",
      };
    }
    if (therapy_category) {
      planMatchStage.$match.patient_therapy_category = {
        $regex: therapy_category,
        $options: "i",
      };
    }
    if (location_name) {
      planMatchStage.$match.location_name = {
        $regex: location_name,
        $options: "i",
      };
    }
    if (location_address) {
      planMatchStage.$match.location_address = {
        $regex: location_address,
        $options: "i",
      };
    }
    if (location_id) {
      planMatchStage.$match.location_id = location_id;
    }
    if (doctor_id) {
      planMatchStage.$match.created_by = new mongoose.Types.ObjectId(doctor_id);
    }
    if (min_sessions || max_sessions) {
      planMatchStage.$match.estimated_sessions = {};
      if (min_sessions)
        planMatchStage.$match.estimated_sessions.$gte = parseInt(min_sessions);
      if (max_sessions)
        planMatchStage.$match.estimated_sessions.$lte = parseInt(max_sessions);
    }
    if (created_after || created_before) {
      planMatchStage.$match.$and = planMatchStage.$match.$and || [];
      if (created_after) {
        planMatchStage.$match.$and.push({
          $or: [
            { createdAt: { $gte: new Date(created_after) } },
            { created_date: { $gte: new Date(created_after) } },
          ],
        });
      }
      if (created_before) {
        planMatchStage.$match.$and.push({
          $or: [
            { createdAt: { $lte: new Date(created_before) } },
            { created_date: { $lte: new Date(created_before) } },
          ],
        });
      }
    }

    // Build aggregation pipeline
    const pipeline = [
      planMatchStage,

      // Lookup sessions for each plan
      {
        $lookup: {
          from: "therepys",
          localField: "_id",
          foreignField: "plan_id",
          as: "sessions",
        },
      },

      // Lookup patient information
      {
        $lookup: {
          from: "patients",
          let: { plan_id: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $in: ["$$plan_id", { $ifNull: ["$therapy_plans", []] }],
                },
              },
            },
            {
              $project: {
                patient_first_name: 1,
                patient_last_name: 1,
                patient_phone: 1,
                patient_email: 1,
                status: 1,
              },
            },
            { $limit: 1 },
          ],
          as: "patient",
        },
      },

      // Lookup doctor information
      {
        $lookup: {
          from: "doctors",
          localField: "created_by",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                doctor_name: {
                  $concat: [
                    { $ifNull: ["$doctor_first_name", ""] },
                    " ",
                    { $ifNull: ["$doctor_last_name", ""] },
                  ],
                },
                doctor_email: 1,
                doctor_phone: 1,
              },
            },
          ],
          as: "doctor",
        },
      },

      // Unwind patient and doctor arrays
      {
        $addFields: {
          patient: { $arrayElemAt: ["$patient", 0] },
          doctor: { $arrayElemAt: ["$doctor", 0] },
        },
      },

      // Calculate session statistics
      {
        $addFields: {
          completed_sessions_calc: {
            $size: {
              $filter: {
                input: "$sessions",
                as: "session",
                cond: {
                  $eq: [{ $toLower: "$$session.status" }, "completed"],
                },
              },
            },
          },
          scheduled_sessions_calc: {
            $size: {
              $filter: {
                input: "$sessions",
                as: "session",
                cond: {
                  $in: [
                    { $toLower: "$$session.status" },
                    ["scheduled", "in_progress"],
                  ],
                },
              },
            },
          },
          last_session_date: {
            $max: {
              $map: {
                input: {
                  $filter: {
                    input: "$sessions",
                    as: "session",
                    cond: {
                      $eq: [{ $toLower: "$$session.status" }, "completed"],
                    },
                  },
                },
                as: "session",
                in: { $toDate: "$$session.therepy_date" },
              },
            },
          },
          upcoming_sessions_calc: {
            $size: {
              $filter: {
                input: "$sessions",
                as: "session",
                cond: {
                  $and: [
                    {
                      $in: [
                        { $toLower: "$$session.status" },
                        ["scheduled", "in_progress"],
                      ],
                    },
                    {
                      $gte: [
                        { $toDate: "$$session.therepy_date" },
                        currentDate,
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },

      // Calculate activity status
      {
        $addFields: {
          plan_timeline_status: {
            $cond: [
              { $lt: [today, "$therapy_start"] },
              "upcoming",
              {
                $cond: [
                  {
                    $and: [
                      { $gte: [today, "$therapy_start"] },
                      { $lte: [today, "$therapy_end"] },
                    ],
                  },
                  "active",
                  "completed",
                ],
              },
            ],
          },
          days_since_last_session: {
            $cond: [
              { $ne: ["$last_session_date", null] },
              {
                $floor: {
                  $divide: [
                    { $subtract: [currentDate, "$last_session_date"] },
                    86400000,
                  ],
                },
              },
              null,
            ],
          },
        },
      },

      // Determine activity status
      {
        $addFields: {
          activity_status: {
            $cond: [
              { $eq: ["$plan_timeline_status", "completed"] },
              "completed",
              {
                $cond: [
                  { $ne: ["$last_session_date", null] },
                  {
                    $cond: [
                      {
                        $and: [
                          { $gt: ["$days_since_last_session", inactiveDays] },
                          { $eq: ["$upcoming_sessions_calc", 0] },
                        ],
                      },
                      "inactive",
                      "active",
                    ],
                  },
                  {
                    $cond: [
                      { $gt: ["$upcoming_sessions_calc", 0] },
                      "active",
                      "inactive",
                    ],
                  },
                ],
              },
            ],
          },
        },
      },

      // Calculate payment details
      {
        $addFields: {
          total_amount_num: {
            $convert: {
              input: "$total_amount",
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          received_amount_num: {
            $convert: {
              input: "$received_amount",
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          balance_num: {
            $convert: {
              input: "$balance",
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
        },
      },

      {
        $addFields: {
          payment_status_calc: {
            $cond: [
              { $eq: ["$balance_num", 0] },
              "paid",
              {
                $cond: [
                  { $gt: ["$received_amount_num", 0] },
                  "partial",
                  "pending",
                ],
              },
            ],
          },
          payment_progress_percentage: {
            $cond: [
              { $gt: ["$total_amount_num", 0] },
              {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: ["$received_amount_num", "$total_amount_num"],
                      },
                      100,
                    ],
                  },
                  0,
                ],
              },
              0,
            ],
          },
          effective_estimated_sessions: {
            $cond: [
              { $gt: [{ $ifNull: ["$estimated_sessions", 0] }, 0] },
              "$estimated_sessions",
              { $size: "$sessions" },
            ],
          },
        },
      },

      {
        $addFields: {
          remaining_sessions_calc: {
            $max: [
              0,
              {
                $subtract: [
                  "$effective_estimated_sessions",
                  {
                    $add: [
                      "$completed_sessions_calc",
                      "$scheduled_sessions_calc",
                    ],
                  },
                ],
              },
            ],
          },
          session_completion_percentage: {
            $cond: [
              { $gt: ["$effective_estimated_sessions", 0] },
              {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          "$completed_sessions_calc",
                          "$effective_estimated_sessions",
                        ],
                      },
                      100,
                    ],
                  },
                  0,
                ],
              },
              0,
            ],
          },
        },
      },

      // Apply post-aggregation filters
      {
        $match: {
          ...(patient_name && {
            $expr: {
              $regexMatch: {
                input: {
                  $concat: [
                    { $ifNull: ["$patient.patient_first_name", ""] },
                    " ",
                    { $ifNull: ["$patient.patient_last_name", ""] },
                  ],
                },
                regex: patient_name,
                options: "i",
              },
            },
          }),
          ...(doctor_name && {
            $expr: {
              $regexMatch: {
                input: { $ifNull: ["$doctor.doctor_name", ""] },
                regex: doctor_name,
                options: "i",
              },
            },
          }),
          ...(activity_status &&
            activity_status !== "all" && {
              activity_status: activity_status,
            }),
          ...(payment_status && {
            payment_status_calc: payment_status,
          }),
          ...(has_upcoming_sessions === "true" && {
            upcoming_sessions_calc: { $gt: 0 },
          }),
        },
      },

      // Project final structure
      {
        $project: {
          plan_id: "$_id",
          therapy_name: { $ifNull: ["$therapy_name", "N/A"] },
          patient_info: {
            patient_id: "$patient._id",
            patient_name: {
              $concat: [
                { $ifNull: ["$patient.patient_first_name", "Unknown"] },
                " ",
                { $ifNull: ["$patient.patient_last_name", "Patient"] },
              ],
            },
            patient_phone: { $ifNull: ["$patient.patient_phone", "N/A"] },
            patient_email: { $ifNull: ["$patient.patient_email", "N/A"] },
            patient_status: { $ifNull: ["$patient.status", "Active"] },
          },
          doctor_info: {
            doctor_id: "$created_by",
            doctor_name: { $ifNull: ["$doctor.doctor_name", "Unknown Doctor"] },
            doctor_email: { $ifNull: ["$doctor.doctor_email", "N/A"] },
            doctor_phone: { $ifNull: ["$doctor.doctor_phone", "N/A"] },
          },
          location_info: {
            location_id: { $ifNull: ["$location_id", "N/A"] },
            location_name: { $ifNull: ["$location_name", "N/A"] },
            location_address: { $ifNull: ["$location_address", "N/A"] },
          },
          activity_analysis: {
            activity_status: "$activity_status",
            plan_timeline_status: "$plan_timeline_status",
            last_session_date: "$last_session_date",
            days_since_last_session: "$days_since_last_session",
            upcoming_sessions: "$upcoming_sessions_calc",
            is_active: { $eq: ["$activity_status", "active"] },
            inactivity_threshold_days: inactiveDays,
          },
          session_summary: {
            total_sessions: { $size: "$sessions" },
            estimated_sessions: "$effective_estimated_sessions",
            completed_sessions: "$completed_sessions_calc",
            scheduled_sessions: "$scheduled_sessions_calc",
            remaining_sessions: "$remaining_sessions_calc",
            session_completion_percentage: "$session_completion_percentage",
          },
          payment_summary: {
            total_amount: "$total_amount_num",
            received_amount: "$received_amount_num",
            balance: "$balance_num",
            payment_status: "$payment_status_calc",
            payment_progress_percentage: "$payment_progress_percentage",
            payment_type: { $ifNull: ["$payment_type", "one-time"] },
            last_payment_date: "$last_payment_date",
          },
          timeline: {
            therapy_start: "$therapy_start",
            therapy_end: "$therapy_end",
            duration: "$therapy_duration",
            created_date: { $ifNull: ["$createdAt", "$created_date"] },
          },
          additional_info: {
            patient_diagnosis: "$patient_diagnosis",
            patient_symptoms: "$patient_symptoms",
            therapy_category: "$patient_therapy_category",
            status: "$status",
          },
          // Keep these for sorting
          _activity_order: {
            $switch: {
              branches: [
                { case: { $eq: ["$activity_status", "active"] }, then: 1 },
                { case: { $eq: ["$activity_status", "inactive"] }, then: 2 },
                { case: { $eq: ["$activity_status", "completed"] }, then: 3 },
              ],
              default: 4,
            },
          },
        },
      },

      // Sorting
      {
        $sort: (() => {
          switch (sortBy) {
            case "activity_status":
              return { _activity_order: 1 };
            case "last_session":
              return { "activity_analysis.last_session_date": -1 };
            case "patient_name":
              return { "patient_info.patient_name": 1 };
            case "doctor_name":
              return { "doctor_info.doctor_name": 1 };
            case "completed_sessions_desc":
              return { "session_summary.completed_sessions": -1 };
            case "payment_pending_desc":
              return { "payment_summary.balance": -1 };
            case "newest":
              return { "timeline.created_date": -1 };
            default:
              return { _activity_order: 1 };
          }
        })(),
      },

      // Facet for pagination and summary
      {
        $facet: {
          metadata: [{ $count: "total_count" }],
          summary: [
            {
              $group: {
                _id: null,
                total_plans: { $sum: 1 },
                active_plans: {
                  $sum: {
                    $cond: [
                      { $eq: ["$activity_analysis.activity_status", "active"] },
                      1,
                      0,
                    ],
                  },
                },
                inactive_plans: {
                  $sum: {
                    $cond: [
                      {
                        $eq: ["$activity_analysis.activity_status", "inactive"],
                      },
                      1,
                      0,
                    ],
                  },
                },
                completed_plans: {
                  $sum: {
                    $cond: [
                      {
                        $eq: [
                          "$activity_analysis.activity_status",
                          "completed",
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                active_patients: {
                  $addToSet: {
                    $cond: [
                      { $eq: ["$activity_analysis.activity_status", "active"] },
                      "$patient_info.patient_id",
                      null,
                    ],
                  },
                },
                total_sessions_completed: {
                  $sum: "$session_summary.completed_sessions",
                },
                total_revenue: { $sum: "$payment_summary.received_amount" },
                pending_payments: { $sum: "$payment_summary.balance" },
                total_sessions_all: { $sum: "$session_summary.total_sessions" },
              },
            },
            {
              $project: {
                _id: 0,
                total_plans: 1,
                active_plans: 1,
                inactive_plans: 1,
                completed_plans: 1,
                active_patients: {
                  $size: {
                    $filter: {
                      input: "$active_patients",
                      as: "patient",
                      cond: { $ne: ["$$patient", null] },
                    },
                  },
                },
                total_sessions_completed: 1,
                total_revenue: { $round: ["$total_revenue", 2] },
                pending_payments: { $round: ["$pending_payments", 2] },
                average_sessions_per_plan: {
                  $cond: [
                    { $gt: ["$total_plans", 0] },
                    {
                      $round: [
                        { $divide: ["$total_sessions_all", "$total_plans"] },
                        0,
                      ],
                    },
                    0,
                  ],
                },
                average_plan_value: {
                  $cond: [
                    { $gt: ["$total_plans", 0] },
                    {
                      $round: [
                        { $divide: ["$total_revenue", "$total_plans"] },
                        2,
                      ],
                    },
                    0,
                  ],
                },
              },
            },
          ],
          data: [
            { $skip: offsetNum },
            { $limit: limitNum },
            {
              $project: {
                _activity_order: 0,
              },
            },
          ],
        },
      },
    ];

    // Execute aggregation
    const results = await req.orgDb
      .collection("plans")
      .aggregate(pipeline)
      .toArray();

    const totalCount = results[0]?.metadata[0]?.total_count || 0;
    const summaryData = results[0]?.summary[0] || {
      total_plans: 0,
      active_plans: 0,
      inactive_plans: 0,
      completed_plans: 0,
      active_patients: 0,
      total_sessions_completed: 0,
      total_revenue: 0,
      pending_payments: 0,
      average_sessions_per_plan: 0,
      average_plan_value: 0,
    };
    const paginatedData = results[0]?.data || [];

    // Handle no results
    if (totalCount === 0) {
      return res.status(200).json({
        message: "No therapy plans found matching the specified criteria",
        analysis: [],
        summary: {
          overview: {
            total_plans: 0,
            active_plans: 0,
            inactive_plans: 0,
            completed_plans: 0,
            active_patients: 0,
          },
          session_metrics: {
            total_sessions_completed: 0,
            average_sessions_per_plan: 0,
          },
          financial_metrics: {
            total_revenue: 0,
            pending_payments: 0,
            average_plan_value: 0,
          },
          activity_breakdown: {
            active: 0,
            inactive: 0,
            completed: 0,
          },
        },
        pagination: {
          total_count: 0,
          current_page: page
            ? parseInt(page)
            : Math.floor(offsetNum / limitNum) + 1,
          total_pages: 0,
          page_size: limitNum,
          offset: offsetNum,
          has_next_page: false,
          has_previous_page: offsetNum > 0,
        },
        filters_applied: req.query,
      });
    }

    // Calculate pagination
    const totalPages = Math.ceil(totalCount / limitNum);
    const currentPage = page
      ? parseInt(page)
      : Math.floor(offsetNum / limitNum) + 1;

    if (offsetNum >= totalCount && totalCount > 0) {
      return res.status(400).json({
        message: "Invalid pagination parameters",
        error: `Requested page ${currentPage} does not exist. Total pages: ${totalPages}`,
        pagination: {
          total_count: totalCount,
          total_pages: totalPages,
          requested_page: currentPage,
          page_size: limitNum,
        },
      });
    }

    // Build comprehensive summary
    const summary = {
      overview: {
        total_plans: summaryData.total_plans,
        active_plans: summaryData.active_plans,
        inactive_plans: summaryData.inactive_plans,
        completed_plans: summaryData.completed_plans,
        active_patients: summaryData.active_patients,
      },
      session_metrics: {
        total_sessions_completed: summaryData.total_sessions_completed,
        average_sessions_per_plan: summaryData.average_sessions_per_plan,
      },
      financial_metrics: {
        total_revenue: summaryData.total_revenue,
        pending_payments: summaryData.pending_payments,
        average_plan_value: summaryData.average_plan_value,
      },
      activity_breakdown: {
        active: summaryData.active_plans,
        inactive: summaryData.inactive_plans,
        completed: summaryData.completed_plans,
      },
    };

    return res.status(200).json({
      message: "Patient and therapy analysis retrieved successfully",
      summary,
      analysis: paginatedData,
      pagination: {
        total_count: totalCount,
        current_page: currentPage,
        total_pages: totalPages,
        page_size: limitNum,
        offset: offsetNum,
        showing_from: offsetNum + 1,
        showing_to: Math.min(offsetNum + limitNum, totalCount),
        has_next_page: offsetNum + limitNum < totalCount,
        has_previous_page: offsetNum > 0,
        next_page: offsetNum + limitNum < totalCount ? currentPage + 1 : null,
        previous_page: offsetNum > 0 ? currentPage - 1 : null,
      },
      filters_applied: req.query,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error in getPatientTherapyAnalysis:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};
// Alternative endpoint for a more compact view
const getActivePlansCompactView = async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    const activePlans = await req.orgDb
      .collection("plans")
      .find({
        $and: [
          { therapy_start: { $lte: today } },
          { therapy_end: { $gte: today } },
        ],
      })
      .toArray();

    if (!activePlans.length) {
      return res.status(200).json({
        message: "No active therapy plans found",
        plans: [],
      });
    }

    const planIds = activePlans.map((plan) => plan._id);
    const patients = await req.orgDb
      .collection("patients")
      .find(
        { therapy_plans: { $in: planIds } },
        {
          projection: {
            patient_first_name: 1,
            patient_last_name: 1,
            therapy_plans: 1,
          },
        },
      )
      .toArray();

    const planToPatientMap = {};
    patients.forEach((patient) => {
      patient.therapy_plans.forEach((planId) => {
        planToPatientMap[planId.toString()] =
          `${patient.patient_first_name} ${patient.patient_last_name}`;
      });
    });

    const compactPlans = activePlans.map((plan) => {
      const therapySessions = plan.therapy_sessions || [];
      const completedSessions = therapySessions.filter(
        (session) => session.status?.toLowerCase() === "completed",
      ).length;

      return {
        plan_id: plan._id,
        patient_name:
          planToPatientMap[plan._id.toString()] || "Unknown Patient",
        therapy_name: plan.therapy_name,
        received_amount: parseFloat(plan.received_amount || 0),
        balance: parseFloat(plan.balance || 0),
        completed_sessions: completedSessions,
        remaining_sessions: Math.max(
          0,
          (plan.estimated_sessions || 0) - completedSessions,
        ),
        days_remaining: Math.ceil(
          (new Date(plan.therapy_end) - new Date()) / (1000 * 60 * 60 * 24),
        ),
        status:
          parseFloat(plan.balance || 0) > 0
            ? "payment_pending"
            : "payment_complete",
      };
    });

    return res.status(200).json({
      message: "Active therapy plans compact view",
      plans: compactPlans,
      total_plans: compactPlans.length,
    });
  } catch (error) {
    console.error("Error in getActivePlansCompactView:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

const PDFDocument = require("pdfkit");

const exportPaymentCollectionToPDF = async (req, res) => {
  try {
    // Extract all query parameters (same as the analysis endpoint)
    const {
      patient_name,
      doctor_name,
      doctor_id,
      payment_type,
      therapy_type,
      min_amount,
      max_amount,
      date_from,
      date_to,
      therapy_plan_id,
      patient_id,
      has_addon_services,
      location_id,
    } = req.query;

    // Pre-fetch IDs for Name Search
    let filterPatientIds = null;
    let filterDoctorIds = null;

    if (patient_name) {
      const patients = await req.orgDb
        .collection("patients")
        .find(
          {
            $or: [
              { patient_first_name: { $regex: patient_name, $options: "i" } },
              { patient_last_name: { $regex: patient_name, $options: "i" } },
            ],
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      filterPatientIds = patients.map((p) => p._id);
    }

    if (doctor_name) {
      const doctors = await req.orgDb
        .collection("doctors")
        .find(
          {
            $or: [
              { doctor_first_name: { $regex: doctor_name, $options: "i" } },
              { doctor_last_name: { $regex: doctor_name, $options: "i" } },
            ],
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      filterDoctorIds = doctors.map((d) => d._id);
    }

    // Build aggregation pipeline
    const pipeline = [];
    const matchStage = {};

    // Apply all filters
    if (filterDoctorIds !== null) {
      matchStage.doctor_id = { $in: filterDoctorIds };
    } else if (doctor_id) {
      matchStage.doctor_id = new mongoose.Types.ObjectId(doctor_id);
    }

    if (filterPatientIds !== null) {
      matchStage.patient_id = { $in: filterPatientIds };
    } else if (patient_id) {
      matchStage.patient_id = new mongoose.Types.ObjectId(patient_id);
    }

    if (therapy_plan_id)
      matchStage.therapy_plan_id = new mongoose.Types.ObjectId(therapy_plan_id);

    if (payment_type) {
      const typeUpper = payment_type.toUpperCase();
      matchStage.type = {
        $in: [
          payment_type,
          typeUpper,
          payment_type.toLowerCase(),
          payment_type.charAt(0).toUpperCase() +
            payment_type.slice(1).toLowerCase(),
        ],
      };
    }

    if (therapy_type) matchStage.therepy_type = therapy_type;

    if (min_amount || max_amount) {
      matchStage.amount = {};
      if (min_amount) matchStage.amount.$gte = parseFloat(min_amount);
      if (max_amount) matchStage.amount.$lte = parseFloat(max_amount);
    }

    if (date_from || date_to) {
      matchStage.date = {};
      if (date_from) {
        const startDate = new Date(date_from);
        startDate.setHours(0, 0, 0, 0);
        matchStage.date.$gte = startDate;
      }
      if (date_to) {
        const endDate = new Date(date_to);
        endDate.setHours(23, 59, 59, 999);
        matchStage.date.$lte = endDate;
      }
    }

    if (has_addon_services === "true") {
      matchStage.addon_services = { $exists: true, $ne: [] };
    } else if (has_addon_services === "false") {
      matchStage.$or = [
        { addon_services: { $exists: false } },
        { addon_services: [] },
      ];
    }

    if (Object.keys(matchStage).length > 0) {
      pipeline.push({ $match: matchStage });
    }

    // Lookup therapy plans for location
    pipeline.push({
      $lookup: {
        from: "plans",
        localField: "therapy_plan_id",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              therapy_name: 1,
              total_amount: 1,
              received_amount: 1,
              balance: 1,
              patient_therapy_category: 1,
              location_id: 1,
              location_name: 1,
            },
          },
        ],
        as: "therapyPlan",
      },
    });

    pipeline.push({
      $addFields: {
        therapyPlanFirst: { $arrayElemAt: ["$therapyPlan", 0] },
      },
    });

    pipeline.push({
      $addFields: {
        location_id: "$therapyPlanFirst.location_id",
        location_name: "$therapyPlanFirst.location_name",
      },
    });

    // Apply location filter
    if (location_id) {
      pipeline.push({
        $match: {
          location_id: location_id,
        },
      });
    }

    // Sort by date descending
    pipeline.push({ $sort: { date: -1 } });

    // Fetch ALL payments
    const payments = await req.orgDb
      .collection("payments")
      .aggregate(pipeline)
      .toArray();

    // Fetch patients and doctors for lookup
    const [patientLookup, doctorLookup] = await Promise.all([
      req.orgDb
        .collection("patients")
        .find(
          {},
          {
            projection: {
              patient_first_name: 1,
              patient_last_name: 1,
              patient_phone: 1,
            },
          },
        )
        .toArray(),
      req.orgDb
        .collection("doctors")
        .find(
          {},
          {
            projection: {
              doctor_first_name: 1,
              doctor_last_name: 1,
            },
          },
        )
        .toArray(),
    ]);

    // Create lookup maps
    const patientMap = new Map();
    for (const patient of patientLookup) {
      patientMap.set(patient._id.toString(), {
        name: `${patient.patient_first_name || ""} ${
          patient.patient_last_name || ""
        }`.trim(),
        phone: patient.patient_phone || "N/A",
      });
    }

    const doctorMap = new Map();
    for (const doctor of doctorLookup) {
      doctorMap.set(
        doctor._id.toString(),
        `${doctor.doctor_first_name || ""} ${
          doctor.doctor_last_name || ""
        }`.trim(),
      );
    }

    // Create PDF with landscape orientation for more columns
    const doc = new PDFDocument({
      margin: 30,
      size: "A4",
      layout: "landscape",
    });

    // Set response headers
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=payment_collection_${
        new Date().toISOString().split("T")[0]
      }.pdf`,
    );

    // Pipe PDF to response
    doc.pipe(res);

    // Add header
    doc
      .fontSize(20)
      .fillColor("#007B8E")
      .text("Payment Collection Report", { align: "center" });
    doc.moveDown(0.5);
    doc
      .fontSize(10)
      .fillColor("#666666")
      .text(`Generated on: ${new Date().toLocaleString("en-IN")}`, {
        align: "center",
      });
    doc.moveDown(1);

    // Add filters applied section
    doc
      .fontSize(12)
      .fillColor("#000000")
      .text("Filters Applied:", { underline: true });
    doc.fontSize(9).fillColor("#333333");

    const activeFilters = [];
    if (date_from) activeFilters.push(`From: ${date_from}`);
    if (date_to) activeFilters.push(`To: ${date_to}`);
    if (payment_type) activeFilters.push(`Payment Type: ${payment_type}`);
    if (therapy_type) activeFilters.push(`Therapy Type: ${therapy_type}`);
    if (patient_name) activeFilters.push(`Patient: ${patient_name}`);
    if (doctor_name) activeFilters.push(`Doctor: ${doctor_name}`);
    if (location_id) activeFilters.push(`Location Filter Applied`);
    // REPLACED SYMBOL HERE
    if (min_amount) activeFilters.push(`Min Amount: Rs. ${min_amount}`);
    // REPLACED SYMBOL HERE
    if (max_amount) activeFilters.push(`Max Amount: Rs. ${max_amount}`);

    if (activeFilters.length > 0) {
      doc.text(activeFilters.join(" • "));
    } else {
      doc.text("No filters applied (All data)");
    }
    doc.moveDown(1);

    // Calculate summary
    let totalAmount = 0;
    let totalAddon = 0;
    payments.forEach((p) => {
      const amount = parseFloat(p.amount) || 0;
      totalAmount += amount;
      const addonServices = p.addon_services || [];
      const addonTotal = addonServices.reduce(
        (sum, addon) => sum + (parseFloat(addon.amount) || 0),
        0,
      );
      totalAddon += addonTotal;
    });

    // Add summary box
    doc.fontSize(11).fillColor("#000000").text("Summary:", { underline: true });
    doc.fontSize(9);
    doc.text(`Total Payments: ${payments.length}`);
    // REPLACED SYMBOL HERE
    doc.text(`Total Amount Collected: Rs. ${totalAmount.toFixed(2)}`);
    // REPLACED SYMBOL HERE
    doc.text(`Total Addon Revenue: Rs. ${totalAddon.toFixed(2)}`);
    // REPLACED SYMBOL HERE
    doc.text(
      `Average Payment: Rs. ${
        payments.length > 0
          ? (totalAmount / payments.length).toFixed(2)
          : "0.00"
      }`,
    );
    doc.moveDown(1);

    // Add line separator
    doc.moveTo(30, doc.y).lineTo(811, doc.y).stroke("#CCCCCC");
    doc.moveDown(1);

    // Table headers - matching frontend exactly
    const tableTop = doc.y;
    const colWidths = {
      date: 55,
      patient: 85,
      doctor: 80,
      therapy: 85,
      type: 45,
      location: 75,
      base: 50,
      addon: 40,
      total: 50,
    };

    doc.fontSize(8).fillColor("#007B8E");
    doc.text("Date", 30, tableTop, { width: colWidths.date });
    doc.text("Patient", 85, tableTop, { width: colWidths.patient });
    doc.text("Doctor", 170, tableTop, { width: colWidths.doctor });
    doc.text("Therapy", 250, tableTop, { width: colWidths.therapy });
    doc.text("Type", 335, tableTop, { width: colWidths.type });
    doc.text("Location", 380, tableTop, { width: colWidths.location });
    doc.text("Base", 455, tableTop, { width: colWidths.base, align: "right" });
    doc.text("Addon", 505, tableTop, {
      width: colWidths.addon,
      align: "right",
    });
    doc.text("Total", 545, tableTop, {
      width: colWidths.total,
      align: "right",
    });

    doc.moveDown(0.5);

    // Draw header line
    doc.moveTo(30, doc.y).lineTo(640, doc.y).stroke("#007B8E");
    doc.moveDown(0.3);

    // Add payment rows
    doc.fontSize(7).fillColor("#000000");
    let yPosition = doc.y;

    for (const payment of payments) {
      // Check if we need a new page
      if (yPosition > 520) {
        doc.addPage();
        yPosition = 50;

        // Redraw header on new page
        doc.fontSize(8).fillColor("#007B8E");
        doc.text("Date", 30, yPosition, { width: colWidths.date });
        doc.text("Patient", 85, yPosition, { width: colWidths.patient });
        doc.text("Doctor", 170, yPosition, { width: colWidths.doctor });
        doc.text("Therapy", 250, yPosition, { width: colWidths.therapy });
        doc.text("Type", 335, yPosition, { width: colWidths.type });
        doc.text("Location", 380, yPosition, { width: colWidths.location });
        doc.text("Base", 455, yPosition, {
          width: colWidths.base,
          align: "right",
        });
        doc.text("Addon", 505, yPosition, {
          width: colWidths.addon,
          align: "right",
        });
        doc.text("Total", 545, yPosition, {
          width: colWidths.total,
          align: "right",
        });
        yPosition += 15;
        doc.fontSize(7).fillColor("#000000");
      }

      const patientInfo = payment.patient_id
        ? patientMap.get(payment.patient_id.toString()) || {}
        : {};
      const doctorName = payment.doctor_id
        ? doctorMap.get(payment.doctor_id.toString()) || "Unknown"
        : "Unknown";
      const therapyPlan = payment.therapyPlanFirst || {};

      const addonServices = payment.addon_services || [];
      const addonTotal = addonServices.reduce(
        (sum, addon) => sum + (parseFloat(addon.amount) || 0),
        0,
      );
      const paymentAmount = parseFloat(payment.amount) || 0;
      const baseAmount = paymentAmount - addonTotal;

      doc.text(
        new Date(payment.date).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
        }),
        30,
        yPosition,
        { width: colWidths.date },
      );
      doc.text(patientInfo.name || "Walk-in", 85, yPosition, {
        width: colWidths.patient,
        ellipsis: true,
      });
      doc.text(doctorName, 170, yPosition, {
        width: colWidths.doctor,
        ellipsis: true,
      });
      doc.text(therapyPlan.therapy_name || "N/A", 250, yPosition, {
        width: colWidths.therapy,
        ellipsis: true,
      });
      doc.text(payment.type || "N/A", 335, yPosition, {
        width: colWidths.type,
        ellipsis: true,
      });
      doc.text(payment.location_name || "N/A", 380, yPosition, {
        width: colWidths.location,
        ellipsis: true,
      });

      // REPLACED SYMBOL HERE
      doc.text(`Rs. ${baseAmount.toFixed(2)}`, 455, yPosition, {
        width: colWidths.base,
        align: "right",
      });
      // REPLACED SYMBOL HERE
      doc.text(
        addonTotal > 0 ? `Rs. ${addonTotal.toFixed(2)}` : "-",
        505,
        yPosition,
        {
          width: colWidths.addon,
          align: "right",
        },
      );
      // REPLACED SYMBOL HERE
      doc.text(`Rs. ${paymentAmount.toFixed(2)}`, 545, yPosition, {
        width: colWidths.total,
        align: "right",
      });

      yPosition += 20;
    }

    // Add footer with total
    doc.moveDown(2);
    doc.moveTo(30, doc.y).lineTo(595, doc.y).stroke("#007B8E");
    doc.moveDown(0.5);
    // REPLACED SYMBOL HERE
    doc
      .fontSize(10)
      .fillColor("#007B8E")
      .text(`Grand Total: Rs. ${totalAmount.toFixed(2)}`, { align: "right" });

    // Finalize PDF
    doc.end();
  } catch (error) {
    console.error("Error exporting to PDF:", error);
    return res.status(500).json({
      message: "Error generating PDF file",
      error: error.message,
    });
  }
};

module.exports = {
  getAppointmentChartData,
  getAppointmentDashboardData,
  getDailyReportDashboard,
  getMonthlyLeaderboard,
  getMonthlyReferralDashboard,
  getMonthlyReferralDetailsCount,
  countPractoReferralsByYear,
  getSocialMediaPivot,
  getDoctorTherapyTypesSummary,
  getDoctorTherapyTypesInfo,
  getActivePlansWithPaymentsAndSessions,
  getActivePlansCompactView,
  getPatientTherapyAnalysis,
  getPaymentCollectionAnalysis,
  getAllPlansWithRemainingPayments,
  exportPaymentCollectionToExcel,
  exportPaymentCollectionToPDF,
  getTherapyClosureReport,
  exportTherapyClosureReportToPDF,
  exportTherapyClosureReportToExcel,
  getDoctorAssessmentsInfo,
};
