const { getDoctorModel } = require("../db/doctorschema");
const User = require("../db/userSchema");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const { getAllAppointments } = require("./appointmentsController");
const {
  generateImageSasToken,
  processMultipleDoctorsImages,
} = require("../utils/azureutils");
const { getPatientModel } = require("../db/patientSchema");
const { getDepartmentModel } = require("../db/departmentSchema");
const bcrypt = require("bcrypt");
const createDoctor = async (req, res) => {
  try {
    const {
      doctor_first_name,
      doctor_last_name,
      doctor_email,
      doctor_phone,
      qualification,
      department_id,
      roles = [],
      online_available = false,
      doctor_password,
      // 👇 remove is_admin from destructuring — we derive it from the department now
    } = req.body;

    const requiredFields = [
      "doctor_first_name",
      "doctor_last_name",
      "doctor_email",
      "doctor_phone",
      "qualification",
      "doctor_password",
      "department_id",
    ];

    const missingFields = requiredFields.filter((field) => !req.body[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        msg: "The following fields are required: " + missingFields.join(", "),
      });
    }

    if (!mongoose.Types.ObjectId.isValid(department_id)) {
      return res.status(400).json({ msg: "Invalid department ID format" });
    }

    if (!Array.isArray(roles)) {
      return res
        .status(400)
        .json({ msg: "roles must be provided as an array" });
    }

    const Doctor = getDoctorModel(req.orgDb);

    const existingDoctor = await User.findOne({
      email: doctor_email.toLowerCase(),
    });
    if (existingDoctor) {
      return res.status(400).json({
        msg: "A doctor with this email already exists",
      });
    }
    const Department = getDepartmentModel(req.orgDb);
    const department = await Department.findById(department_id);
    if (!department) {
      return res.status(400).json({ msg: "Department not found" });
    }

    const derivedIsAdmin = department.is_admin_department === true; // 👈 derive here

    const saltRounds = 10;
    // 👈 3. Hash the provided doctor_password instead of the default string
    const hashedPassword = await bcrypt.hash(
      doctor_password + process.env.JWT_SECRET_KEY,
      saltRounds,
    );
    // --- End Password Generation ---

    const newDoctor = new Doctor({
      doctor_first_name,
      doctor_last_name,
      doctor_email: doctor_email.toLowerCase(),
      doctor_phone,
      qualification,
      department_id,
      roles,
      online_available,
      tenant_id: req.user.tenant_id,
      organization_name: req.user.organization_name,
      is_admin: derivedIsAdmin, // 👈 set from department, not request body
      doctor_password: hashedPassword, // 👈 Assign hashed password to the Doctor model
    });

    const savedDoctor = await newDoctor.save();

    const user = new User({
      email: doctor_email.toLowerCase(),
      tenant_id: req.user.tenant_id,
      doctor_id: savedDoctor._id,
      password: hashedPassword, // 👈 Assign hashed password to the User model
    });
    await user.save();

    res.status(201).json({
      message: "Doctor created successfully with default password",
      doctor: savedDoctor,
    });
  } catch (error) {
    console.error("Error creating doctor:", error);
    res.status(500).json({
      message: "Error creating doctor",
      error: error.message,
    });
  }
};

