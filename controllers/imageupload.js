const multer = require("multer");
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");
const {
  generateImageSasToken,
  generateImageSasTokenLogo,
} = require("../utils/azureutils");
const Organization = require("../db/OrganizationSchema");
const { getDoctorModel } = require("../db/doctorschema");

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 5MB limit
  },
});

const updateDoctorPhoto = async (req, res) => {
  try {
    console.log("");
    const doctorId = req.doctor_id;

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Check if doctorId is valid
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: "Invalid doctor ID" });
    }

    // Get the Doctor model for this organization
    const DoctorModel = getDoctorModel(req.orgDb);

    // Find the doctor in the database
    const doctor = await DoctorModel.findById(doctorId);

    if (!doctor) {
      return res.status(404).json({ msg: "Doctor not found" });
    }

    // Azure Blob Storage connection
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "imagesforhealtrack";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Create container if it doesn't exist
    await containerClient.createIfNotExists();

    // Delete old image if it exists
    if (doctor.doctors_photo) {
      try {
        // Extract the blob name from the URL
        const oldBlobName = doctor.doctors_photo.split("/").pop();
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
    const blobName = `${doctorId}-${uuidv4()}.${fileExtension}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Upload file
    await blockBlobClient.upload(req.file.buffer, req.file.buffer.length);

    // Get the URL of the uploaded blob
    const imageUrl = blockBlobClient.url;

    // Update doctor's photo URL in database using Mongoose
    doctor.doctors_photo = imageUrl;
    await doctor.save();

    // Generate SAS token for the newly uploaded image
    const imageUrlWithSas = await generateImageSasToken(imageUrl);

    console.log("success");
    res.status(200).json({
      msg: "Profile photo updated successfully",
      imageUrl: imageUrlWithSas, // Return the URL with SAS token instead of the raw URL
    });
  } catch (err) {
    console.error("Error uploading image:", err);
    res.status(500).json({ error: "Error uploading image" });
  }
};

const deleteDoctorImage = async (req, res) => {
  try {
    const doctorId = req.doctor_id;

    // Check if doctorId is valid
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: "Invalid doctor ID" });
    }

    // Get the Doctor model for this organization
    const DoctorModel = getDoctorModel(req.orgDb);

    // Find the doctor in the database
    const doctor = await DoctorModel.findById(doctorId);

    if (!doctor) {
      return res.status(404).json({ msg: "Doctor not found" });
    }

    // If doctor has no photo, return success
    if (!doctor.doctors_photo) {
      return res.status(200).json({ msg: "No profile photo to delete" });
    }

    // Azure Blob Storage connection
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "imagesforhealtrack";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    try {
      // Extract the blob name from the URL
      const blobName = doctor.doctors_photo.split("/").pop();
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

    // Update doctor's record to remove photo URL using Mongoose
    doctor.doctors_photo = undefined;
    await doctor.save();

    res.status(200).json({ msg: "Profile photo deleted successfully" });
  } catch (error) {
    console.error("Error in deleteDoctorImage:", error);
    res.status(500).json({ error: "Error deleting profile photo" });
  }
};

const updateOrganizationLogo = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const isAdminUser = req.user.is_admin;

    // Check if the user is authorized to update the org
    if (!isAdminUser) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Check if tenant_id is valid
    if (!tenant_id) {
      return res.status(400).json({ error: "Tenant ID is required" });
    }

    // Find the organization in the database using Mongoose
    const organization = await Organization.findOne({ tenant_id });

    if (!organization) {
      return res.status(404).json({ msg: "Organization not found" });
    }

    // Azure Blob Storage connection
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "organizationlogos";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Create container if it doesn't exist
    await containerClient.createIfNotExists();

    // Delete old logo if it exists
    if (organization.organization_logo) {
      try {
        // Extract the blob name from the URL
        const oldBlobName = organization.organization_logo.split("/").pop();
        const oldBlockBlobClient =
          containerClient.getBlockBlobClient(oldBlobName);

        // Check if blob exists before deleting
        const exists = await oldBlockBlobClient.exists();
        if (exists) {
          await oldBlockBlobClient.delete();
        }
      } catch (error) {
        console.error("Error deleting old logo:", error);
        // Continue with upload even if delete fails
      }
    }

    // Generate unique filename
    const fileExtension = req.file.originalname.split(".").pop();
    const blobName = `${tenant_id}-${uuidv4()}.${fileExtension}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Upload file
    await blockBlobClient.upload(req.file.buffer, req.file.buffer.length);

    // Get the URL of the uploaded blob
    const imageUrl = blockBlobClient.url;

    // Update organization's logo URL in database using Mongoose
    organization.organization_logo = imageUrl;
    await organization.save();

    // Generate SAS token for the newly uploaded image
    const imageUrlWithSas = await generateImageSasTokenLogo(imageUrl);

    res.status(200).json({
      msg: "Organization logo updated successfully",
      imageUrl: imageUrlWithSas, // Return the URL with SAS token instead of the raw URL
    });
  } catch (err) {
    console.error("Error uploading organization logo:", err);
    res.status(500).json({ error: "Error uploading organization logo" });
  }
};

