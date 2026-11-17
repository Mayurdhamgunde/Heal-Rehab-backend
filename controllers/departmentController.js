const mongoose = require("mongoose");
const { getDepartmentModel } = require("../db/departmentSchema");
const { getDoctorModel } = require("../db/doctorschema");
const { getPatientModel } = require("../db/patientSchema");
const { generatepatientImageSasToken } = require("../utils/azureutils");
// Returns a privileges object. Admin departments always receive full access;
// non-admin departments use whatever flags were sent in the request body.
const resolvePrivileges = (is_admin, requestedPrivileges = {}) => {
  if (is_admin) {
    return {
      can_register_patients: true,
      can_update_patients: true,
      can_create_treatment_plans: true,
      can_access_all_assessments: true,
      can_give_prescription: true,
      can_create_sessions: true,
      can_delete_patients: true, // Admins get full access
    };
  }
  return {
    can_register_patients: requestedPrivileges.can_register_patients ?? false,
    can_update_patients: requestedPrivileges.can_update_patients ?? false,
    can_create_treatment_plans:
      requestedPrivileges.can_create_treatment_plans ?? false,
    can_access_all_assessments:
      requestedPrivileges.can_access_all_assessments ?? false,
    can_give_prescription: requestedPrivileges.can_give_prescription ?? false,
    can_create_sessions: requestedPrivileges.can_create_sessions ?? false,
    can_delete_patients: requestedPrivileges.can_delete_patients ?? false, // Read from request for non-admins
  };
};

// Middleware factory — use on any route that requires a specific privilege.
// Usage: router.post("/patients", checkDepartmentPrivilege("can_register_patients"), createPatient)
const checkDepartmentPrivilege = (privilegeKey) => {
  return async (req, res, next) => {
    try {
      // Expect the authenticated doctor to carry department_id on req.user
      const departmentId = req.user?.department_id;

      if (!departmentId) {
        return res.status(403).json({
          msg: "Access denied. You are not assigned to any department.",
        });
      }

      const Department = getDepartmentModel(req.orgDb);
      const department = await Department.findById(departmentId)
        .select("is_admin_department privileges")
        .lean();

      if (!department) {
        return res.status(403).json({
          msg: "Access denied. Your department could not be found.",
        });
      }

      // Admin departments pass every privilege check automatically
      if (department.is_admin_department) {
        return next();
      }

      if (!department.privileges?.[privilegeKey]) {
        return res.status(403).json({
          msg: `Access denied. Your department does not have access to this feature.`,
          required_privilege: privilegeKey,
        });
      }

      next();
    } catch (error) {
      console.error("Privilege check error:", error);
      return res.status(500).json({ msg: "Internal server error" });
    }
  };
};

const createDepartment = async (req, res) => {
  try {
    const {
      department_name,
      department_code,
      description,
      status,
      assigned_locations,
      is_admin_department,
      privileges,
    } = req.body;

    // Validate required fields
    if (!department_name) {
      return res.status(400).json({
        msg: "The department_name field is required",
      });
    }

    // Get the Department model for this specific tenant's database
    const Department = getDepartmentModel(req.orgDb);

    // Check for existing department to prevent duplicates
    const existingDepartment = await Department.findOne({
      department_name: department_name.trim(),
    });

    if (existingDepartment) {
      return res.status(400).json({
        msg: "A department with this name already exists",
      });
    }

    const isAdmin = is_admin_department || false;

    // Create new department
    const newDepartment = new Department({
      department_name,
      department_code,
      description,
      status: status || "Active",
      assigned_locations: assigned_locations || [],
      is_admin_department: isAdmin,
      privileges: resolvePrivileges(isAdmin, privileges),
    });

    const savedDepartment = await newDepartment.save();

    res.status(201).json({
      message: "Department created successfully",
      department: savedDepartment,
    });
  } catch (error) {
    console.error("Error creating department:", error);
    res.status(500).json({
      message: "Error creating department",
      error: error.message,
    });
  }
};