const updateDoctor = async (req, res) => {
  try {
    const doctorId = req.params.id;
    const {
      doctor_first_name,
      doctor_last_name,
      doctor_phone,
      doctor_email,
      qualification,
      department_id,
      roles,
      status,
      specialization,
      youtube_videos,
      consultation_fee,
      therapy_fee,
      online_available,
      doctor_description,
      assigned_locations,
      active_hours,
    } = req.body;

    // Check if doctorId is valid
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: "Invalid doctor ID" });
    }

    // Get the Doctor model for this organization
    const Doctor = getDoctorModel(req.orgDb);

    // Find the doctor using Mongoose
    const doctor = await Doctor.findById(doctorId);

    if (!doctor) {
      return res.status(404).json({ msg: "Doctor not found" });
    }

    const isAdminUser = req.user.is_admin;
    const isSelfUpdate = doctor.doctor_email === req.user.email;

    // Check if the user is authorized to update the doctor
    if (!isAdminUser && !isSelfUpdate) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Only include fields that are not null, undefined, or missing
    const updateFields = {};
    if (doctor_first_name != null)
      updateFields.doctor_first_name = doctor_first_name;
    if (doctor_last_name != null)
      updateFields.doctor_last_name = doctor_last_name;
    if (doctor_phone != null) updateFields.doctor_phone = doctor_phone;
    if (qualification != null) updateFields.qualification = qualification;
    if (specialization != null) updateFields.specialization = specialization;
    if (consultation_fee != null)
      updateFields.consultation_fee = consultation_fee;
    if (therapy_fee != null) updateFields.therapy_fee = therapy_fee;
    if (doctor_description != null)
      updateFields.doctor_description = doctor_description;
    if (online_available != null)
      updateFields.online_available = online_available;

    // Handle Department ID update — also syncs is_admin from the department
    if (department_id != null) {
      if (!mongoose.Types.ObjectId.isValid(department_id)) {
        return res.status(400).json({ error: "Invalid department ID" });
      }

      const Department = getDepartmentModel(req.orgDb);
      const dept = await Department.findById(department_id);
      if (!dept) {
        return res.status(400).json({ error: "Department not found" });
      }

      updateFields.department_id = department_id;
      // Derive is_admin from the new department — no manual override allowed
      updateFields.is_admin = dept.is_admin_department === true;
    }

    // Handle Roles Array update
    if (roles != null) {
      if (!Array.isArray(roles)) {
        return res.status(400).json({ error: "roles must be an array" });
      }
      updateFields.roles = roles;
    }

    // Store the original email for later use
    const originalEmail = doctor.doctor_email;

    // Handle email updates separately
    let emailUpdated = false;
    if (doctor_email != null && doctor_email.toLowerCase() !== originalEmail) {
      // Check if the new email is already in use by another doctor
      const existingDoctor = await Doctor.findOne({
        doctor_email: doctor_email.toLowerCase(),
        _id: { $ne: doctorId }, // Exclude the current doctor
      });

      if (existingDoctor) {
        return res.status(400).json({
          msg: "A doctor with this email already exists",
        });
      }

      updateFields.doctor_email = doctor_email.toLowerCase();
      emailUpdated = true;
    }

    // Validate and update youtube_videos field if present
    if (youtube_videos != null) {
      if (!Array.isArray(youtube_videos)) {
        return res
          .status(400)
          .json({ error: "youtube_videos must be an array" });
      }

      for (const video of youtube_videos) {
        if (!video.id || !video.title || !video.url || !video.description) {
          return res
            .status(400)
            .json({ error: "Invalid YouTube video format" });
        }
      }
      updateFields.youtube_videos = youtube_videos;
    }

    // Handle location scheduling updates
    if (assigned_locations != null) {
      if (!Array.isArray(assigned_locations)) {
        return res
          .status(400)
          .json({ error: "assigned_locations must be an array" });
      }

      // Track location IDs in the current request to prevent duplicates within the request
      const requestLocationIds = new Set();

      // Validate each location
      for (const location of assigned_locations) {
        if (!location.location_id || !location.location_name) {
          return res.status(400).json({
            error: "Each location must have location_id and location_name",
          });
        }

        // Check if this location appears multiple times in the CURRENT REQUEST
        const locationIdStr = location.location_id.toString();
        if (requestLocationIds.has(locationIdStr)) {
          return res.status(400).json({
            error: `Location "${location.location_name}" appears multiple times in the request`,
          });
        }
        requestLocationIds.add(locationIdStr);

        // Validate working hours structure if provided
        if (location.working_hours) {
          const validDays = [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
          ];
          for (const day of validDays) {
            if (location.working_hours[day]) {
              const daySchedule = location.working_hours[day];
              if (
                daySchedule.enabled &&
                (!Array.isArray(daySchedule.slots) ||
                  daySchedule.slots.length === 0)
              ) {
                return res.status(400).json({
                  error: `Day ${day} is enabled but has no time slots`,
                });
              }

              // Validate each slot
              for (const slot of daySchedule.slots || []) {
                if (!slot.start || !slot.end) {
                  return res.status(400).json({
                    error: `Invalid time slot for ${day}: start and end times are required`,
                  });
                }
              }
            }
          }
        }

        // Set defaults for new location assignments
        if (!location.assigned_at) {
          location.assigned_at = new Date();
        }
        if (location.is_active === undefined) {
          location.is_active = true;
        }
      }

      updateFields.assigned_locations = assigned_locations;
    }

    // Handle active_hours update (admin only)
    if (active_hours != null) {
      if (!isAdminUser) {
        return res
          .status(401)
          .json({ error: "Only admins can update active hours" });
      }

      const { type, start, end, enabled } = active_hours;

      if (type && !["24h", "fixed"].includes(type)) {
        return res
          .status(400)
          .json({ error: "active_hours.type must be '24h' or 'fixed'" });
      }

      // When type is "fixed", validate start/end time format (HH:MM)
      if (type === "fixed" || (type == null && (start || end))) {
        const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
        if (start && !timeRegex.test(start)) {
          return res.status(400).json({
            error:
              "active_hours.start must be in HH:MM 24-hour format (e.g. '09:00')",
          });
        }
        if (end && !timeRegex.test(end)) {
          return res.status(400).json({
            error:
              "active_hours.end must be in HH:MM 24-hour format (e.g. '18:00')",
          });
        }
        if (start && end && start >= end) {
          return res.status(400).json({
            error: "active_hours.start must be earlier than active_hours.end",
          });
        }
      }

      updateFields.active_hours = {
        ...(type != null && { type }),
        ...(start != null && { start }),
        ...(end != null && { end }),
        ...(enabled != null && { enabled }),
      };
    }

    if (isAdminUser) {
      if (status != null) updateFields.status = status;
    }

    // If there are no fields to update, return an error
    if (Object.keys(updateFields).length === 0) {
      return res
        .status(400)
        .json({ msg: "No valid fields provided for update" });
    }

    // Update the doctor document using Mongoose
    const updatedDoctor = await Doctor.findByIdAndUpdate(
      doctorId,
      { $set: updateFields },
      { new: true }, // Return the updated document
    );

    if (!updatedDoctor) {
      return res.status(400).json({ msg: "No changes were made" });
    }

    // If email was updated, update the user record as well
    if (emailUpdated) {
      await User.findOneAndUpdate(
        {
          doctor_id: new mongoose.Types.ObjectId(doctorId),
          tenant_id: req.user.tenant_id,
        },
        {
          $set: { email: updateFields.doctor_email },
        },
      );
    }

    return res.status(200).json({
      msg: "Doctor updated successfully",
      doctor: updatedDoctor,
      isAdmin: isAdminUser,
    });
  } catch (err) {
    console.error("Error occurred:", err);
    return res.status(500).json({ msg: "Internal server error" });
  }
};