const updateOrganizationBackgroud = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const isAdminUser = req.user.is_admin;

    // Check if the user is authorized to update the org
    if (!isAdminUser) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Check if tenant_id is valid
    if (!tenant_id) {
      return res.status(400).json({ error: "Tenant ID is required" });
    }

    // Find the organization in the database using Mongoose
    const organization = await Organization.findOne({ tenant_id });

    if (!organization) {
      return res.status(404).json({ msg: "Organization not found" });
    }

    // Azure Blob Storage connection
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "organizationlogos";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Create container if it doesn't exist
    await containerClient.createIfNotExists();

    // Delete old banner if it exists
    if (organization.organization_banner) {
      try {
        // Extract the blob name from the URL
        const oldBlobName = organization.organization_banner.split("/").pop();
        const oldBlockBlobClient =
          containerClient.getBlockBlobClient(oldBlobName);

        // Check if blob exists before deleting
        const exists = await oldBlockBlobClient.exists();
        if (exists) {
          await oldBlockBlobClient.delete();
        }
      } catch (error) {
        console.error("Error deleting old banner:", error);
        // Continue with upload even if delete fails
      }
    }

    // Generate unique filename
    const fileExtension = req.file.originalname.split(".").pop();
    const blobName = `${tenant_id}-${uuidv4()}.${fileExtension}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Upload file
    await blockBlobClient.upload(req.file.buffer, req.file.buffer.length);

    // Get the URL of the uploaded blob
    const imageUrl = blockBlobClient.url;

    // Update organization's banner URL in database using Mongoose
    organization.organization_banner = imageUrl;
    await organization.save();

    // Generate SAS token for the newly uploaded image
    const imageUrlWithSas = await generateImageSasTokenLogo(imageUrl);

    res.status(200).json({
      msg: "Organization background updated successfully",
      imageUrl: imageUrlWithSas, // Return the URL with SAS token instead of the raw URL
    });
  } catch (err) {
    console.error("Error uploading organization background:", err);
    res.status(500).json({ error: "Error uploading organization background" });
  }
};

const deleteOrganizationBackground = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const isAdminUser = req.user.is_admin;

    // Check if the user is authorized to update the org
    if (!isAdminUser) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Check if tenant_id is valid
    if (!tenant_id) {
      return res.status(400).json({ error: "Tenant ID is required" });
    }

    // Find the organization in the database using Mongoose
    const organization = await Organization.findOne({ tenant_id });

    if (!organization) {
      return res.status(404).json({ msg: "Organization not found" });
    }

    // If organization has no banner, return success
    if (!organization.organization_banner) {
      return res
        .status(200)
        .json({ msg: "No organization background to delete" });
    }

    // Azure Blob Storage connection
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "organizationlogos";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    try {
      // Extract the blob name from the URL
      const blobName = organization.organization_banner.split("/").pop();
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      // Check if blob exists before deleting
      const exists = await blockBlobClient.exists();
      if (exists) {
        await blockBlobClient.delete();
      }
    } catch (error) {
      console.error("Error deleting background from Azure:", error);
      return res
        .status(500)
        .json({ error: "Error deleting background from storage" });
    }

    // Update organization's record to remove banner URL using Mongoose
    organization.organization_banner = undefined;
    await organization.save();

    res
      .status(200)
      .json({ msg: "Organization background deleted successfully" });
  } catch (error) {
    console.error("Error in deleteOrganizationBackground:", error);
    res.status(500).json({ error: "Error deleting organization background" });
  }
};

const deleteOrganizationLogo = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const isAdminUser = req.user.is_admin;

    // Check if the user is authorized to update the org
    if (!isAdminUser) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Check if tenant_id is valid
    if (!tenant_id) {
      return res.status(400).json({ error: "Tenant ID is required" });
    }

    // Find the organization in the database using Mongoose
    const organization = await Organization.findOne({ tenant_id });

    if (!organization) {
      return res.status(404).json({ msg: "Organization not found" });
    }

    // If organization has no logo, return success
    if (!organization.organization_logo) {
      return res.status(200).json({ msg: "No organization logo to delete" });
    }

    // Azure Blob Storage connection
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "organizationlogos";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    try {
      // Extract the blob name from the URL
      const blobName = organization.organization_logo.split("/").pop();
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      // Check if blob exists before deleting
      const exists = await blockBlobClient.exists();
      if (exists) {
        await blockBlobClient.delete();
      }
    } catch (error) {
      console.error("Error deleting logo from Azure:", error);
      return res
        .status(500)
        .json({ error: "Error deleting logo from storage" });
    }

    // Update organization's record to remove logo URL using Mongoose
    organization.organization_logo = undefined;
    await organization.save();

    res.status(200).json({ msg: "Organization logo deleted successfully" });
  } catch (error) {
    console.error("Error in deleteOrganizationLogo:", error);
    res.status(500).json({ error: "Error deleting organization logo" });
  }
};

// Helper function to extract blob name from doctor profile URL
const getBlobNameFromDoctorProfileURL = (url) => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const containerName = "doctor-profiles";

    // FIX: Add decodeURIComponent to handle spaces and special chars
    const encodedBlobName = pathname.replace(`/${containerName}/`, "");
    return decodeURIComponent(encodedBlobName);
  } catch (error) {
    console.error("Error parsing doctor profile blob URL:", error);
    return null;
  }
};

// Helper function to extract blob name from doctor resume URL
const getBlobNameFromDoctorResumeURL = (url) => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const containerName = "doctor-resumes";

    // FIX: Add decodeURIComponent
    const encodedBlobName = pathname.replace(`/${containerName}/`, "");
    return decodeURIComponent(encodedBlobName);
  } catch (error) {
    console.error("Error parsing doctor resume blob URL:", error);
    return null;
  }
};

// Generate SAS token for doctor profile picture
const generateDoctorProfileSasToken = async (profilePicUrl) => {
  try {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    const containerName = "doctor-profiles";

    if (!profilePicUrl) return null;

    const blobName = getBlobNameFromDoctorProfileURL(profilePicUrl);
    if (!blobName) return null;

    const sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey,
    );

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    // Generate SAS token that expires in 48 hours
    const startsOn = new Date();
    const expiresOn = new Date(startsOn);
    expiresOn.setHours(startsOn.getHours() + 48);

    const sasOptions = {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"), // Read-only permission
      startsOn,
      expiresOn,
    };

    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      sharedKeyCredential,
    ).toString();

    return `${blobClient.url}?${sasToken}`;
  } catch (error) {
    console.error("Error generating SAS token for doctor profile:", error);
    return null;
  }
};

// Generate SAS token for doctor resume
const generateDoctorResumeSasToken = async (resumeUrl) => {
  try {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    const containerName = "doctor-resumes";

    if (!resumeUrl) return null;

    const blobName = getBlobNameFromDoctorResumeURL(resumeUrl);
    if (!blobName) return null;

    const sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey,
    );

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    // Generate SAS token that expires in 48 hours
    const startsOn = new Date();
    const expiresOn = new Date(startsOn);
    expiresOn.setHours(startsOn.getHours() + 48);

    const sasOptions = {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"), // Read-only permission
      startsOn,
      expiresOn,
    };

    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      sharedKeyCredential,
    ).toString();

    return `${blobClient.url}?${sasToken}`;
  } catch (error) {
    console.error("Error generating SAS token for doctor resume:", error);
    return null;
  }
};

// Process single doctor to generate SAS tokens for profile pic and resume
const processSingleDoctorImages = async (doctor) => {
  try {
    if (!doctor) return null;

    const profilePicSasUrl = doctor.profile_pic_url
      ? await generateDoctorProfileSasToken(doctor.profile_pic_url)
      : null;

    const resumeSasUrl = doctor.resume_url
      ? await generateDoctorResumeSasToken(doctor.resume_url)
      : null;

    return {
      ...doctor,
      profile_pic_url: profilePicSasUrl,
      resume_url: resumeSasUrl,
    };
  } catch (error) {
    console.error("Error processing single doctor images:", error);
    return doctor; // Return original doctor object if processing fails
  }
};

// Process multiple doctors to generate SAS tokens for their images and resumes
const processMultipleDoctorsProfileImages = async (doctors) => {
  try {
    if (!Array.isArray(doctors)) {
      return [];
    }

    const processedDoctors = await Promise.all(
      doctors.map(async (doctor) => {
        const profilePicSasUrl = doctor.profile_pic_url
          ? await generateDoctorProfileSasToken(doctor.profile_pic_url)
          : null;

        const resumeSasUrl = doctor.resume_url
          ? await generateDoctorResumeSasToken(doctor.resume_url)
          : null;

        return {
          ...doctor,
          profile_pic_url: profilePicSasUrl,
          resume_url: resumeSasUrl,
        };
      }),
    );

    return processedDoctors;
  } catch (error) {
    console.error("Error processing multiple doctors:", error);
    return doctors; // Return original array if processing fails
  }
};

module.exports = {
  updateDoctorPhoto,
  upload,
  generateDoctorProfileSasToken,
  generateDoctorResumeSasToken,
  processSingleDoctorImages,
  processMultipleDoctorsProfileImages,
  getBlobNameFromDoctorProfileURL,
  getBlobNameFromDoctorResumeURL,
  updateOrganizationLogo,
  deleteOrganizationLogo,
  deleteDoctorImage,
  updateOrganizationBackgroud,
  deleteOrganizationBackground,
};