const getAllDepartments = async (req, res) => {
  try {
    const Department = getDepartmentModel(req.orgDb);

    // Fetch all departments using lean() for better performance
    const departments = await Department.find({}).lean();

    return res.status(200).json({ departments });
  } catch (error) {
    console.error("Error retrieving departments:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const getDepartment = async (req, res) => {
  try {
    const { departmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(departmentId)) {
      return res.status(400).json({ error: "Invalid department ID format" });
    }

    const Department = getDepartmentModel(req.orgDb);
    const Doctor = getDoctorModel(req.orgDb);

    // Find the department
    const department = await Department.findById(departmentId).lean();

    if (!department) {
      return res.status(404).json({ error: "Department not found" });
    }

    // Fetch all doctors that have this department_id (Replaces the need for a members array)
    const members = await Doctor.find({ department_id: departmentId })
      .select(
        "doctor_first_name doctor_last_name doctor_email doctor_phone doctors_photo specialization roles",
      )
      .lean();

    // Attach members to the response object
    department.memberCount = members.length;
    department.members = members;

    return res.status(200).json(department);
  } catch (error) {
    console.error("Error fetching department:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const assignCareTeam = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { care_team } = req.body;

    // 1. Fast payload validation
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ msg: "Invalid Patient ID format" });
    }

    if (!Array.isArray(care_team) || care_team.length === 0) {
      return res
        .status(400)
        .json({ msg: "care_team must be a non-empty array" });
    }

    // 2. Fetch logged-in doctor projection only
    const doctor = await req.orgDb
      .collection("doctors")
      .findOne(
        { doctor_email: req.user.email },
        { projection: { doctor_first_name: 1, doctor_last_name: 1 } },
      );

    if (!doctor) {
      return res
        .status(404)
        .json({ msg: "Doctor not found in this organization" });
    }

    // 3. Prepare notes synchronously
    const counselorNames = [];
    const specialistNames = [];

    for (let i = 0; i < care_team.length; i++) {
      const member = care_team[i];
      if (member.role === "Head Counselor") {
        counselorNames.push(member.doctor_name);
      } else if (member.role === "Specialist") {
        specialistNames.push(member.doctor_name);
      }
    }

    const notesParts = [];
    if (counselorNames.length)
      notesParts.push(`Head Counselor: ${counselorNames.join(", ")}`);
    if (specialistNames.length)
      notesParts.push(`Specialist(s): ${specialistNames.join(", ")}`);

    const journeyEntry = {
      stage: "Assigned Care Team",
      performed_by_id: doctor._id,
      performed_by_name: `${doctor.doctor_first_name} ${doctor.doctor_last_name}`,
      performed_at: new Date(),
      notes: notesParts.length ? notesParts.join(" | ") : "Care team assigned",
      status: "Completed",
    };

    const Patient = getPatientModel(req.orgDb);
    const patientObjectId = new mongoose.Types.ObjectId(patientId);

    // 4. Single-roundtrip atomic update with conditional $push
    // Try updating and pushing the journey stage ONLY if it doesn't already exist
    let updatedPatient = await Patient.findOneAndUpdate(
      {
        _id: patientObjectId,
        "patient_journey.stage": { $ne: "Assigned Care Team" },
      },
      {
        $set: { care_team },
        $push: { patient_journey: journeyEntry },
      },
      { new: true },
    );

    let journeyLogged = true;

    // If no document matched, patient either doesn't exist OR already has the journey stage
    if (!updatedPatient) {
      updatedPatient = await Patient.findOneAndUpdate(
        { _id: patientObjectId },
        { $set: { care_team } },
        { new: true },
      );

      if (!updatedPatient) {
        return res.status(404).json({ msg: "Patient not found" });
      }

      journeyLogged = false;
    }

    // 5. Generate SAS token if patient image exists
    if (updatedPatient.patient_image) {
      try {
        updatedPatient.patient_image = await generatepatientImageSasToken(
          updatedPatient.patient_image,
        );
      } catch {
        updatedPatient.patient_image = null;
      }
    }

    return res.status(200).json({
      msg: "Care team assigned successfully",
      patient: updatedPatient,
      journey_logged: journeyLogged ? ["Assigned Care Team"] : [],
    });
  } catch (error) {
    console.error("Error assigning care team:", error);
    return res.status(500).json({
      msg: "Internal server error",
      error: error.message,
    });
  }
};