const getAllDoctors = async (req, res) => {
  try {
    const Doctor = getDoctorModel(req.orgDb);

    // Fetch only required fields + lean for performance
    const doctors = await Doctor.find(
      {},
      {
        _id: 1,
        doctor_first_name: 1,
        doctor_last_name: 1,
        doctor_email: 1,
        doctor_phone: 1,
        is_admin: 1,
        department_id:1,
        organization_name: 1,
        doctors_photo: 1,
      },
    ).lean(); // lean reduces memory + removes mongoose overhead

    // Process images in parallel only if required
    const processedDoctors = doctors.length
      ? await processMultipleDoctorsImages(doctors) // Already optimized function
      : doctors; // skip processing when array is empty

    return res.status(200).json({ doctors: processedDoctors });
  } catch (error) {
    console.error("Error retrieving doctors:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const sendDoctor = async (req, res) => {
  try {
    const doctorId = req.doctor_id;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: "Invalid doctor ID" });
    }

    // Get the Doctor model for this organization
    const Doctor = getDoctorModel(req.orgDb);

    // Find the doctor using Mongoose
    const doctor = await Doctor.findById(doctorId).lean();

    if (!doctor) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    // Generate SAS token for doctor's photo
    if (doctor.doctors_photo) {
      doctor.doctors_photo = await generateImageSasToken(doctor.doctors_photo);
    }

    return res.status(200).json(doctor);
  } catch (error) {
    console.log(error);
    return res.status(500).json({ error: error.message });
  }
};

