const mongoose = require("mongoose");
const { getDoctorModel } = require("../db/doctorschema");

// Assign location(s) to a doctor
const assignDoctorToLocation = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const {
      location_id,
      location_name,
      working_hours,
      has_fixed_schedule = true,
      schedule_notes,
    } = req.body;

    // Validate required fields
    if (!location_id || !location_name) {
      return res.status(400).json({
        msg: "location_id and location_name are required",
      });
    }

    // Check if doctorId is valid
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: "Invalid doctor ID" });
    }

    const Doctor = getDoctorModel(req.orgDb);
    const doctor = await Doctor.findById(doctorId);

    if (!doctor) {
      return res.status(404).json({ msg: "Doctor not found" });
    }

    // Check authorization
    const isAdminUser = req.user.is_admin;
    const isSelfUpdate = doctor.doctor_email === req.user.email;

    if (!isAdminUser && !isSelfUpdate) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Check if location is already assigned to this doctor
    const existingLocation = (doctor.assigned_locations || []).find(
      (loc) => loc.location_id.toString() === location_id.toString()
    );

    if (existingLocation) {
      return res.status(201).json({
        msg: "Location already assigned to this doctor",
        assigned_locations: doctor.assigned_locations,
      });
    }

    // Prepare location data
    const locationData = {
      location_id,
      location_name,
      has_fixed_schedule,
      working_hours: working_hours || {
        monday: { enabled: false, slots: [] },
        tuesday: { enabled: false, slots: [] },
        wednesday: { enabled: false, slots: [] },
        thursday: { enabled: false, slots: [] },
        friday: { enabled: false, slots: [] },
        saturday: { enabled: false, slots: [] },
        sunday: { enabled: false, slots: [] },
      },
      schedule_notes: schedule_notes || "",
      is_active: true,
      assigned_at: new Date(),
    };

    await doctor.assignLocation(locationData);

    return res.status(200).json({
      msg: "Location assigned successfully",
      assigned_locations: doctor.assigned_locations,
    });
  } catch (err) {
    console.error("Error assigning location:", err);
    return res.status(500).json({ msg: "Internal server error" });
  }
};
// Update doctor's schedule at a specific location
const updateDoctorLocationSchedule = async (req, res) => {
  try {
    const { doctorId, locationId } = req.params;
    const { working_hours, has_fixed_schedule, schedule_notes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: "Invalid doctor ID" });
    }

    const Doctor = getDoctorModel(req.orgDb);
    const doctor = await Doctor.findById(doctorId);

    if (!doctor) {
      return res.status(404).json({ msg: "Doctor not found" });
    }

    // Check authorization
    const isAdminUser = req.user.is_admin;
    const isSelfUpdate = doctor.doctor_email === req.user.email;

    if (!isAdminUser && !isSelfUpdate) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Check if doctor is assigned to this location
    if (!doctor.isAssignedToLocation(locationId)) {
      return res.status(404).json({
        msg: "Doctor is not assigned to this location",
      });
    }

    // Update schedule
    await doctor.updateLocationSchedule(locationId, {
      working_hours,
      has_fixed_schedule,
      schedule_notes,
    });

    return res.status(200).json({
      msg: "Location schedule updated successfully",
      assigned_locations: doctor.assigned_locations,
    });
  } catch (err) {
    console.error("Error updating location schedule:", err);
    return res.status(500).json({ msg: "Internal server error" });
  }
};

// Remove location assignment from doctor
const removeDoctorFromLocation = async (req, res) => {
  try {
    const { doctorId, locationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: "Invalid doctor ID" });
    }

    const Doctor = getDoctorModel(req.orgDb);
    const doctor = await Doctor.findById(doctorId);

    if (!doctor) {
      return res.status(404).json({ msg: "Doctor not found" });
    }

    // Check authorization (only admin can remove locations)
    if (!req.user.is_admin) {
      return res.status(401).json({ message: "Unauthorized - Admin only" });
    }

    await doctor.removeLocation(locationId);

    return res.status(200).json({
      msg: "Location removed successfully",
      assigned_locations: doctor.assigned_locations,
    });
  } catch (err) {
    console.error("Error removing location:", err);
    return res.status(500).json({ msg: "Internal server error" });
  }
};

// Toggle location active status
const toggleLocationStatus = async (req, res) => {
  try {
    const { doctorId, locationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: "Invalid doctor ID" });
    }

    const Doctor = getDoctorModel(req.orgDb);
    const doctor = await Doctor.findById(doctorId);

    if (!doctor) {
      return res.status(404).json({ msg: "Doctor not found" });
    }

    // Check authorization
    const isAdminUser = req.user.is_admin;
    const isSelfUpdate = doctor.doctor_email === req.user.email;

    if (!isAdminUser && !isSelfUpdate) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const location = doctor.assigned_locations.find(
      (loc) => loc.location_id === locationId
    );

    if (!location) {
      return res.status(404).json({ msg: "Location not found" });
    }

    location.is_active = !location.is_active;
    await doctor.save();

    return res.status(200).json({
      msg: `Location ${
        location.is_active ? "activated" : "deactivated"
      } successfully`,
      assigned_locations: doctor.assigned_locations,
    });
  } catch (err) {
    console.error("Error toggling location status:", err);
    return res.status(500).json({ msg: "Internal server error" });
  }
};

// Get doctor's assigned locations
const getDoctorLocations = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { activeOnly } = req.query;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: "Invalid doctor ID" });
    }

    const Doctor = getDoctorModel(req.orgDb);
    const doctor = await Doctor.findById(doctorId).select("assigned_locations");

    if (!doctor) {
      return res.status(404).json({ msg: "Doctor not found" });
    }

    let locations = doctor.assigned_locations;

    // Filter active locations only if requested
    if (activeOnly === "true") {
      locations = doctor.getActiveLocations();
    }

    return res.status(200).json({
      assigned_locations: locations,
    });
  } catch (err) {
    console.error("Error fetching doctor locations:", err);
    return res.status(500).json({ msg: "Internal server error" });
  }
};

// Get all doctors assigned to a specific location
const getDoctorsByLocation = async (req, res) => {
  try {
    const { locationId } = req.params;
    const { activeOnly } = req.query;

    const Doctor = getDoctorModel(req.orgDb);

    const query = {
      tenant_id: req.user.tenant_id,
      "assigned_locations.location_id": locationId,
    };

    if (activeOnly === "true") {
      query["assigned_locations.is_active"] = true;
    }

    const doctors = await Doctor.find(query).select(
      "doctor_first_name doctor_last_name doctor_email specialization assigned_locations doctors_photo"
    );

    // Filter to only show the relevant location data
    const doctorsWithLocation = doctors.map((doc) => {
      const docObj = doc.toObject();
      docObj.assigned_locations = docObj.assigned_locations.filter(
        (loc) => loc.location_id === locationId
      );
      return docObj;
    });

    return res.status(200).json({
      count: doctorsWithLocation.length,
      doctors: doctorsWithLocation,
    });
  } catch (err) {
    console.error("Error fetching doctors by location:", err);
    return res.status(500).json({ msg: "Internal server error" });
  }
};

module.exports = {
  assignDoctorToLocation,
  updateDoctorLocationSchedule,
  removeDoctorFromLocation,
  toggleLocationStatus,
  getDoctorLocations,
  getDoctorsByLocation,
};
