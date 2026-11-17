const { getDrugModel } = require("../db/drugSchema"); // Adjust path as needed

// 1. CREATE DRUG
const createDrug = async (req, res) => {
  try {
    const { drug_name, generic_name, drug_type, strength, meal_timing } =
      req.body;
    console.log(req.body);
    // Validate required fields based on schema
    const requiredFields = ["drug_name", "drug_type"];
    const missingFields = requiredFields.filter((field) => !req.body[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        msg: "The following fields are required: " + missingFields.join(", "),
      });
    }

    // Get the Drug model for this organization's DB connection
    const Drug = getDrugModel(req.orgDb);

    // Optional: Check for duplicate drug name (if strictly required to be unique)
    const existingDrug = await Drug.findOne({
      drug_name: { $regex: new RegExp(`^${drug_name}$`, "i") }, // Case-insensitive exact match
    });

    if (existingDrug) {
      return res.status(400).json({
        msg: `A drug with the name "${drug_name}" already exists.`,
      });
    }

    // Create new drug instance
    const newDrug = new Drug({
      drug_name,
      generic_name,
      drug_type,
      strength,
      meal_timing: meal_timing || "After Lunch", // Default fallback just in case
    });

    // Save the drug document
    const savedDrug = await newDrug.save();

    res.status(201).json({
      message: "Drug created successfully",
      drug: savedDrug,
    });
  } catch (error) {
    console.error("Error creating drug:", error);
    res.status(500).json({
      message: "Error creating drug",
      error: error.message,
    });
  }
};

// 2. GET DRUG BY ID
const getDrugById = async (req, res) => {
  try {
    const { id } = req.params;

    const Drug = getDrugModel(req.orgDb);
    const drug = await Drug.findById(id);

    if (!drug) {
      return res.status(404).json({ message: "Drug not found" });
    }

    res.status(200).json(drug);
  } catch (error) {
    console.error("Error fetching drug:", error);
    res.status(500).json({
      message: "Error fetching drug details",
      error: error.message,
    });
  }
};

// 3. SEARCH DRUGS (List with filters)
const searchDrugs = async (req, res) => {
  try {
    const { search, page = 1, limit = 10, drug_type } = req.query;
    const Drug = getDrugModel(req.orgDb);

    let query = {};

    if (search) {
      const terms = search.trim().split(/\s+/); // Split "Para 500" → ["Para", "500"]

      // Every term must match somewhere across the searchable fields
      query.$and = terms.map((term) => ({
        $or: [
          { drug_name: { $regex: term, $options: "i" } },
          { generic_name: { $regex: term, $options: "i" } },
          { strength: { $regex: term, $options: "i" } },
          { drug_type: { $regex: term, $options: "i" } },
        ],
      }));
    }

    if (drug_type) {
      query.drug_type = drug_type;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [drugs, total] = await Promise.all([
      Drug.find(query)
        .sort({ drug_name: 1 }) // Alphabetical is more intuitive than created_at
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Drug.countDocuments(query),
    ]);

    res.status(200).json({
      drugs,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error searching drugs:", error);
    res
      .status(500)
      .json({ message: "Error searching drugs", error: error.message });
  }
};

// 4. UPDATE DRUG
const updateDrug = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const Drug = getDrugModel(req.orgDb);

    // Find and update
    const updatedDrug = await Drug.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updatedDrug) {
      return res.status(404).json({ message: "Drug not found" });
    }

    res.status(200).json({
      message: "Drug updated successfully",
      drug: updatedDrug,
    });
  } catch (error) {
    console.error("Error updating drug:", error);
    res.status(500).json({
      message: "Error updating drug",
      error: error.message,
    });
  }
};

// 5. DELETE DRUG
const deleteDrug = async (req, res) => {
  try {
    const { id } = req.params;
    const Drug = getDrugModel(req.orgDb);

    const deletedDrug = await Drug.findByIdAndDelete(id);

    if (!deletedDrug) {
      return res.status(404).json({ message: "Drug not found" });
    }

    res.status(200).json({
      message: "Drug deleted successfully",
      id: deletedDrug._id,
    });
  } catch (error) {
    console.error("Error deleting drug:", error);
    res.status(500).json({
      message: "Error deleting drug",
      error: error.message,
    });
  }
};

module.exports = {
  createDrug,
  getDrugById,
  searchDrugs,
  updateDrug,
  deleteDrug,
};