const getDoctorInfo = async (req, res) => {
  try {
    const doctorId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: "Invalid doctor ID format" });
    }

    // Get the Doctor model for this organization
    const Doctor = getDoctorModel(req.orgDb);

    // Find the doctor using Mongoose
    const doctor = await Doctor.findById(doctorId)
      .select("-doctor_password")
      .lean();

    if (!doctor) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    // Generate SAS token for doctor's photo
    if (doctor.doctors_photo) {
      doctor.doctors_photo = await generateImageSasToken(doctor.doctors_photo);
    }

    // Add formatted creation date
    if (doctor.createdAt) {
      doctor.formattedCreationDate = moment(doctor.createdAt)
        .tz("Asia/Kolkata")
        .format("YYYY-MM-DD HH:mm:ss");
    }

    // Get appointments
    const date = new Date();
    const todayAppointments = await getAllAppointments(
      req.orgDb,
      doctorId,
      date,
    );

    doctor.todayAppointmentCount = todayAppointments.length;
    doctor.todayAppointments = todayAppointments.map((appointment) => ({
      _id: appointment._id,
      patient_name: appointment.patient_name,
      therepy_start_time: appointment.therepy_start_time,
      therepy_end_time: appointment.therepy_end_time,
      therepy_type: appointment.therepy_type,
    }));

    return res.status(200).json(doctor);
  } catch (error) {
    console.error("Error fetching doctor info:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const getDoctorInfoforWeb = async (req, res) => {
  try {
    const doctorId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: "Invalid doctor ID format" });
    }

    // Get the Doctor and Patient models for this organization
    const Doctor = getDoctorModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    // Find the doctor using Mongoose
    const doctor = await Doctor.findById(doctorId)
      .select("-doctor_password")
      .lean();

    if (!doctor) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    // Generate SAS token for doctor's photo
    if (doctor.doctors_photo) {
      doctor.doctors_photo = await generateImageSasToken(doctor.doctors_photo);
    }

    // Add formatted creation date
    if (doctor.createdAt) {
      doctor.formattedCreationDate = moment(doctor.createdAt)
        .tz("Asia/Kolkata")
        .format("YYYY-MM-DD HH:mm:ss");
    }

    // Get appointments
    const date = new Date();
    const todayAppointments = await getAllAppointments(
      req.orgDb,
      doctorId,
      date,
    );

    doctor.todayAppointmentCount = todayAppointments.length;
    doctor.todayAppointments = todayAppointments.map((appointment) => ({
      _id: appointment._id,
      patient_name: appointment.patient_name,
      therepy_start_time: appointment.therepy_start_time,
      therepy_end_time: appointment.therepy_end_time,
      therepy_type: appointment.therepy_type,
    }));

    // Get patients associated with this doctor
    const patients = await Patient.find({ doctor_id: doctorId })
      .select(
        "patient_first_name patient_last_name patient_email patient_phone patient_id patient_registration_date status",
      )
      .lean();

    // Add patient information to doctor object
    doctor.patients = patients.map((patient) => ({
      _id: patient._id,
      patient_id: patient.patient_id,
      full_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
      patient_first_name: patient.patient_first_name,
      patient_last_name: patient.patient_last_name,
      patient_email: patient.patient_email,
      patient_phone: patient.patient_phone,
      patient_registration_date: patient.patient_registration_date,
      formattedRegistrationDate: moment(patient.patient_registration_date)
        .tz("Asia/Kolkata")
        .format("YYYY-MM-DD HH:mm:ss"),
      status: patient.status,
    }));

    doctor.totalPatientCount = patients.length;
    doctor.activePatientCount = patients.filter(
      (patient) => patient.status === "Active",
    ).length;

    return res.status(200).json(doctor);
  } catch (error) {
    console.error("Error fetching doctor info:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = {
  createDoctor,
  updateDoctor,
  sendDoctor,
  getAllDoctors,
  getDoctorInfo,
  getDoctorInfoforWeb,
};
