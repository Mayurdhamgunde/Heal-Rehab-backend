const mongoose = require("mongoose");
const { getProfessionalProfileModel } = require("../db/onBoarding");
const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");
const {
  processSingleDoctorImages,
  processMultipleDoctorsProfileImages,
} = require("./imageupload");
const multer = require("multer");
const { addToEmailQueue } = require("./emailController");

// Use memory storage for Azure uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // For profile_pic - only images
    if (file.fieldname === "profile_pic") {
      if (file.mimetype.startsWith("image/")) {
        cb(null, true);
      } else {
        cb(new Error("Profile picture must be an image"), false);
      }
    }
    // For resume - PDFs or docs
    else if (file.fieldname === "resume") {
      const allowedTypes = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Resume must be PDF or Word document"), false);
      }
    } else {
      cb(null, true);
    }
  },
});

const onboardDoctor = async (req, res) => {
  try {
    console.log("=== UPLOAD DEBUG ===");
    const data = req.body;
    const files = req.files || {};

    // --- 1. Handle File Uploads to Azure ---
    let profilePicUrl = null;
    let resumeUrl = null;

    if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
      throw new Error("Azure Storage connection string not configured");
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const uploadToAzure = async (file, containerName) => {
      try {
        const containerClient = blobServiceClient.getContainerClient(containerName);
        await containerClient.createIfNotExists();
        const ext = file.originalname.split(".").pop();
        const blobName = `${data.first_name || "doctor"}-${uuidv4()}.${ext}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.upload(file.buffer, file.buffer.length, {
          blobHTTPHeaders: { blobContentType: file.mimetype },
        });
        return blockBlobClient.url;
      } catch (uploadError) {
        throw new Error(`Failed to upload ${file.fieldname}: ${uploadError.message}`);
      }
    };

    if (files.profile_pic?.[0]) {
      profilePicUrl = await uploadToAzure(files.profile_pic[0], "doctor-profiles");
    }
    if (files.resume?.[0]) {
      resumeUrl = await uploadToAzure(files.resume[0], "doctor-resumes");
    }

    // --- 2. Helper: Parse JSON Fields ---
    const parseJSON = (field) => {
      if (!field) return undefined;
      try {
        return typeof field === "string" ? JSON.parse(field) : field;
      } catch (e) {
        return [];
      }
    };

    // --- 3. Prepare Data Object ---
    const isFresher = data.is_fresher === "true" || data.is_fresher === true;
    const isOpenForShift = data.open_for_shift === "true" || data.open_for_shift === true;

    const profileData = {
      prefix: data.prefix,
      first_name: data.first_name,
      middle_name: data.middle_name,
      last_name: data.last_name,
      mobile_number: data.mobile_number,
      alternate_mobile_number: data.alternate_mobile_number,
      email: data.email,
      date_of_birth: data.date_of_birth,
      gender: data.gender,
      doctor_license_no: data.doctor_license_no,
      current_clinic_hospital_name: data.current_clinic_hospital_name,
      current_location_pincode: data.current_location_pincode,
      address_line1: data.address_line_1,
      address_line2: data.address_line_2,
      city_district: data.city_district,
      state: data.state,

      open_for_consultation: data.open_for_consultation === "true",
      open_for_duty_doctorship: data.open_for_duty_doctorship === "true",
      
      // SHIFT LOGIC FIX START
      open_for_shift: isOpenForShift,
      shift_preference: isOpenForShift ? data.shift_preference : null, 
      // SHIFT LOGIC FIX END

      available_days: parseJSON(data.available_days) || [],
      education: parseJSON(data.education) || [],
      is_fresher: isFresher,
      experience: isFresher ? [] : parseJSON(data.experience) || [],
      references: parseJSON(data.references) || [],
      profile_pic_url: profilePicUrl,
      resume_url: resumeUrl,
    };

    // --- 4. Save to Database ---
    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = getProfessionalProfileModel(usersDb);

    const existing = await ProfessionalProfile.findOne({
      doctor_license_no: profileData.doctor_license_no,
    });

    if (existing) {
      return res.status(400).json({ message: "Doctor with this License No already exists." });
    }

    const newProfile = new ProfessionalProfile(profileData);
    await newProfile.save();
    
    addToEmailQueue(data.email, `${data.first_name} ${data.last_name}`);
    
    res.status(201).json({
      success: true,
      message: "Doctor onboarded successfully",
      profileId: newProfile._id,
    });
  } catch (error) {
    console.error("Onboarding Error:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

const updateMediproPhoto = async (req, res) => {
  try {
    const profileId = req.params.profileId; // Get from URL params

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Check if profileId is valid
    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return res.status(400).json({ error: "Invalid profile ID" });
    }

    // Get the ProfessionalProfile model from Onboarding database
    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = getProfessionalProfileModel(usersDb);

    // Find the profile in the database
    const profile = await ProfessionalProfile.findById(profileId);

    if (!profile) {
      return res.status(404).json({ msg: "Professional profile not found" });
    }

    // Azure Blob Storage connection
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "doctor-profiles";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Create container if it doesn't exist
    await containerClient.createIfNotExists();

    // Delete old image if it exists
    if (profile.profile_pic_url) {
      try {
        // Extract the blob name from the URL
        const oldBlobName = profile.profile_pic_url.split("/").pop();
        const oldBlockBlobClient =
          containerClient.getBlockBlobClient(oldBlobName);

        // Check if blob exists before deleting
        const exists = await oldBlockBlobClient.exists();
        if (exists) {
          await oldBlockBlobClient.delete();
        }
      } catch (error) {
        console.error("Error deleting old image:", error);
        // Continue with upload even if delete fails
      }
    }

    // Generate unique filename
    const fileExtension = req.file.originalname.split(".").pop();
    const blobName = `${
      profile.first_name
    }-${profileId}-${uuidv4()}.${fileExtension}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Upload file
    await blockBlobClient.upload(req.file.buffer, req.file.buffer.length);

    // Get the URL of the uploaded blob
    const imageUrl = blockBlobClient.url;

    // Update profile's photo URL and updated_at timestamp
    profile.profile_pic_url = imageUrl;
    profile.updated_at = new Date();
    await profile.save();

    console.log("Profile photo updated successfully");
    res.status(200).json({
      msg: "Profile photo updated successfully",
      imageUrl: imageUrl,
    });
  } catch (err) {
    console.error("Error uploading profile photo:", err);
    res.status(500).json({ error: "Error uploading profile photo" });
  }
};

const deleteMediproPhoto = async (req, res) => {
  try {
    const profileId = req.params.profileId;

    // Check if profileId is valid
    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return res.status(400).json({ error: "Invalid profile ID" });
    }

    // Get the ProfessionalProfile model from Onboarding database
    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = getProfessionalProfileModel(usersDb);

    // Find the profile in the database
    const profile = await ProfessionalProfile.findById(profileId);

    if (!profile) {
      return res.status(404).json({ msg: "Professional profile not found" });
    }

    // If profile has no photo, return success
    if (!profile.profile_pic_url) {
      return res.status(200).json({ msg: "No profile photo to delete" });
    }

    // Azure Blob Storage connection
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "doctor-profiles";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    try {
      // Extract the blob name from the URL
      const blobName = profile.profile_pic_url.split("/").pop();
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      // Check if blob exists before deleting
      const exists = await blockBlobClient.exists();
      if (exists) {
        await blockBlobClient.delete();
      }
    } catch (error) {
      console.error("Error deleting image from Azure:", error);
      return res
        .status(500)
        .json({ error: "Error deleting image from storage" });
    }

    // Update profile's record to remove photo URL and update timestamp
    profile.profile_pic_url = undefined;
    profile.updated_at = new Date();
    await profile.save();

    res.status(200).json({ msg: "Profile photo deleted successfully" });
  } catch (error) {
    console.error("Error in deleteMediproPhoto:", error);
    res.status(500).json({ error: "Error deleting profile photo" });
  }
};

const updateMediproResume = async (req, res) => {
  try {
    const profileId = req.params.profileId;

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Check if profileId is valid
    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return res.status(400).json({ error: "Invalid profile ID" });
    }

    // Get the ProfessionalProfile model from Onboarding database
    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = getProfessionalProfileModel(usersDb);

    // Find the profile in the database
    const profile = await ProfessionalProfile.findById(profileId);

    if (!profile) {
      return res.status(404).json({ msg: "Professional profile not found" });
    }

    // Azure Blob Storage connection
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "doctor-resumes";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Create container if it doesn't exist
    await containerClient.createIfNotExists();

    // Delete old resume if it exists
    if (profile.resume_url) {
      try {
        const oldBlobName = profile.resume_url.split("/").pop();
        const oldBlockBlobClient =
          containerClient.getBlockBlobClient(oldBlobName);

        const exists = await oldBlockBlobClient.exists();
        if (exists) {
          await oldBlockBlobClient.delete();
        }
      } catch (error) {
        console.error("Error deleting old resume:", error);
      }
    }

    // Generate unique filename
    const fileExtension = req.file.originalname.split(".").pop();
    const blobName = `${
      profile.first_name
    }-${profileId}-${uuidv4()}.${fileExtension}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Upload file
    await blockBlobClient.upload(req.file.buffer, req.file.buffer.length);

    // Get the URL of the uploaded blob
    const resumeUrl = blockBlobClient.url;

    // Update profile's resume URL and updated_at timestamp
    profile.resume_url = resumeUrl;
    profile.updated_at = new Date();
    await profile.save();

    console.log("Resume updated successfully");
    res.status(200).json({
      msg: "Resume updated successfully",
      resumeUrl: resumeUrl,
    });
  } catch (err) {
    console.error("Error uploading resume:", err);
    res.status(500).json({ error: "Error uploading resume" });
  }
};

const deleteMediproResume = async (req, res) => {
  try {
    const profileId = req.params.profileId;

    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return res.status(400).json({ error: "Invalid profile ID" });
    }

    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = getProfessionalProfileModel(usersDb);

    const profile = await ProfessionalProfile.findById(profileId);

    if (!profile) {
      return res.status(404).json({ msg: "Professional profile not found" });
    }

    if (!profile.resume_url) {
      return res.status(200).json({ msg: "No resume to delete" });
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "doctor-resumes";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    try {
      const blobName = profile.resume_url.split("/").pop();
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      const exists = await blockBlobClient.exists();
      if (exists) {
        await blockBlobClient.delete();
      }
    } catch (error) {
      console.error("Error deleting resume from Azure:", error);
      return res
        .status(500)
        .json({ error: "Error deleting resume from storage" });
    }

    profile.resume_url = undefined;
    profile.updated_at = new Date();
    await profile.save();

    res.status(200).json({ msg: "Resume deleted successfully" });
  } catch (error) {
    console.error("Error in deleteMediproResume:", error);
    res.status(500).json({ error: "Error deleting resume" });
  }
};

const approveDoctor = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { approved, rejection_reason } = req.body;
    const approved_by = req.user.id;

    // Validation
    if (!doctorId) {
      return res.status(400).json({
        success: false,
        message: "Doctor ID is required",
      });
    }

    if (typeof approved !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "Approval status (approved: true/false) is required",
      });
    }

    // If rejecting, require a reason
    if (approved === false && !rejection_reason) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required when rejecting a doctor",
      });
    }

    // Connect to database
    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = getProfessionalProfileModel(usersDb);

    // Find the doctor
    const doctor = await ProfessionalProfile.findById(doctorId);

    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: "Doctor not found",
      });
    }

    // Check if already approved/rejected
    if (doctor.approval_status === "approved") {
      return res.status(400).json({
        success: false,
        message: "Doctor is already approved",
      });
    }

    // Update approval status
    const updateData = {
      approval_status: approved ? "approved" : "rejected",
      reviewed_at: new Date(),
      is_verified: approved ? true : false,
      review_remarks: approved ? "Approved" : rejection_reason,
      reviewed_by: approved_by || undefined,
    };

    // Add approval/rejection timestamp
    if (approved) {
      updateData.approved_at = new Date();
    } else {
      updateData.rejected_at = new Date();
      updateData.rejection_reason = rejection_reason;
    }

    const updatedDoctor = await ProfessionalProfile.findByIdAndUpdate(
      doctorId,
      updateData,
      { new: true, runValidators: true },
    );

    // Send approval/rejection email
    const doctorName = `${doctor.first_name} ${doctor.last_name}`;

    if (approved) {
      // Send approval email
      addToEmailQueue(doctor.email, doctorName, "approval");
    } else {
      // Send rejection email
      addToEmailQueue(doctor.email, doctorName, "rejection", {
        rejectionReason: rejection_reason,
      });
    }

    res.status(200).json({
      success: true,
      message: `Doctor ${approved ? "approved" : "rejected"} successfully`,
      doctor: {
        id: updatedDoctor._id,
        name: doctorName,
        email: updatedDoctor.email,
        approval_status: updatedDoctor.approval_status,
        approved_at: updatedDoctor.approved_at,
        rejected_at: updatedDoctor.rejected_at,
        rejection_reason: updatedDoctor.rejection_reason,
        reviewed_at: updatedDoctor.reviewed_at,
      },
    });
  } catch (error) {
    console.error("Doctor Approval Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

const getAllApplications = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      search,
      city_district,
      state,
      current_location_pincode,
      speciality,
      open_for_duty_doctorship,
      available_days,
    } = req.query;

    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = getProfessionalProfileModel(usersDb);

    // Build query filter
    const query = {};

    // Filter by approval status
    if (status) {
      query.approval_status = status;
    }

    // Filter by state
    if (state) {
      query.state = { $regex: state, $options: "i" };
    }

    // Filter by city/district
    if (city_district) {
      query.city_district = { $regex: city_district, $options: "i" };
    }

    // Filter by pincode
    if (current_location_pincode) {
      query.current_location_pincode = current_location_pincode;
    }

    // Filter by availability for duty doctorship
    if (open_for_duty_doctorship !== undefined) {
      query.open_for_duty_doctorship = open_for_duty_doctorship === "true";
    }

    // Filter by specialty
    if (speciality) {
      query["education.speciality"] = { $regex: speciality, $options: "i" };
    }

    // Filter by available days
    // Supports single day: ?available_days=Mon
    // Or multiple days: ?available_days=Mon,Tue,Wed
    if (available_days) {
      const daysArray = available_days.split(",").map((day) => day.trim());
      // Find doctors available on ALL specified days
      query.available_days = { $all: daysArray };

      // Alternative: Find doctors available on ANY of the specified days
      // query.available_days = { $in: daysArray };
    }

    // Search functionality
    if (search) {
      query.$or = [
        { first_name: { $regex: search, $options: "i" } },
        { last_name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { doctor_license_no: { $regex: search, $options: "i" } },
        { "education.speciality": { $regex: search, $options: "i" } },
        { city_district: { $regex: search, $options: "i" } },
        { state: { $regex: search, $options: "i" } },
        { current_location_pincode: { $regex: search, $options: "i" } },
      ];
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Execute query with pagination
    const applications = await ProfessionalProfile.find(query)
      .select("-__v") // Exclude version key
      .sort({ created_at: -1 }) // Most recent first
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get total count for pagination
    const totalCount = await ProfessionalProfile.countDocuments(query);

    // Get status counts for dashboard
    const statusCounts = await ProfessionalProfile.aggregate([
      {
        $group: {
          _id: "$approval_status",
          count: { $sum: 1 },
        },
      },
    ]);

    const statusSummary = {
      pending: 0,
      approved: 0,
      rejected: 0,
    };

    statusCounts.forEach((item) => {
      if (item._id) {
        statusSummary[item._id] = item.count;
      }
    });

    // Generate SAS tokens for all doctors' images and resumes
    const processedApplications =
      await processMultipleDoctorsProfileImages(applications);

    res.status(200).json({
      success: true,
      data: processedApplications,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        totalItems: totalCount,
        itemsPerPage: parseInt(limit),
      },
      statusSummary,
    });
  } catch (error) {
    console.error("Error fetching applications:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch applications",
      error: error.message,
    });
  }
};

const getLocationWithSpeciality = async (req, res) => {
  try {
    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = usersDb.model(
      "ProfessionalProfile",
      require("../db/onBoarding").professionalProfileSchema,
      "professional_profiles",
    );

    // 1️⃣ Fetch profiles with minimal filtering
    const profiles = await ProfessionalProfile.find(
      {
        state: { $exists: true, $ne: null, $ne: "" },
        city_district: { $exists: true, $ne: null, $ne: "" },
      },
      {
        state: 1,
        city_district: 1,
        education: 1,
        _id: 0,
      },
    ).lean();

    console.log(`Found ${profiles.length} profiles with location data`);

    // 2️⃣ Build hierarchy and collect all specialities
    const stateMap = new Map();
    const allSpecialitiesSet = new Set(); // Track all unique specialities

    for (const profile of profiles) {
      const state = profile.state?.trim();
      const city = profile.city_district?.trim();

      if (!state || !city) {
        continue;
      }

      // Initialize state if not exists
      if (!stateMap.has(state)) {
        stateMap.set(state, new Map());
      }

      const cityMap = stateMap.get(state);

      // Initialize city if not exists
      if (!cityMap.has(city)) {
        cityMap.set(city, new Set());
      }

      const specialitySet = cityMap.get(city);

      // Extract specialities from education array
      if (Array.isArray(profile.education)) {
        for (const edu of profile.education) {
          const speciality = edu?.speciality?.trim();
          if (speciality) {
            specialitySet.add(speciality);
            allSpecialitiesSet.add(speciality); // Add to global set
          }
        }
      }
    }

    // 3️⃣ Convert Maps → JSON with sorted output
    const locationData = [];

    for (const [state, citiesMap] of stateMap.entries()) {
      const cities = [];

      for (const [city, specialitiesSet] of citiesMap.entries()) {
        cities.push({
          city,
          // specialities: Array.from(specialitiesSet).sort(),
        });
      }

      cities.sort((a, b) => a.city.localeCompare(b.city));

      locationData.push({
        state,
        cities,
      });
    }

    locationData.sort((a, b) => a.state.localeCompare(b.state));

    // 4️⃣ Convert specialities Set to sorted array
    const allSpecialities = Array.from(allSpecialitiesSet).sort();

    console.log(
      `Returning ${locationData.length} states with ${allSpecialities.length} unique specialities`,
    );

    return res.status(200).json({
      success: true,
      count: {
        states: locationData.length,
        totalCities: locationData.reduce((acc, s) => acc + s.cities.length, 0),
        totalSpecialities: allSpecialities.length,
      },
      data: {
        locations: locationData,
        specialities: allSpecialities, // Separate array of all unique specialities
      },
    });
  } catch (error) {
    console.error("Error fetching location & speciality:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch location data",
      error: error.message,
    });
  }
};

/**
 * Get single doctor application by ID
 * @route GET /api/doctors/applications/:id
 * @param {string} id - Application/Profile ID
 */

const getApplicationById = async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid application ID",
      });
    }

    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = getProfessionalProfileModel(usersDb);

    const application = await ProfessionalProfile.findById(id)
      .select("-__v")
      .lean();

    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Application not found",
      });
    }

    // Generate SAS tokens for profile picture and resume
    const processedApplication = await processSingleDoctorImages(application);

    res.status(200).json({
      success: true,
      data: processedApplication,
    });
  } catch (error) {
    console.error("Error fetching application:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch application",
      error: error.message,
    });
  }
};

// Update the reviewApplication function to include SAS tokens in response
const reviewApplication = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, remarks, reviewed_by } = req.body;

    // Validate input
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid application ID",
      });
    }

    if (!action || !["approve", "reject"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Invalid action. Must be 'approve' or 'reject'",
      });
    }

    if (!reviewed_by) {
      return res.status(400).json({
        success: false,
        message: "Reviewer ID is required",
      });
    }

    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = getProfessionalProfileModel(usersDb);

    // Find the application
    const application = await ProfessionalProfile.findById(id);

    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Application not found",
      });
    }

    // Check if already reviewed
    if (
      application.approval_status &&
      application.approval_status !== "pending"
    ) {
      return res.status(400).json({
        success: false,
        message: `Application already ${application.approval_status}`,
        current_status: application.approval_status,
      });
    }

    // Update application status
    const updateData = {
      approval_status: action === "approve" ? "approved" : "rejected",
      is_verified: action === "approve",
      reviewed_at: new Date(),
      reviewed_by: reviewed_by,
      updated_at: new Date(),
    };

    if (remarks) {
      updateData.review_remarks = remarks;
    }

    // If approved, set status to Active
    if (action === "approve") {
      updateData.status = "Active";
    }

    const updatedApplication = await ProfessionalProfile.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true },
    )
      .select("-__v")
      .lean();

    // Generate SAS tokens for the updated application
    const processedApplication =
      await processSingleDoctorImages(updatedApplication);

    res.status(200).json({
      success: true,
      message: `Application ${
        action === "approve" ? "approved" : "rejected"
      } successfully`,
      data: processedApplication,
    });
  } catch (error) {
    console.error("Error reviewing application:", error);
    res.status(500).json({
      success: false,
      message: "Failed to review application",
      error: error.message,
    });
  }
};

/**
 * Bulk approve/reject applications
 * @route PATCH /api/doctors/applications/bulk-review
 * @body {string[]} application_ids - Array of application IDs
 * @body {string} action - 'approve' or 'reject'
 * @body {string} reviewed_by - Admin/Reviewer ID
 * @body {string} remarks - Optional remarks
 */
const bulkReviewApplications = async (req, res) => {
  try {
    const { application_ids, action, reviewed_by, remarks } = req.body;

    // Validate input
    if (
      !application_ids ||
      !Array.isArray(application_ids) ||
      application_ids.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Application IDs array is required",
      });
    }

    if (!action || !["approve", "reject"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Invalid action. Must be 'approve' or 'reject'",
      });
    }

    if (!reviewed_by) {
      return res.status(400).json({
        success: false,
        message: "Reviewer ID is required",
      });
    }

    // Validate all IDs
    const invalidIds = application_ids.filter(
      (id) => !mongoose.Types.ObjectId.isValid(id),
    );
    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Some application IDs are invalid",
        invalid_ids: invalidIds,
      });
    }

    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = getProfessionalProfileModel(usersDb);

    // Update data
    const updateData = {
      approval_status: action === "approve" ? "approved" : "rejected",
      is_verified: action === "approve",
      reviewed_at: new Date(),
      reviewed_by: reviewed_by,
      updated_at: new Date(),
    };

    if (remarks) {
      updateData.review_remarks = remarks;
    }

    if (action === "approve") {
      updateData.status = "Active";
    }

    // Bulk update - only update pending applications
    const result = await ProfessionalProfile.updateMany(
      {
        _id: { $in: application_ids },
        approval_status: { $in: ["pending", null] },
      },
      { $set: updateData },
    );

    res.status(200).json({
      success: true,
      message: `Bulk ${action} completed`,
      modified_count: result.modifiedCount,
      matched_count: result.matchedCount,
    });
  } catch (error) {
    console.error("Error in bulk review:", error);
    res.status(500).json({
      success: false,
      message: "Failed to perform bulk review",
      error: error.message,
    });
  }
};

/**
 * Get application statistics
 * @route GET /api/doctors/applications/stats
 */
const getApplicationStats = async (req, res) => {
  try {
    const usersDb = mongoose.connection.useDb("Onboarding");
    const ProfessionalProfile = getProfessionalProfileModel(usersDb);

    const stats = await ProfessionalProfile.aggregate([
      {
        $facet: {
          statusCounts: [
            {
              $group: {
                _id: "$approval_status",
                count: { $sum: 1 },
              },
            },
          ],
          availabilityStats: [
            {
              $group: {
                _id: null,
                openForConsultation: {
                  $sum: { $cond: ["$open_for_consultation", 1, 0] },
                },
                openForDutyDoctorship: {
                  $sum: { $cond: ["$open_for_duty_doctorship", 1, 0] },
                },
                openForShift: {
                  $sum: { $cond: ["$open_for_shift", 1, 0] },
                },
              },
            },
          ],
          topCities: [
            {
              $group: {
                _id: "$city_district",
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 10 },
          ],
          recentApplications: [
            { $sort: { created_at: -1 } },
            { $limit: 5 },
            {
              $project: {
                first_name: 1,
                last_name: 1,
                email: 1,
                approval_status: 1,
                created_at: 1,
              },
            },
          ],
        },
      },
    ]);

    res.status(200).json({
      success: true,
      data: stats[0],
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch statistics",
      error: error.message,
    });
  }
};
module.exports = {
  getAllApplications,
  getApplicationById,
  reviewApplication,
  bulkReviewApplications,
  getApplicationStats,
  onboardDoctor,
  updateMediproPhoto,
  deleteMediproPhoto,
  updateMediproResume,
  deleteMediproResume,
  approveDoctor,
  upload,
  getLocationWithSpeciality,
};