const updateDepartment = async (req, res) => {
  try {
    const { departmentId } = req.params;
    const {
      department_name,
      department_code,
      description,
      status,
      head_of_department,
      assigned_locations,
      is_admin_department,
      privileges,
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(departmentId)) {
      return res.status(400).json({ error: "Invalid department ID format" });
    }

    const Department = getDepartmentModel(req.orgDb);
    const Doctor = getDoctorModel(req.orgDb); // 👈 add this — needed to sync doctors

    // Check if department exists
    const department = await Department.findById(departmentId);
    if (!department) {
      return res.status(404).json({ msg: "Department not found" });
    }

    // Ensure we aren't changing the name to one that already exists
    if (department_name && department_name !== department.department_name) {
      const existing = await Department.findOne({
        department_name: department_name.trim(),
      });
      if (existing) {
        return res
          .status(400)
          .json({ msg: "Another department with this name already exists" });
      }
    }

    // Build update object
    const updateFields = {};
    if (department_name != null) updateFields.department_name = department_name;
    if (department_code != null) updateFields.department_code = department_code;
    if (description != null) updateFields.description = description;
    if (status != null) updateFields.status = status;
    if (is_admin_department != null) {
      updateFields.is_admin_department = is_admin_department;

      // When toggling admin status, always recalculate privileges so they
      // stay in sync — admin departments get all, non-admin respect the flags.
      updateFields.privileges = resolvePrivileges(
        is_admin_department,
        privileges ?? department.privileges,
      );

      // Sync is_admin on all doctors in this department
      await Doctor.updateMany(
        { department_id: departmentId },
        { $set: { is_admin: is_admin_department } },
      );
    } else if (privileges != null) {
      // is_admin_department not changing — update only the privilege flags,
      // but still enforce the admin override if the department is already admin.
      updateFields.privileges = resolvePrivileges(
        department.is_admin_department,
        privileges,
      );
    }
    if (head_of_department != null) {
      if (!mongoose.Types.ObjectId.isValid(head_of_department)) {
        return res.status(400).json({ error: "Invalid head_of_department ID" });
      }
      updateFields.head_of_department = head_of_department;
    }

    // Handle location updates
    if (assigned_locations != null) {
      if (!Array.isArray(assigned_locations)) {
        return res
          .status(400)
          .json({ error: "assigned_locations must be an array" });
      }
      updateFields.assigned_locations = assigned_locations;
    }

    if (Object.keys(updateFields).length === 0) {
      return res
        .status(400)
        .json({ msg: "No valid fields provided for update" });
    }

    const updatedDepartment = await Department.findByIdAndUpdate(
      departmentId,
      { $set: updateFields },
      { new: true }, // Return the updated document
    );

    return res.status(200).json({
      msg: "Department updated successfully",
      department: updatedDepartment,
    });
  } catch (error) {
    console.error("Error updating department:", error);
    return res.status(500).json({ msg: "Internal server error" });
  }
};

const deleteDepartment = async (req, res) => {
  try {
    const { departmentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(departmentId)) {
      return res.status(400).json({ error: "Invalid department ID format" });
    }

    const Department = getDepartmentModel(req.orgDb);
    const Doctor = getDoctorModel(req.orgDb);

    // Check if any doctors are currently assigned to this department
    // To prevent deleting a department that is currently in use
    const doctorsInDepartment = await Doctor.findOne({
      department_id: departmentId,
    });
    if (doctorsInDepartment) {
      return res.status(400).json({
        error:
          "Cannot delete department. There are still doctors assigned to it. Please reassign them first.",
      });
    }

    const deletedDepartment = await Department.findByIdAndDelete(departmentId);

    if (!deletedDepartment) {
      return res.status(404).json({ error: "Department not found" });
    }

    return res.status(200).json({
      msg: "Department deleted successfully",
      deletedId: departmentId,
    });
  } catch (error) {
    console.error("Error deleting department:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = {
  createDepartment,
  getAllDepartments,
  getDepartment,
  updateDepartment,
  deleteDepartment,
  assignCareTeam,
  checkDepartmentPrivilege,
};
