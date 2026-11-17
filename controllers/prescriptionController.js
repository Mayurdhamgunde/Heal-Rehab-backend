// controllers/prescriptionTemplateController.js
const mongoose = require("mongoose");
const {
  getPrescriptionTemplateModel,
} = require("../db/prescriptionTemplateSchema");

// CREATE: Save a new prescription template for the organization
const createTemplate = async (req, res) => {
  try {
    const { user, orgDb, body: templateData } = req;
    const PrescriptionTemplate = getPrescriptionTemplateModel(orgDb);

    if (!templateData.template_name) {
      return res.status(400).json({ msg: "Template name is required" });
    }

    const newTemplate = new PrescriptionTemplate({
      ...templateData,
      created_by_doctor_id: user.doctor_id,
      created_by_doctor_name:
        user.doctor_name ||
        `${user.doctor_first_name} ${user.doctor_last_name}`.trim(),
    });

    const savedTemplate = await newTemplate.save();

    return res.status(201).json({
      msg: "Organization prescription template created successfully",
      template: savedTemplate,
    });
  } catch (error) {
    console.error("Error creating prescription template:", error);
    if (error.code === 11000) {
      return res.status(409).json({
        msg: "A template with this name already exists in the organization.",
      });
    }
    return res
      .status(500)
      .json({ msg: "Internal server error", error: error.message });
  }
};

// READ: Get ALL templates for the organization
const getTemplates = async (req, res) => {
  try {
    const { orgDb } = req;
    const PrescriptionTemplate = getPrescriptionTemplateModel(orgDb);

    // No longer filtering by doctor_id so everyone in the org can see them
    const templates = await PrescriptionTemplate.find({})
      .sort({ created_at: -1 })
      .lean();

    return res.status(200).json({
      msg: "Organization templates fetched successfully",
      templates,
    });
  } catch (error) {
    console.error("Error fetching templates:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", error: error.message });
  }
};

// READ: Get a specific template by ID
const getTemplateById = async (req, res) => {
  try {
    const { id } = req.params;
    const { orgDb } = req;
    const PrescriptionTemplate = getPrescriptionTemplateModel(orgDb);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ msg: "Invalid Template ID format" });
    }

    const template = await PrescriptionTemplate.findById(id).lean();

    if (!template) {
      return res.status(404).json({ msg: "Prescription template not found" });
    }

    return res.status(200).json({
      msg: "Template fetched successfully",
      template,
    });
  } catch (error) {
    console.error("Error fetching template by ID:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", error: error.message });
  }
};

// UPDATE: Update an existing organization template
const updateTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const { orgDb, body: updateData } = req;
    const PrescriptionTemplate = getPrescriptionTemplateModel(orgDb);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ msg: "Invalid Template ID format" });
    }

    // Optional: Protect audit fields from being overwritten during an update
    delete updateData.created_by_doctor_id;
    delete updateData.created_by_doctor_name;

    const updatedTemplate = await PrescriptionTemplate.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true },
    );

    if (!updatedTemplate) {
      return res.status(404).json({ msg: "Prescription template not found" });
    }

    return res.status(200).json({
      msg: "Organization prescription template updated successfully",
      template: updatedTemplate,
    });
  } catch (error) {
    console.error("Error updating template:", error);
    if (error.code === 11000) {
      return res.status(409).json({
        msg: "A template with this name already exists in the organization.",
      });
    }
    return res
      .status(500)
      .json({ msg: "Internal server error", error: error.message });
  }
};

// DELETE: Remove a prescription template
const deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const { orgDb } = req;
    const PrescriptionTemplate = getPrescriptionTemplateModel(orgDb);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ msg: "Invalid Template ID format" });
    }

    const deletedTemplate = await PrescriptionTemplate.findByIdAndDelete(id);

    if (!deletedTemplate) {
      return res.status(404).json({ msg: "Prescription template not found" });
    }

    return res.status(200).json({
      msg: "Organization prescription template deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting template:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", error: error.message });
  }
};

module.exports = {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
};
