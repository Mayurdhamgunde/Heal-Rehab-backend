const mongoose = require("mongoose");
const moment = require("moment-timezone");
const { getTherapySession } = require("../db/therepy");
const { getPatientModel } = require("../db/patientSchema");
const { getPatientAssessmentModel } = require("../db/patientAssessmentSchema");

const TZ = "Asia/Kolkata";
const DATE_FMT = "YYYY-MM-DD";
const COMPLETED = ["completed", "Completed"];
const IN_PROGRESS = ["in_progress", "pending_counselor", "pending_medical"];

/**
 * GET /my/performance?month=YYYY-MM
 *
 * Everything is scoped to the logged-in doctor/counsellor (req.user.doctor_id).
 * Defaults to the current calendar month in IST.
 *
 * A session belongs to the user if:
 *   - doctor_id matches (all session types; for Aftercare this is the physician), OR
 *   - aftercare_team.physician_id / counsellor_id matches (so counsellors get
 *     credit for Aftercare sessions even though doctor_id mirrors the physician).
 */
const getMyPerformanceReport = async (req, res) => {
  try {
    const { user, orgDb } = req;

    if (!user?.doctor_id || !mongoose.Types.ObjectId.isValid(user.doctor_id)) {
      return res.status(400).json({ error: "Invalid user context" });
    }
    const doctorOid = new mongoose.Types.ObjectId(user.doctor_id);

    // ── Month range (therepy_date is a YYYY-MM-DD string, so compare as strings) ──
    const { month } = req.query;
    const base =
      month && moment(month, "YYYY-MM", true).isValid()
        ? moment.tz(month, "YYYY-MM", TZ)
        : moment().tz(TZ);

    const from = base.clone().startOf("month").format(DATE_FMT);
    const to = base.clone().endOf("month").format(DATE_FMT);
    const spanDays = base.daysInMonth();

    const prevMonth = base.clone().subtract(1, "month");
    const prevFrom = prevMonth.clone().startOf("month").format(DATE_FMT);
    const prevTo = prevMonth.clone().endOf("month").format(DATE_FMT);

    const TherapySession = getTherapySession(orgDb);
    const Patient = getPatientModel(orgDb);
    const PatientAssessment = getPatientAssessmentModel(orgDb);

    const ownerMatch = {
      $or: [
        { doctor_id: doctorOid },
        { "aftercare_team.physician_id": doctorOid },
        { "aftercare_team.counsellor_id": doctorOid },
      ],
    };

    // ── 1. Session breakdowns for the selected range (single pass via $facet) ──
    const [facets] = await TherapySession.aggregate([
      {
        $match: {
          ...ownerMatch,
          therepy_date: { $gte: from, $lte: to },
        },
      },
      {
        $facet: {
          byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          completedByType: [
            { $match: { status: { $in: COMPLETED } } },
            { $group: { _id: "$therepy_type", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ],
          completedByDay: [
            { $match: { status: { $in: COMPLETED } } },
            { $group: { _id: "$therepy_date", count: { $sum: 1 } } },
          ],
          uniquePatients: [
            { $match: { status: { $in: COMPLETED } } },
            { $group: { _id: "$patient_id" } },
            { $count: "count" },
          ],
          avgDuration: [
            {
              $match: {
                status: { $in: COMPLETED },
                session_duration: { $gt: 0 },
              },
            },
            { $group: { _id: null, avg: { $avg: "$session_duration" } } },
          ],
        },
      },
    ]);

    // ── 2. Status summary ──
    const statusCount = (names) =>
      facets.byStatus
        .filter((s) => names.includes(s._id))
        .reduce((sum, s) => sum + s.count, 0);

    const summary = {
      completed: statusCount(COMPLETED),
      upcoming: statusCount(["Scheduled"]),
      in_progress: statusCount(IN_PROGRESS),
      cancelled: statusCount(["Cancelled"]),
      no_show: statusCount(["No Show"]),
      unique_patients_seen: facets.uniquePatients[0]?.count || 0,
      avg_duration_minutes: facets.avgDuration[0]
        ? Math.round(facets.avgDuration[0].avg)
        : null,
    };

    // ── 3. Previous period (for the "vs last month" delta) ──
    const prevCompleted = await TherapySession.countDocuments({
      ...ownerMatch,
      status: { $in: COMPLETED },
      therepy_date: { $gte: prevFrom, $lte: prevTo },
    });

    // ── 4. Daily series with zero-filled days ──
    const dayMap = new Map(facets.completedByDay.map((d) => [d._id, d.count]));
    const daily = [];
    for (let i = 0; i < spanDays; i++) {
      const d = moment(from).add(i, "days");
      const key = d.format(DATE_FMT);
      daily.push({
        date: key,
        label: d.format("D"),
        count: dayMap.get(key) || 0,
      });
    }

    // ── 5. New patients treated: patients whose FIRST completed session with
    //       this user falls inside the range ──
    const firstSessions = await TherapySession.aggregate([
      { $match: { ...ownerMatch, status: { $in: COMPLETED } } },
      {
        $group: {
          _id: "$patient_id",
          first_date: { $min: "$therepy_date" },
          first_type: { $first: "$therepy_type" },
          patient_name: { $first: "$patient_name" },
        },
      },
      { $match: { first_date: { $gte: from, $lte: to } } },
      { $sort: { first_date: -1 } },
    ]);

    const idPattern = /^[a-f\d]{24}$/i;
    const newPatientIds = firstSessions
      .map((p) => p._id)
      .filter((id) => idPattern.test(id))
      .slice(0, 50)
      .map((id) => new mongoose.Types.ObjectId(id));

    // Pull registration info so the UI can flag "registered this month" vs "returning/transferred"
    const patientDocs = newPatientIds.length
      ? await Patient.find({ _id: { $in: newPatientIds } })
          .select(
            "patient_first_name patient_last_name patient_registration_date patient_image",
          )
          .lean()
      : [];
    const patientMap = new Map(patientDocs.map((p) => [p._id.toString(), p]));

    // Date bounds as real Dates (assessments store date_taken as Date, IST month)
    const rangeStart = moment.tz(from, DATE_FMT, TZ).startOf("day").toDate();
    const rangeEnd = moment.tz(to, DATE_FMT, TZ).endOf("day").toDate();

    // Per-patient workload this month: sessions taken with this user + assessments done
    const listIds = firstSessions.slice(0, 50).map((p) => p._id);
    const listOids = listIds
      .filter((id) => idPattern.test(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const [sessionCounts, assessmentCounts] = await Promise.all([
      listIds.length
        ? TherapySession.aggregate([
            {
              $match: {
                ...ownerMatch,
                patient_id: { $in: listIds },
                status: { $in: COMPLETED },
                therepy_date: { $gte: from, $lte: to },
              },
            },
            { $group: { _id: "$patient_id", count: { $sum: 1 } } },
          ])
        : [],
      listOids.length
        ? PatientAssessment.aggregate([
            {
              $match: {
                doctor_id: doctorOid,
                patient_id: { $in: listOids },
                status: "Completed",
                date_taken: { $gte: rangeStart, $lte: rangeEnd },
              },
            },
            { $group: { _id: "$patient_id", count: { $sum: 1 } } },
          ])
        : [],
    ]);
    const sessionCountMap = new Map(
      sessionCounts.map((r) => [String(r._id), r.count]),
    );
    const assessmentCountMap = new Map(
      assessmentCounts.map((r) => [String(r._id), r.count]),
    );

    const newPatientsTreated = firstSessions.slice(0, 50).map((p) => {
      const doc = patientMap.get(p._id);
      const regDate = doc?.patient_registration_date
        ? moment(doc.patient_registration_date).tz(TZ).format(DATE_FMT)
        : null;
      return {
        patient_id: p._id,
        patient_name: doc
          ? `${doc.patient_first_name} ${doc.patient_last_name}`
          : p.patient_name,
        first_session_date: p.first_date,
        first_session_type: p.first_type,
        registered_in_range: regDate ? regDate >= from && regDate <= to : false,
        sessions_this_month: sessionCountMap.get(p._id) || 0,
        assessments_this_month: assessmentCountMap.get(p._id) || 0,
      };
    });

    // ── 5b. Assessments taken by this user in the range ──
    const [assessFacets] = await PatientAssessment.aggregate([
      {
        $match: {
          doctor_id: doctorOid,
          date_taken: { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      {
        $facet: {
          byTemplate: [
            { $match: { status: "Completed" } },
            {
              $group: {
                _id: "$template_id",
                name: { $last: "$assessment_name" },
                count: { $sum: 1 },
                patients: { $addToSet: "$patient_id" },
              },
            },
            {
              $project: {
                name: 1,
                count: 1,
                unique_patients: { $size: "$patients" },
              },
            },
            { $sort: { count: -1, name: 1 } },
          ],
          byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          uniquePatients: [
            { $match: { status: "Completed" } },
            { $group: { _id: "$patient_id" } },
            { $count: "count" },
          ],
        },
      },
    ]);

    const assessByTemplate = (assessFacets?.byTemplate || []).map((t) => ({
      template_id: String(t._id),
      name: t.name,
      count: t.count,
      unique_patients: t.unique_patients,
    }));
    const assessTotal = assessByTemplate.reduce((sum, t) => sum + t.count, 0);
    const assessDrafts =
      (assessFacets?.byStatus || []).find((s) => s._id === "Draft")?.count || 0;

    const assessments = {
      total: assessTotal,
      drafts: assessDrafts,
      unique_patients: assessFacets?.uniquePatients?.[0]?.count || 0,
      most_taken: assessByTemplate[0] || null,
      by_template: assessByTemplate,
    };

    // ── 6. Patients newly registered/assigned to this user in the range ──
    const newlyAssigned = await Patient.countDocuments({
      $or: [{ doctor_id: doctorOid }, { "care_team.doctor_id": doctorOid }],
      patient_registration_date: { $gte: rangeStart, $lte: rangeEnd },
    });

    // ── 7. Follow-up sessions ──
    // These are co-owned by a physician and a counsellor (aftercare_team) and finish in two
    // phases, so "completed" alone hides work the user already did. Break them down by role.
    const TEAM_TYPES = { "Follow-up": "followup" };
    const meStr = String(doctorOid);
    const teamDocs = await TherapySession.find({
      ...ownerMatch,
      therepy_type: { $in: Object.keys(TEAM_TYPES) },
      therepy_date: { $gte: from, $lte: to },
    })
      .select(
        "therepy_type therepy_date status patient_id patient_name doctor_id aftercare_team",
      )
      .sort({ therepy_date: -1 })
      .lean();

    const emptyTeamStats = () => ({
      completed: 0,
      completed_as_physician: 0,
      completed_as_counsellor: 0,
      my_part_done_waiting_on_partner: 0,
      awaiting_my_part: 0,
      scheduled: 0,
    });
    const teamStats = { followup: emptyTeamStats() };
    const awaitingMyPart = [];

    for (const t of teamDocs) {
      const bucket = teamStats[TEAM_TYPES[t.therepy_type]];
      const team = t.aftercare_team || {};

      // A user can hold BOTH roles on one session (same id as physician and counsellor),
      // so roles are independent flags, not an either/or.
      const isPhysician = String(team.physician_id) === meStr;
      const isCounsellor = String(team.counsellor_id) === meStr;

      if (COMPLETED.includes(t.status)) {
        bucket.completed++;
        if (isPhysician) bucket.completed_as_physician++;
        if (isCounsellor) bucket.completed_as_counsellor++;
      } else if (
        t.status === "pending_counselor" ||
        t.status === "pending_medical"
      ) {
        // pending_counselor = medical phase done, counsellor still to do (and vice-versa)
        const waitingFor =
          t.status === "pending_counselor" ? "counsellor" : "physician";
        const iAmWaitedFor =
          waitingFor === "counsellor" ? isCounsellor : isPhysician;
        const iHoldAnyRole = isPhysician || isCounsellor;
        if (!iHoldAnyRole) continue; // legacy session with no team info: can't attribute a phase

        if (iAmWaitedFor) {
          bucket.awaiting_my_part++;
          const partnerId =
            waitingFor === "counsellor"
              ? team.physician_id
              : team.counsellor_id;
          const partnerName =
            waitingFor === "counsellor"
              ? team.physician_name
              : team.counsellor_name;
          awaitingMyPart.push({
            session_id: String(t._id),
            patient_id: String(t.patient_id),
            patient_name: t.patient_name,
            type: t.therepy_type,
            date: t.therepy_date,
            my_role: waitingFor === "counsellor" ? "counsellor" : "physician",
            partner_name:
              String(partnerId) === meStr ? "You" : partnerName || null,
          });
        } else {
          bucket.my_part_done_waiting_on_partner++;
        }
      } else if (t.status === "Scheduled" || t.status === "in_progress") {
        bucket.scheduled++;
      }
    }

    return res.status(200).json({
      success: true,
      range: { from, to, days: spanDays, month: base.format("YYYY-MM") },
      summary: {
        ...summary,
        completed_prev_period: prevCompleted,
        completed_delta: summary.completed - prevCompleted,
        total_scheduled_in_range:
          summary.completed +
          summary.upcoming +
          summary.in_progress +
          summary.cancelled +
          summary.no_show,
      },
      sessions_by_type: facets.completedByType.map((t) => ({
        type: t._id,
        count: t.count,
      })),
      sessions_by_day: daily,
      team_sessions: {
        followup: teamStats.followup,
        awaiting_my_part: awaitingMyPart.slice(0, 10),
        awaiting_my_part_total: awaitingMyPart.length,
      },
      assessments,
      new_patients: {
        treated_count: firstSessions.length,
        registered_to_me_count: newlyAssigned,
        list: newPatientsTreated,
      },
    });
  } catch (error) {
    console.error("Error building performance report:", error);
    return res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
};

module.exports = { getMyPerformanceReport };
