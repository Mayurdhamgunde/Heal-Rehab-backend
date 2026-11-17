const { getPartnerModel } = require("../db/partnerSchema"); // Adjust path as needed

// 1. CREATE PARTNER
const createPartner = async (req, res) => {
  try {
    const {
      partner_name,
      phone_number,
      email,
      gstin,
      gst_type,
      billing_address,
      shipping_address,
      is_shipping_same_as_billing,
      notes,
    } = req.body;

    // Validate required fields
    const requiredFields = ["partner_name"];
    const missingFields = requiredFields.filter((field) => !req.body[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        msg: "The following fields are required: " + missingFields.join(", "),
      });
    }

    // Get the Partner model for this organization's DB connection
    const Partner = getPartnerModel(req.orgDb);

    // Check for duplicate GSTIN (if provided)
    if (gstin) {
      const existingPartner = await Partner.findOne({ gstin });
      if (existingPartner) {
        return res.status(400).json({
          msg: `A partner with GSTIN ${gstin} already exists.`,
        });
      }
    }

    // Create new partner instance
    const newPartner = new Partner({
      partner_name,
      phone_number,
      email,
      gstin,
      gst_type,
      billing_address,
      shipping_address,
      is_shipping_same_as_billing,
      notes,
    });

    // Save the partner document
    const savedPartner = await newPartner.save();

    res.status(201).json({
      message: "Partner created successfully",
      partner: savedPartner,
    });
  } catch (error) {
    console.error("Error creating partner:", error);
    res.status(500).json({
      message: "Error creating partner",
      error: error.message,
    });
  }
};

// 2. GET PARTNER BY ID
const getPartnerById = async (req, res) => {
  try {
    const { id } = req.params;

    const Partner = getPartnerModel(req.orgDb);
    const partner = await Partner.findById(id);

    if (!partner) {
      return res.status(404).json({ message: "Partner not found" });
    }

    res.status(200).json(partner);
  } catch (error) {
    console.error("Error fetching partner:", error);
    res.status(500).json({
      message: "Error fetching partner details",
      error: error.message,
    });
  }
};

// 3. SEARCH PARTNERS (List with filters)
const searchPartners = async (req, res) => {
  try {
    const { search, page = 1, limit = 10 } = req.query;
    const Partner = getPartnerModel(req.orgDb);

    // Build Query
    let query = {};

    // If search term is provided, check Name, Phone, or GSTIN
    if (search) {
      query = {
        $or: [
          { partner_name: { $regex: search, $options: "i" } }, // Fuzzy name search
          { phone_number: { $regex: search, $options: "i" } },
          { gstin: { $regex: search, $options: "i" } },
        ],
      };
    }

    // Execute Query with Pagination
    const partners = await Partner.find(query)
      .sort({ createdAt: -1 }) // Newest first
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Partner.countDocuments(query);

    res.status(200).json({
      partners,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error searching partners:", error);
    res.status(500).json({
      message: "Error searching partners",
      error: error.message,
    });
  }
};

module.exports = {
  createPartner,
  getPartnerById,
  searchPartners,
};
