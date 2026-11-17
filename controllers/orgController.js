const { MongoClient } = require("mongodb");
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
require("dotenv").config();
// Import the utilities
const { generateImageSasTokenLogo } = require("../utils/azureutils");
const Organization = require("../db/OrganizationSchema"); // Import the Organization model
const mongoUrl = process.env.MONGO_LINK;

/**
 * Get organization data by tenant_id
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getOrg = async (req, res) => {
  try {
    const tenant_id = req.user?.tenant_id;

    if (!tenant_id) {
      return res.status(400).json({ msg: "Tenant ID is required" });
    }

    // Fast read: lean() prevents loading mongoose overhead
    const organization = await Organization.findOne({ tenant_id }).lean();

    if (!organization) {
      return res.status(404).json({ msg: "Organization not found" });
    }

    // Generate SAS tokens in parallel
    const [logo, banner] = await Promise.all([
      organization.organization_logo
        ? generateImageSasTokenLogo(organization.organization_logo)
        : null,
      organization.organization_banner
        ? generateImageSasTokenLogo(organization.organization_banner)
        : null,
    ]);

    // Apply SAS URLs only if present
    if (logo) organization.organization_logo = logo;
    if (banner) organization.organization_banner = banner;

    res.status(200).json({
      organization,
      message: "Organization retrieved successfully",
    });
  } catch (error) {
    console.error("Error retrieving organization:", error);
    res.status(500).json({
      message: "Error retrieving organization",
      error: error.message,
    });
  }
};

const getOrgLocations = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;

    if (!tenant_id) {
      return res.status(400).json({ msg: "Tenant ID is required" });
    }

    const { limit, search, locationId, name, count_only } = req.query;

    // -------------------------------
    //   COUNT ONLY (Super Fast)
    // -------------------------------
    if (count_only === "true") {
      const org = await Organization.findOne(
        { tenant_id },
        { "organization_locations._id": 1 },
      ).lean();

      if (!org) {
        return res.status(404).json({ msg: "Organization not found" });
      }

      return res.status(200).json({
        count: org.organization_locations?.length || 0,
        message: "Location count retrieved successfully",
      });
    }

    // -------------------------------
    //   MAIN QUERY
    // -------------------------------
    const pipeline = [
      { $match: { tenant_id } },
      { $project: { organization_locations: 1, _id: 0 } }, // project early
      { $unwind: "$organization_locations" },
    ];

    const matchConditions = {};

    // SEARCH → name OR address
    if (search) {
      matchConditions.$or = [
        { "organization_locations.name": { $regex: search, $options: "i" } },
        { "organization_locations.address": { $regex: search, $options: "i" } },
      ];
    }

    // FILTER BY locationId
    if (locationId) {
      matchConditions["organization_locations.locationId"] = locationId;
    }

    // FILTER BY name
    if (name) {
      matchConditions["organization_locations.name"] = {
        $regex: name,
        $options: "i",
      };
    }

    // Add match only if needed
    if (Object.keys(matchConditions).length) {
      pipeline.push({ $match: matchConditions });
    }

    // LIMIT
    if (limit && !isNaN(+limit)) {
      pipeline.push({ $limit: +limit });
    }

    pipeline.push({
      $replaceRoot: { newRoot: "$organization_locations" },
    });

    const locations = await Organization.aggregate(pipeline);

    // Final response
    res.status(200).json({
      locations,
      count: locations.length,
      message: "Organization locations retrieved successfully",
    });
  } catch (error) {
    console.error("Error retrieving organization locations:", error);
    res.status(500).json({
      message: "Error retrieving organization locations",
      error: error.message,
    });
  }
};

/**
 * Update organization information
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const updateOrg = async (req, res) => {
  try {
    // The tenant_id is required to identify the organization to update
    const tenant_id = req.user.tenant_id;

    if (!tenant_id) {
      return res.status(400).json({
        msg: "tenant_id is required to update organization",
      });
    }

    // Check if the user is authorized to update the org
    const isAdminUser = req.user.is_admin;
    if (!isAdminUser) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Extract updatable fields from the request body
    const {
      organization_name,
      organization_employees,
      organization_email,
      organization_phone,
      // Address fields
      organization_address_street,
      organization_address_city,
      organization_address_state,
      organization_address_zip,
      organization_address_country,
      // Additional fields
      organization_website,
      organization_description,
      organization_tax_id,
      organization_founded_year,
      organization_industry,
      organization_size,
      organization_timezone,
      organization_operating_hours,
      organization_social_media,
      // YouTube videos
      youtube_videos,
      // Organization locations
      organization_locations,
      // Organization heads
      organization_heads,
      medicalProfessional,
    } = req.body;

    // Prepare the update object with only provided fields
    const updateData = {};
    if (organization_name) updateData.organization_name = organization_name;
    if (organization_employees)
      updateData.organization_employees = organization_employees;
    if (organization_email) updateData.organization_email = organization_email;
    if (organization_phone) updateData.organization_phone = organization_phone;

    // Address fields
    const addressUpdates = {};
    if (organization_address_street)
      addressUpdates.street = organization_address_street;
    if (organization_address_city)
      addressUpdates.city = organization_address_city;
    if (organization_address_state)
      addressUpdates.state = organization_address_state;
    if (organization_address_zip) addressUpdates.zip = organization_address_zip;
    if (organization_address_country)
      addressUpdates.country = organization_address_country;

    // If any address fields are provided, update the entire address object
    if (Object.keys(addressUpdates).length > 0) {
      updateData.organization_address = addressUpdates;
    }

    // Additional fields
    if (organization_website)
      updateData.organization_website = organization_website;
    if (organization_description)
      updateData.organization_description = organization_description;
    if (organization_tax_id)
      updateData.organization_tax_id = organization_tax_id;
    if (organization_founded_year)
      updateData.organization_founded_year = organization_founded_year;
    if (organization_industry)
      updateData.organization_industry = organization_industry;
    if (organization_size) updateData.organization_size = organization_size;
    if (organization_timezone)
      updateData.organization_timezone = organization_timezone;
    if (organization_operating_hours)
      updateData.organization_operating_hours = organization_operating_hours;
    if (organization_social_media)
      updateData.organization_social_media = organization_social_media;

    // Validate and add YouTube videos if provided
    if (youtube_videos !== undefined) {
      if (!Array.isArray(youtube_videos)) {
        return res.status(400).json({
          msg: "youtube_videos must be an array",
        });
      }

      // Validate each video entry
      for (const video of youtube_videos) {
        if (!video.id || !video.title || !video.url || !video.description) {
          return res.status(400).json({
            msg: "Invalid YouTube video format. Each video must have id, title, url, and description",
          });
        }
      }

      updateData.youtube_videos = youtube_videos;
    }

    // Validate and add organization locations if provided
    if (organization_locations !== undefined) {
      if (!Array.isArray(organization_locations)) {
        return res.status(400).json({
          msg: "organization_locations must be an array",
        });
      }

      // Add timestamps to locations and clean up data
      const locationsWithTimestamps = organization_locations.map(
        (location) => ({
          // Preserve existing _id if present
          ...(location._id && { _id: location._id }),

          id: location.id,
          name: location.name ? location.name.toString().trim() : "",
          locationId: location.locationId
            ? location.locationId.toString().trim()
            : "",
          street: location.street ? location.street.toString().trim() : "",
          city: location.city ? location.city.toString().trim() : "",
          state: location.state ? location.state.toString().trim() : "",
          pincode: location.pincode ? location.pincode.toString().trim() : "",
          country: location.country ? location.country.toString().trim() : "",
          ...(location.addressLink &&
            location.addressLink.toString().trim() && {
              addressLink: location.addressLink.toString().trim(),
            }),
          createdAt: location.createdAt || new Date(),
          updatedAt: new Date(),
        }),
      );

      updateData.organization_locations = locationsWithTimestamps;
    }

    // Validate and add organization heads if provided
    if (organization_heads !== undefined) {
      if (!Array.isArray(organization_heads)) {
        return res.status(400).json({
          msg: "organization_heads must be an array",
        });
      }

      for (const head of organization_heads) {
        if (!head.name || !head.degree || !head.reg_no) {
          return res.status(400).json({
            msg: "Invalid organization head format. Each head must have name, degree, and reg_no",
          });
        }
      }

      updateData.organization_heads = organization_heads.map((head) => ({
        ...(head._id && { _id: head._id }),
        name: head.name.toString().trim(),
        degree: head.degree.toString().trim(),
        reg_no: head.reg_no.toString().trim(),
      }));
    }
    if (medicalProfessional !== undefined) {
      if (!Array.isArray(medicalProfessional)) {
        return res.status(400).json({
          msg: "medicalProfessional must be an array",
        });
      }

      for (const professional of medicalProfessional) {
        if (!professional.name) {
          return res.status(400).json({
            msg: "Invalid medical professional format. Each professional must have a name",
          });
        }
      }

      updateData.medicalProfessional = medicalProfessional.map(
        (professional) => ({
          ...(professional._id && { _id: professional._id }),
          name: professional.name.toString().trim(),
        }),
      );
    }
    // If no fields to update were provided
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        msg: "No valid fields to update were provided",
      });
    }

    // Find the organization using Mongoose
    const existingOrg = await Organization.findOne({ tenant_id });

    if (!existingOrg) {
      return res.status(404).json({
        msg: "Organization not found",
      });
    }

    // If updating email or phone, check if they're already in use by another organization
    if (organization_email || organization_phone) {
      const duplicateQuery = {
        tenant_id: { $ne: tenant_id },
        $or: [],
      };

      if (organization_email) duplicateQuery.$or.push({ organization_email });
      if (organization_phone) duplicateQuery.$or.push({ organization_phone });

      if (duplicateQuery.$or.length > 0) {
        const duplicateCheck = await Organization.findOne(duplicateQuery);

        if (duplicateCheck) {
          return res.status(400).json({
            msg: "An organization with this email or phone number already exists",
          });
        }
      }
    }

    // If updating locations, check for duplicate locationIds across all organizations
    if (organization_locations && organization_locations.length > 0) {
      const locationIds = organization_locations.map((loc) => loc.locationId);

      const duplicateLocationCheck = await Organization.findOne({
        tenant_id: { $ne: tenant_id },
        "organization_locations.locationId": { $in: locationIds },
      });

      if (duplicateLocationCheck) {
        const conflictingLocationIds = [];
        const conflictingOrg = await Organization.findOne({
          tenant_id: { $ne: tenant_id },
          "organization_locations.locationId": { $in: locationIds },
        });

        if (conflictingOrg) {
          conflictingOrg.organization_locations.forEach((loc) => {
            if (locationIds.includes(loc.locationId)) {
              conflictingLocationIds.push(loc.locationId);
            }
          });
        }

        return res.status(400).json({
          msg: `Location ID(s) already in use by another organization: ${conflictingLocationIds.join(
            ", ",
          )}`,
        });
      }
    }

    // Update the organization using Mongoose
    const result = await Organization.updateOne(
      { tenant_id },
      { $set: updateData },
    );

    // If organization name is being updated, also update it in the doctors collection
    if (organization_name) {
      const dbClient = await MongoClient.connect(mongoUrl);
      try {
        const dbName = existingOrg.database_name;
        const orgDb = dbClient.db(dbName);

        await orgDb
          .collection("doctors")
          .updateMany({ tenant_id }, { $set: { organization_name } });
      } finally {
        await dbClient.close();
      }
    }

    res.status(200).json({
      message: "Organization updated successfully",
      modifiedCount: result.modifiedCount,
      updated_fields: updateData,
    });
  } catch (error) {
    console.error("Error updating organization:", error);
    res.status(500).json({
      message: "Error updating organization",
      error: error.message,
    });
  }
};
/**
 * Create a new organization
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const createOrg = async (req, res) => {
  let dbClient;
  try {
    const {
      organization_name,
      organization_employees,
      organization_logo,
      organization_email,
      organization_phone,
      admin_email,
      admin_first_name,
      admin_last_name,
      admin_password,
      admin_phone,
      admin_qualification,
      organization_industry,
    } = req.body;

    // Validate required fields
    const requiredFields = [
      "organization_name",
      "organization_employees",
      "organization_email",
      "organization_phone",
      "admin_email",
      "admin_first_name",
      "admin_last_name",
      "admin_password",
      "organization_industry",
    ];
    const missingFields = requiredFields.filter((field) => !req.body[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        msg: "The following fields are required: " + missingFields.join(", "),
      });
    }

    // Generate a tenant ID
    const tenant_id = uuidv4();

    // Connect to MongoDB
    dbClient = await MongoClient.connect(mongoUrl);

    // Check if organization already exists using Mongoose
    const existingOrg = await Organization.findOne({
      $or: [{ organization_email }, { organization_phone }],
    });

    if (existingOrg) {
      return res.status(400).json({
        msg: "An organization with this email or phone number already exists",
      });
    }

    // Create a new database for the organization
    const dbName = `org_${tenant_id.replace(/-/g, "")}`;
    const orgDb = dbClient.db(dbName);
    await orgDb.createCollection("doctors");
    await orgDb.createCollection("patients");
    await orgDb.createCollection("therepys");
    await orgDb.createCollection("subscription");
    console.log(`Created new database and collections: ${dbName}`);

    // Hash the provided admin password (using same method as OTP verification)
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(
      admin_password + process.env.JWT_SECRET_KEY,
      saltRounds,
    );

    // Create a new organization document using Mongoose
    const newOrganization = new Organization({
      tenant_id,
      organization_name,
      organization_employees,
      organization_logo,
      organization_email,
      organization_phone,
      database_name: dbName,
      admin_email,
      organization_industry,
    });

    // Save the organization
    await newOrganization.save();

    // Create a subscription entry with 1 month free trial
    const currentDate = new Date();
    const trialEndDate = new Date(currentDate);
    trialEndDate.setMonth(currentDate.getMonth() + 1);

    const subscriptionData = {
      tenant_id,
      status: "active",
      plan: "free_trial",
      start_date: currentDate,
      end_date: trialEndDate,
      is_trial: true,
      created_at: currentDate,
      updated_at: currentDate,
    };

    await orgDb.collection("subscription").insertOne(subscriptionData);

    // Create an admin doctor entry
    const adminDoctor = {
      doctor_email: admin_email,
      doctor_first_name: admin_first_name,
      doctor_last_name: admin_last_name,
      password: hashedPassword,
      is_admin: true,
      organization_name,
      doctor_phone: admin_phone,
      tenant_id,
      status: "active",
      qualification: admin_qualification,
    };

    const adminDoctorResult = await orgDb
      .collection("doctors")
      .insertOne(adminDoctor);

    // Create a user entry
    const userDb = dbClient.db("users");
    const user = {
      email: admin_email,
      tenant_id,
      doctor_id: adminDoctorResult.insertedId,
      password: hashedPassword,
    };

    await userDb.collection("users").insertOne(user);

    res.status(201).json({
      message: "Organization and admin created successfully",
      organization: newOrganization,
      admin_doctor: {
        email: adminDoctor.doctor_email,
        first_name: adminDoctor.doctor_first_name,
        last_name: adminDoctor.doctor_last_name,
      },
    });
  } catch (error) {
    console.error("Error creating organization:", error);
    res
      .status(500)
      .json({ message: "Error creating organization", error: error.message });
  } finally {
    if (dbClient) {
      await dbClient.close();
    }
  }
};
module.exports = { createOrg, getOrg, updateOrg, getOrgLocations };
