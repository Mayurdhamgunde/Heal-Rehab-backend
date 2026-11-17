const { getTherapySession, getTherapyPlanModel } = require("../db/therepy");
// Function 1: Export all plans and their sessions to Excel
const exportAllPlansAndSessions = async (req, res) => {
  try {
    console.log("🚀 Starting complete plans and sessions export...");

    // Get all plans from the database
    const allPlans = await req.orgDb.collection("plans").find({}).toArray();

    console.log(`📊 Found ${allPlans.length} total plans in database`);

    if (!allPlans.length) {
      return res.status(200).json({
        message: "No plans found in database",
        total_plans: 0,
        total_sessions: 0,
      });
    }

    // Array to store all session data
    let allSessionsData = [];
    let allPlansData = [];
    let totalSessionsCount = 0;

    // Process each plan
    allPlans.forEach((plan, planIndex) => {
      const planId = plan._id.toString();
      const therapySessions = plan.therapy_sessions || [];

      // Store plan summary data
      allPlansData.push({
        plan_index: planIndex + 1,
        plan_id: planId,
        therapy_name: plan.therapy_name || "N/A",
        patient_therapy_category: plan.patient_therapy_category || "N/A",
        total_amount: plan.total_amount || 0,
        received_amount: plan.received_amount || 0,
        balance: plan.balance || 0,
        estimated_sessions: plan.estimated_sessions || 0,
        actual_sessions_count: therapySessions.length,
        status: plan.status || "unknown",
        therapy_start: plan.therapy_start || "N/A",
        therapy_end: plan.therapy_end || "N/A",
        payment_type: plan.payment_type || "N/A",
        created_at: plan.createdAt || plan.created_date || "N/A",
        updated_at: plan.updatedAt || plan.updated_date || "N/A",
      });

      // Process each session in the plan
      therapySessions.forEach((session, sessionIndex) => {
        totalSessionsCount++;

        allSessionsData.push({
          record_number: totalSessionsCount,
          plan_index: planIndex + 1,
          session_index: sessionIndex + 1,
          plan_id: planId,
          session_id: session._id
            ? session._id.toString()
            : `generated_${planId}_${sessionIndex}`,
          has_session_id: session._id ? "YES" : "NO",

          // Plan details
          therapy_name: plan.therapy_name || "N/A",
          patient_therapy_category: plan.patient_therapy_category || "N/A",
          plan_status: plan.status || "unknown",
          plan_total_amount: plan.total_amount || 0,
          plan_received_amount: plan.received_amount || 0,
          plan_balance: plan.balance || 0,
          plan_estimated_sessions: plan.estimated_sessions || 0,
          plan_actual_sessions: therapySessions.length,

          // Session details
          session_status: session.status || "unknown",
          session_date: session.date || session.scheduled_date || "N/A",
          session_time: session.time || session.scheduled_time || "N/A",
          session_duration: session.duration || plan.session_duration || "N/A",
          therapist_name:
            session.therapist_name || session.assigned_therapist || "N/A",
          session_type: session.type || session.session_type || "N/A",
          session_notes: session.notes || "N/A",
          session_rating: session.rating || session.patient_rating || "N/A",
          session_completed_date: session.completed_date || "N/A",
          session_cancelled_reason: session.cancelled_reason || "N/A",
          session_rescheduled_from: session.rescheduled_from || "N/A",
          session_payment_status: session.payment_status || "N/A",
          session_amount:
            session.amount ||
            session.session_fee ||
            plan.per_session_amount ||
            "N/A",

          // Timestamps
          session_created_at:
            session.createdAt || session.created_date || "N/A",
          session_updated_at:
            session.updatedAt || session.updated_date || "N/A",
          plan_created_at: plan.createdAt || plan.created_date || "N/A",
          plan_updated_at: plan.updatedAt || plan.updated_date || "N/A",
        });
      });
    });

    // Create Excel workbook with multiple sheets
    const workbook = XLSX.utils.book_new();

    // Sheet 1: All Sessions Data
    const sessionsWorksheet = XLSX.utils.json_to_sheet(allSessionsData);
    XLSX.utils.book_append_sheet(workbook, sessionsWorksheet, "All_Sessions");

    // Sheet 2: Plans Summary
    const plansWorksheet = XLSX.utils.json_to_sheet(allPlansData);
    XLSX.utils.book_append_sheet(workbook, plansWorksheet, "Plans_Summary");

    // Sheet 3: Statistics Summary
    const statsData = [
      { metric: "Total Plans", value: allPlans.length },
      { metric: "Total Sessions", value: totalSessionsCount },
      {
        metric: "Sessions with IDs",
        value: allSessionsData.filter((s) => s.has_session_id === "YES").length,
      },
      {
        metric: "Sessions without IDs",
        value: allSessionsData.filter((s) => s.has_session_id === "NO").length,
      },
      {
        metric: "Average Sessions per Plan",
        value: Math.round((totalSessionsCount / allPlans.length) * 100) / 100,
      },
    ];
    const statsWorksheet = XLSX.utils.json_to_sheet(statsData);
    XLSX.utils.book_append_sheet(workbook, statsWorksheet, "Statistics");

    // Create filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `complete_plans_sessions_export_${timestamp}.xlsx`;
    const filepath = path.join(__dirname, "..", "debug_files", filename);

    // Ensure debug directory exists
    const debugDir = path.dirname(filepath);
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }

    // Write file
    XLSX.writeFile(workbook, filepath);

    console.log(`✅ Complete export file created: ${filepath}`);
    console.log(`📊 Total plans exported: ${allPlans.length}`);
    console.log(`📋 Total sessions exported: ${totalSessionsCount}`);
    console.log(
      `🆔 Sessions with IDs: ${
        allSessionsData.filter((s) => s.has_session_id === "YES").length
      }`,
    );
    console.log(
      `❌ Sessions without IDs: ${
        allSessionsData.filter((s) => s.has_session_id === "NO").length
      }`,
    );

    return res.status(200).json({
      message: "Complete plans and sessions export successful",
      export_details: {
        filename: filename,
        filepath: filepath,
        total_plans: allPlans.length,
        total_sessions: totalSessionsCount,
        sessions_with_ids: allSessionsData.filter(
          (s) => s.has_session_id === "YES",
        ).length,
        sessions_without_ids: allSessionsData.filter(
          (s) => s.has_session_id === "NO",
        ).length,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Error in exportAllPlansAndSessions:", error);
    return res.status(500).json({
      message: "Error exporting plans and sessions",
      error: error.message,
    });
  }
};

// Function 2: Compare two Excel files and find missing records
const compareTherapiesFromDatabase = async (req, res) => {
  try {
    const {
      comparison_type = "sessions",
      plan_filter = {},
      session_filter = {},
      repair_orphaned_sessions = false,
    } = req.body;

    console.log(`🔍 Starting database comparison for ${comparison_type}`);

    // Get database models (assuming you have connection setup)
    const TherapyPlan = getTherapyPlanModel(req.orgDb); // Adjust based on your DB setup
    const TherapySession = getTherapySession(req.orgDb); // Adjust based on your DB setup

    let comparisonResults = {};
    let allTherapyIds = new Set();
    let missingTherapyIds = [];
    let foundTherapyIds = [];
    let orphanedSessions = [];
    let repairedSessions = [];

    if (comparison_type === "sessions") {
      console.log("📊 Fetching all therapy plans...");

      // Get all therapy plans
      const allPlans = await TherapyPlan.find(plan_filter)
        .select("_id therapy_name therapy_sessions")
        .lean();
      console.log(`📋 Found ${allPlans.length} therapy plans`);

      // Extract all therapy session IDs from plans
      const sessionIdsFromPlans = new Set();
      const planSessionMap = new Map(); // Map session ID to plan info

      allPlans.forEach((plan) => {
        if (plan.therapy_sessions && plan.therapy_sessions.length > 0) {
          plan.therapy_sessions.forEach((session) => {
            const sessionId = session._id.toString();
            sessionIdsFromPlans.add(sessionId);
            planSessionMap.set(sessionId, {
              plan_id: plan._id.toString(),
              therapy_name: plan.therapy_name,
              session_status: session.status,
              session_number: session.session_number,
            });
            allTherapyIds.add(sessionId);
          });
        }
      });

      console.log(
        `🔗 Found ${sessionIdsFromPlans.size} session references in plans`,
      );

      // Get all actual therapy sessions from therepys collection
      const allSessions = await TherapySession.find(session_filter)
        .select(
          "_id patient_name doctor_name plan_id therepy_date therepy_start_time therepy_end_time status",
        )
        .lean();

      console.log(
        `💾 Found ${allSessions.length} actual sessions in therepys collection`,
      );

      const actualSessionIds = new Set();
      const sessionDetailsMap = new Map();

      allSessions.forEach((session) => {
        const sessionId = session._id.toString();
        actualSessionIds.add(sessionId);
        sessionDetailsMap.set(sessionId, {
          session_id: sessionId,
          patient_name: session.patient_name,
          doctor_name: session.doctor_name,
          plan_id: session.plan_id ? session.plan_id.toString() : "NO_PLAN_ID",
          therapy_date: session.therepy_date,
          start_time: session.therepy_start_time,
          end_time: session.therepy_end_time,
          status: session.status,
        });
        allTherapyIds.add(sessionId);
      });

      // Find sessions referenced in plans but not existing in therepys collection
      missingTherapyIds = Array.from(sessionIdsFromPlans).filter(
        (id) => !actualSessionIds.has(id),
      );

      // Find sessions existing in therepys but not referenced in any plan
      orphanedSessions = Array.from(actualSessionIds).filter(
        (id) => !sessionIdsFromPlans.has(id),
      );

      // Find sessions that exist in both
      foundTherapyIds = Array.from(sessionIdsFromPlans).filter((id) =>
        actualSessionIds.has(id),
      );

      console.log(
        `❌ Missing sessions (in plans but not in therepys): ${missingTherapyIds.length}`,
      );
      console.log(
        `🔗 Orphaned sessions (in therepys but not in plans): ${orphanedSessions.length}`,
      );
      console.log(
        `✅ Valid sessions (exist in both): ${foundTherapyIds.length}`,
      );

      // Repair orphaned sessions if requested
      if (repair_orphaned_sessions && orphanedSessions.length > 0) {
        console.log(
          `🔧 Starting repair process for ${orphanedSessions.length} orphaned sessions...`,
        );

        for (const sessionId of orphanedSessions) {
          const sessionDetails = sessionDetailsMap.get(sessionId);

          if (
            sessionDetails.plan_id &&
            sessionDetails.plan_id !== "NO_PLAN_ID"
          ) {
            try {
              // Find the plan that this session belongs to
              const targetPlan = await TherapyPlan.findById(
                sessionDetails.plan_id,
              );

              if (targetPlan) {
                // Create session object to add to the plan
                const sessionToAdd = {
                  _id: sessionId,
                  session_number: targetPlan.therapy_sessions
                    ? targetPlan.therapy_sessions.length + 1
                    : 1,
                  status: sessionDetails.status || "scheduled",
                  therepy_date: sessionDetails.therapy_date,
                  therepy_start_time: sessionDetails.start_time,
                  therepy_end_time: sessionDetails.end_time,
                };

                // Add the session to the plan's therapy_sessions array
                await TherapyPlan.findByIdAndUpdate(sessionDetails.plan_id, {
                  $push: {
                    therapy_sessions: sessionToAdd,
                  },
                });

                repairedSessions.push({
                  session_id: sessionId,
                  plan_id: sessionDetails.plan_id,
                  patient_name: sessionDetails.patient_name,
                  therapy_date: sessionDetails.therapy_date,
                  repair_status: "SUCCESS",
                  repair_action: "Added session to existing plan",
                });

                console.log(
                  `✅ Repaired session ${sessionId} - added to plan ${sessionDetails.plan_id}`,
                );
              } else {
                repairedSessions.push({
                  session_id: sessionId,
                  plan_id: sessionDetails.plan_id,
                  patient_name: sessionDetails.patient_name,
                  therapy_date: sessionDetails.therapy_date,
                  repair_status: "FAILED",
                  repair_action: "Plan not found",
                  error: `Plan ${sessionDetails.plan_id} does not exist`,
                });
                console.log(
                  `❌ Failed to repair session ${sessionId} - plan ${sessionDetails.plan_id} not found`,
                );
              }
            } catch (error) {
              repairedSessions.push({
                session_id: sessionId,
                plan_id: sessionDetails.plan_id,
                patient_name: sessionDetails.patient_name,
                therapy_date: sessionDetails.therapy_date,
                repair_status: "ERROR",
                repair_action: "Database error during repair",
                error: error.message,
              });
              console.error(
                `❌ Error repairing session ${sessionId}:`,
                error.message,
              );
            }
          } else {
            repairedSessions.push({
              session_id: sessionId,
              plan_id: sessionDetails.plan_id,
              patient_name: sessionDetails.patient_name,
              therapy_date: sessionDetails.therapy_date,
              repair_status: "SKIPPED",
              repair_action: "No valid plan_id found",
              error: "Session has no plan_id or plan_id is NO_PLAN_ID",
            });
            console.log(`⚠️ Skipped session ${sessionId} - no valid plan_id`);
          }
        }

        const successfulRepairs = repairedSessions.filter(
          (r) => r.repair_status === "SUCCESS",
        ).length;
        console.log(
          `🎉 Repair completed: ${successfulRepairs}/${orphanedSessions.length} sessions successfully repaired`,
        );
      }

      // Prepare detailed results
      const missingSessionsDetails = missingTherapyIds.map((sessionId) => ({
        session_id: sessionId,
        ...planSessionMap.get(sessionId),
        status: "MISSING_FROM_THEREPYS",
        issue_type: "Referenced in plan but session does not exist",
      }));

      const orphanedSessionsDetails = orphanedSessions.map((sessionId) => ({
        ...sessionDetailsMap.get(sessionId),
        status: "ORPHANED_SESSION",
        issue_type: "Session exists but not referenced in any plan",
      }));

      const validSessionsDetails = foundTherapyIds
        .slice(0, 100)
        .map((sessionId) => ({
          // Limit to first 100 for preview
          ...sessionDetailsMap.get(sessionId),
          ...planSessionMap.get(sessionId),
          status: "VALID",
          issue_type: "Session properly linked",
        }));

      comparisonResults = {
        total_unique_therapy_ids: allTherapyIds.size,
        sessions_in_plans: sessionIdsFromPlans.size,
        sessions_in_therepys: actualSessionIds.size,
        missing_sessions: missingTherapyIds.length,
        orphaned_sessions: orphanedSessions.length,
        valid_sessions: foundTherapyIds.length,
        repair_attempted: repair_orphaned_sessions,
        repaired_sessions_count: repair_orphaned_sessions
          ? repairedSessions.filter((r) => r.repair_status === "SUCCESS").length
          : 0,
        missing_sessions_details: missingSessionsDetails,
        orphaned_sessions_details: orphanedSessionsDetails,
        valid_sessions_preview: validSessionsDetails,
        repair_details: repair_orphaned_sessions ? repairedSessions : [],
      };
    } else if (comparison_type === "plans") {
      console.log("📊 Analyzing therapy plans consistency...");

      // Get all plans with their session references
      const allPlans = await TherapyPlan.find(plan_filter).lean();
      console.log(`📋 Found ${allPlans.length} therapy plans`);

      const planAnalysis = [];

      for (const plan of allPlans) {
        const planId = plan._id.toString();
        allTherapyIds.add(planId);

        // Get session IDs referenced in this plan
        const referencedSessionIds = plan.therapy_sessions
          ? plan.therapy_sessions.map((s) => s._id.toString())
          : [];

        // Check if these sessions actually exist
        const existingSessions = await TherapySession.find({
          _id: { $in: referencedSessionIds },
        })
          .select("_id status")
          .lean();

        const existingSessionIds = existingSessions.map((s) =>
          s._id.toString(),
        );
        const missingSessions = referencedSessionIds.filter(
          (id) => !existingSessionIds.includes(id),
        );

        // Find sessions that belong to this plan but aren't referenced
        const unlinkedSessions = await TherapySession.find({
          plan_id: plan._id,
          _id: { $nin: referencedSessionIds },
        })
          .select("_id status therepy_date")
          .lean();

        planAnalysis.push({
          plan_id: planId,
          therapy_name: plan.therapy_name,
          estimated_sessions: plan.estimated_sessions || 0,
          completed_sessions: plan.completed_sessions || 0,
          referenced_sessions_count: referencedSessionIds.length,
          existing_sessions_count: existingSessionIds.length,
          missing_sessions_count: missingSessions.length,
          unlinked_sessions_count: unlinkedSessions.length,
          status: plan.status,
          total_amount: plan.total_amount,
          balance: plan.balance,
          missing_session_ids: missingSessions,
          unlinked_session_ids: unlinkedSessions.map((s) => s._id.toString()),
          consistency_status:
            missingSessions.length === 0 && unlinkedSessions.length === 0
              ? "CONSISTENT"
              : "INCONSISTENT",
        });
      }

      const inconsistentPlans = planAnalysis.filter(
        (p) => p.consistency_status === "INCONSISTENT",
      );
      const consistentPlans = planAnalysis.filter(
        (p) => p.consistency_status === "CONSISTENT",
      );

      comparisonResults = {
        total_plans: allPlans.length,
        consistent_plans: consistentPlans.length,
        inconsistent_plans: inconsistentPlans.length,
        total_missing_sessions: inconsistentPlans.reduce(
          (sum, p) => sum + p.missing_sessions_count,
          0,
        ),
        total_unlinked_sessions: inconsistentPlans.reduce(
          (sum, p) => sum + p.unlinked_sessions_count,
          0,
        ),
        plan_analysis: planAnalysis,
        inconsistent_plans_details: inconsistentPlans,
      };
    }

    // Log all therapy IDs for verification
    console.log(
      `🆔 All Therapy IDs found: ${Array.from(allTherapyIds).join(", ")}`,
    );

    return res.status(200).json({
      message: "Database comparison completed successfully",
      comparison_type,
      results: comparisonResults,
      all_therapy_ids: Array.from(allTherapyIds),
      generated_at: new Date().toISOString(),
      summary: {
        total_unique_therapy_ids: allTherapyIds.size,
        issues_found:
          comparison_type === "sessions"
            ? comparisonResults.missing_sessions +
              comparisonResults.orphaned_sessions
            : comparisonResults.inconsistent_plans,
        repairs_made:
          comparison_type === "sessions" && repair_orphaned_sessions
            ? comparisonResults.repaired_sessions_count
            : 0,
      },
    });
  } catch (error) {
    console.error("❌ Error in compareTherapiesFromDatabase:", error);
    return res.status(500).json({
      message: "Error comparing therapies from database",
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};
const mongoose = require("mongoose");

/**
 * Migration function to realign location data in payments and therapy plans
 * Maps old location IDs to current organization location IDs
 */
const realignLocationData = async (req, res) => {
  try {
    const Organization = require("../db/OrganizationSchema"); // Adjust path as needed
    console.log("TenantId: ", req.user.tenant_id);
    const { getPaymentModel } = require("../db/paymentSchema");
    const { getTherapyPlanModel } = require("../db/therepy");

    // Get the organization data
    const organization = await Organization.findOne({
      tenant_id: req.user.tenant_id, // or however you identify the org
    });

    if (!organization) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    // Build current location mapping (ID -> Name)
    const currentLocations = new Map();
    organization.organization_locations.forEach((loc) => {
      currentLocations.set(loc._id.toString(), {
        id: loc._id.toString(),
        name: loc.name,
        locationId: loc.locationId,
      });
    });

    // Build name-based mapping to find the correct current location ID
    const locationNameMapping = new Map();
    organization.organization_locations.forEach((loc) => {
      const normalizedName = loc.name.toLowerCase().trim();
      locationNameMapping.set(normalizedName, loc._id.toString());
    });

    console.log("Current locations:", Array.from(currentLocations.entries()));
    console.log("Name mapping:", Array.from(locationNameMapping.entries()));

    // Get database connection
    const Payment = getPaymentModel(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);

    // Step 1: Find all unique location IDs and names in payments
    const paymentLocations = await Payment.aggregate([
      {
        $group: {
          _id: {
            location_id: "$location_id",
            location_name: "$location_name",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Step 2: Find all unique location IDs and names in therapy plans
    const planLocations = await req.orgDb
      .collection("plans")
      .aggregate([
        {
          $group: {
            _id: {
              location_id: "$location_id",
              location_name: "$location_name",
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ])
      .toArray();

    console.log("\nPayment locations found:", paymentLocations);
    console.log("\nPlan locations found:", planLocations);

    // Step 3: Build migration mapping based on name matching
    const migrationMap = new Map();
    const orphanedLocations = [];

    // Process payment locations
    for (const item of paymentLocations) {
      const oldId = item._id?.location_id;
      const oldName = item._id?.location_name;

      if (!oldId) continue;

      const oldIdStr = oldId.toString();
      const normalizedName = oldName ? oldName.toLowerCase().trim() : "";

      // Check if it's already a current location
      if (currentLocations.has(oldIdStr)) {
        migrationMap.set(oldIdStr, oldIdStr); // No change needed
        continue;
      }

      // Try to match by name
      let matchFound = false;
      for (const [currentName, currentId] of locationNameMapping.entries()) {
        if (
          normalizedName.includes(currentName) ||
          currentName.includes(normalizedName)
        ) {
          migrationMap.set(oldIdStr, currentId);
          matchFound = true;
          console.log(
            `Mapped: ${oldName} (${oldIdStr}) -> ${currentName} (${currentId})`,
          );
          break;
        }
      }

      if (!matchFound) {
        orphanedLocations.push({
          old_id: oldIdStr,
          old_name: oldName,
          count: item.count,
        });
      }
    }

    // Process plan locations similarly
    for (const item of planLocations) {
      const oldId = item._id?.location_id;
      const oldName = item._id?.location_name;

      if (!oldId) continue;

      const oldIdStr = oldId.toString();
      const normalizedName = oldName ? oldName.toLowerCase().trim() : "";

      if (currentLocations.has(oldIdStr) || migrationMap.has(oldIdStr)) {
        continue;
      }

      let matchFound = false;
      for (const [currentName, currentId] of locationNameMapping.entries()) {
        if (
          normalizedName.includes(currentName) ||
          currentName.includes(normalizedName)
        ) {
          migrationMap.set(oldIdStr, currentId);
          matchFound = true;
          console.log(
            `Mapped: ${oldName} (${oldIdStr}) -> ${currentName} (${currentId})`,
          );
          break;
        }
      }

      if (
        !matchFound &&
        !orphanedLocations.find((o) => o.old_id === oldIdStr)
      ) {
        orphanedLocations.push({
          old_id: oldIdStr,
          old_name: oldName,
          count: item.count,
        });
      }
    }

    console.log("\nMigration Map:", Array.from(migrationMap.entries()));
    console.log("\nOrphaned Locations:", orphanedLocations);

    // Step 4: Perform dry run or actual migration
    const dryRun = req.query.dry_run === "true";

    let paymentsUpdated = 0;
    let plansUpdated = 0;

    if (!dryRun) {
      // Update payments
      for (const [oldId, newId] of migrationMap.entries()) {
        if (oldId === newId) continue; // Skip if no change

        const newLocation = currentLocations.get(newId);

        const result = await Payment.updateMany(
          { location_id: oldId },
          {
            $set: {
              location_id: newId,
              location_name: newLocation.name,
            },
          },
        );

        paymentsUpdated += result.modifiedCount;
        console.log(
          `Updated ${result.modifiedCount} payments: ${oldId} -> ${newId}`,
        );
      }

      // Update therapy plans
      for (const [oldId, newId] of migrationMap.entries()) {
        if (oldId === newId) continue;

        const newLocation = currentLocations.get(newId);

        const result = await req.orgDb.collection("plans").updateMany(
          { location_id: oldId },
          {
            $set: {
              location_id: newId,
              location_name: newLocation.name,
            },
          },
        );

        plansUpdated += result.modifiedCount;
        console.log(
          `Updated ${result.modifiedCount} plans: ${oldId} -> ${newId}`,
        );
      }
    }

    return res.status(200).json({
      success: true,
      message: dryRun
        ? "Dry run completed - no changes made"
        : "Migration completed successfully",
      migration_summary: {
        dry_run: dryRun,
        current_locations: organization.organization_locations.length,
        old_location_ids_found: migrationMap.size,
        payments_updated: paymentsUpdated,
        plans_updated: plansUpdated,
        orphaned_locations: orphanedLocations.length,
      },
      migration_map: Array.from(migrationMap.entries()).map(
        ([oldId, newId]) => ({
          from_id: oldId,
          to_id: newId,
          to_name: currentLocations.get(newId)?.name || "Unknown",
        }),
      ),
      next_steps:
        orphanedLocations.length > 0
          ? "Review orphaned locations and manually map them if needed"
          : "All locations successfully mapped",
    });
  } catch (error) {
    console.error("Error in realignLocationData:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

/**
 * Manual mapping function for orphaned locations
 * Use this when automatic name matching fails
 */
const manualLocationMapping = async (req, res) => {
  try {
    const { manual_mappings } = req.body;
    // manual_mappings format: [{ old_id: "xxx", new_id: "yyy" }, ...]

    if (!manual_mappings || !Array.isArray(manual_mappings)) {
      return res.status(400).json({
        success: false,
        message: "manual_mappings array is required",
      });
    }

    const Payment = getPaymentModel(req.orgDb);
    const Organization = require("./models/Organization");

    const organization = await Organization.findOne({
      tenant_id: req.tenantId,
    });

    let paymentsUpdated = 0;
    let plansUpdated = 0;

    for (const mapping of manual_mappings) {
      const { old_id, new_id } = mapping;

      // Validate new_id exists in organization
      const newLocation = organization.organization_locations.find(
        (loc) => loc._id.toString() === new_id,
      );

      if (!newLocation) {
        console.warn(`Invalid new_id: ${new_id}, skipping...`);
        continue;
      }

      // Update payments
      const paymentResult = await Payment.updateMany(
        { location_id: old_id },
        {
          $set: {
            location_id: new_id,
            location_name: newLocation.name,
          },
        },
      );
      paymentsUpdated += paymentResult.modifiedCount;

      // Update plans
      const planResult = await req.orgDb.collection("plans").updateMany(
        { location_id: old_id },
        {
          $set: {
            location_id: new_id,
            location_name: newLocation.name,
          },
        },
      );
      plansUpdated += planResult.modifiedCount;

      console.log(
        `Manual mapping: ${old_id} -> ${new_id} (${newLocation.name})`,
      );
      console.log(`  - Payments: ${paymentResult.modifiedCount}`);
      console.log(`  - Plans: ${planResult.modifiedCount}`);
    }

    return res.status(200).json({
      success: true,
      message: "Manual mappings applied successfully",
      payments_updated: paymentsUpdated,
      plans_updated: plansUpdated,
    });
  } catch (error) {
    console.error("Error in manualLocationMapping:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

const { getPatientModel } = require("../db/patientSchema");

const bulkSyncFollowUpDates = async (req, res) => {
  try {
    const { orgDb } = req;

    const Patient = getPatientModel(orgDb);
    const TherapyPlan = getTherapyPlanModel(orgDb);

    // 1. Find patients with plans AND who DO NOT currently have a follow_Up_Date
    const patients = await Patient.find({
      therapy_plans: { $exists: true, $not: { $size: 0 } },
      $or: [{ follow_Up_Date: { $exists: false } }, { follow_Up_Date: null }],
    }).select("_id therapy_plans");

    let updatedCount = 0;

    // 2. Iterate through filtered patients
    for (const patient of patients) {
      // Find the most recent plan with a next_visit_date[cite: 1, 2]
      const plans = await TherapyPlan.find({
        _id: { $in: patient.therapy_plans },
        next_visit_date: { $exists: true, $ne: null },
      })
        .sort({ next_visit_date: -1 })
        .limit(1) // Optimization: Only grab the latest one
        .lean();

      if (plans.length > 0) {
        // Update the Patient document
        await Patient.findByIdAndUpdate(patient._id, {
          $set: { follow_Up_Date: plans[0].next_visit_date },
        });
        updatedCount++;
      }
    }

    return res.status(200).json({
      success: true,
      message: `Migration complete. Skipped patients who already had a follow-up date. Updated ${updatedCount} patients.`,
      patients_without_dates_evaluated: patients.length,
    });
  } catch (error) {
    console.error("Error during bulk migration of follow_Up_Date:", error);
    return res.status(500).json({
      error: "Internal server error during migration",
      details: error.message,
    });
  }
};

module.exports = {
  realignLocationData,
  manualLocationMapping,
  exportAllPlansAndSessions,
  compareTherapiesFromDatabase,
  bulkSyncFollowUpDates,
};
