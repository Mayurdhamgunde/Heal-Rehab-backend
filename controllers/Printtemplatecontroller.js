const mongoose = require("mongoose");
const { getPrintTemplateModel } = require("../db/Printtemplateschema");
const { getDoctorModel } = require("../db/doctorschema");

const ALLOWED_USE_CASES = [
  "assessment",
  "single_assessment",
  "therapy_plan",
  "prescription",
  "consent",
  "followup_session",
  "custom",
];

const EDITABLE_FIELDS = [
  "name",
  "description",
  "department_id",
  "is_default",
  "page_setup",
  "theme",
  "sections",
  "footer",
  "status",
  "design_mode",
  "custom_html",
  "custom_css",
];

const CONTENT_FIELDS = [
  "sections",
  "page_setup",
  "theme",
  "footer",
  "custom_html",
  "custom_css",
  "design_mode",
];

const loadRequestingDoctor = async (req) => {
  const Doctor = getDoctorModel(req.orgDb);
  return Doctor.findOne({ doctor_email: req.user.email })
    .select("doctor_first_name doctor_last_name is_admin")
    .lean();
};

const canManage = (doctor, template) =>
  !!doctor?.is_admin ||
  (template.created_by &&
    template.created_by.toString() === doctor._id.toString());

const clearSiblingDefaults = async (
  PrintTemplate,
  { use_case, department_id, excludeId },
) => {
  const filter = { use_case, is_default: true };
  filter.department_id = department_id || { $exists: false };
  if (excludeId) filter._id = { $ne: excludeId };
  await PrintTemplate.updateMany(filter, { $set: { is_default: false } });
};

const createPrintTemplate = async (req, res) => {
  try {
    const {
      name,
      description,
      use_case,
      department_id,
      is_default,
      page_setup,
      theme,
      sections,
      footer,
      status,
      design_mode,
      custom_html,
      custom_css,
    } = req.body;

    if (!name || !use_case) {
      return res.status(400).json({ msg: "name and use_case are required." });
    }
    if (!ALLOWED_USE_CASES.includes(use_case)) {
      return res.status(400).json({ msg: "Invalid use_case." });
    }

    if (
      design_mode === "builder" &&
      (!Array.isArray(sections) || sections.length === 0)
    ) {
      return res
        .status(400)
        .json({ msg: "sections must be a non-empty array in builder mode." });
    }
    if (department_id && !mongoose.Types.ObjectId.isValid(department_id)) {
      return res.status(400).json({ msg: "Invalid department_id format." });
    }

    const PrintTemplate = getPrintTemplateModel(req.orgDb);
    const doctor = await loadRequestingDoctor(req);

    if (!doctor) {
      return res
        .status(404)
        .json({ msg: "Doctor profile not found for the current user." });
    }

    if (is_default) {
      await clearSiblingDefaults(PrintTemplate, { use_case, department_id });
    }

    const newTemplate = new PrintTemplate({
      name,
      description: description || "",
      use_case,
      department_id: department_id || undefined,
      is_default: !!is_default,
      design_mode: design_mode || "builder",
      custom_html: custom_html || "",
      custom_css: custom_css || "",
      page_setup: page_setup || undefined,
      theme: theme || undefined,
      sections: sections || [],
      footer: footer || undefined,
      status: status || "Draft",
      created_by: doctor._id,
    });

    const saved = await newTemplate.save();

    return res.status(201).json({
      message: "Print template created successfully",
      template: saved,
    });
  } catch (error) {
    console.error("Error creating print template:", error);
    return res.status(500).json({
      message: "Error creating print template",
      error: error.message,
    });
  }
};

const getAllPrintTemplates = async (req, res) => {
  try {
    const { use_case, department_id, status } = req.query;

    const PrintTemplate = getPrintTemplateModel(req.orgDb);
    getDoctorModel(req.orgDb);

    const query = {};
    if (use_case) {
      if (!ALLOWED_USE_CASES.includes(use_case)) {
        return res.status(400).json({ error: "Invalid use_case filter" });
      }
      query.use_case = use_case;
    }
    if (department_id) {
      if (!mongoose.Types.ObjectId.isValid(department_id)) {
        return res.status(400).json({ error: "Invalid department_id format" });
      }
      query.department_id = department_id;
    }
    if (status) query.status = status;

    const templates = await PrintTemplate.find(query)
      .populate("created_by", "doctor_first_name doctor_last_name")
      .sort({ use_case: 1, is_default: -1, updatedAt: -1 })
      .lean();

    return res.status(200).json({ templates });
  } catch (error) {
    console.error("Error retrieving print templates:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const getPrintTemplateById = async (req, res) => {
  try {
    const { templateId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return res.status(400).json({ error: "Invalid template ID format" });
    }

    const PrintTemplate = getPrintTemplateModel(req.orgDb);
    getDoctorModel(req.orgDb);

    const template = await PrintTemplate.findById(templateId)
      .populate("created_by", "doctor_first_name doctor_last_name")
      .lean();

    if (!template) {
      return res.status(404).json({ error: "Print template not found" });
    }

    return res.status(200).json({ template });
  } catch (error) {
    console.error("Error retrieving print template:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const updatePrintTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return res.status(400).json({ error: "Invalid template ID format" });
    }

    const PrintTemplate = getPrintTemplateModel(req.orgDb);

    const existingTemplate = await PrintTemplate.findById(
      templateId,
      "created_by use_case department_id version",
    ).lean();

    if (!existingTemplate) {
      return res.status(404).json({ msg: "Print template not found" });
    }

    const doctor = await loadRequestingDoctor(req);
    if (!doctor) {
      return res
        .status(404)
        .json({ msg: "Doctor profile not found for the current user." });
    }
    if (!canManage(doctor, existingTemplate)) {
      return res
        .status(403)
        .json({ msg: "You are not authorized to update this print template" });
    }

    if (req.body.use_case && !ALLOWED_USE_CASES.includes(req.body.use_case)) {
      return res.status(400).json({ msg: "Invalid use_case." });
    }

    if (
      req.body.design_mode === "builder" &&
      req.body.sections !== undefined &&
      (!Array.isArray(req.body.sections) || req.body.sections.length === 0)
    ) {
      return res
        .status(400)
        .json({ msg: "sections must be a non-empty array in builder mode." });
    }

    const updateData = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) updateData[field] = req.body[field];
    }

    const contentChanged = CONTENT_FIELDS.some(
      (field) => updateData[field] !== undefined,
    );
    if (contentChanged) {
      updateData.version = (existingTemplate.version || 1) + 1;
    }

    if (updateData.is_default === true) {
      const useCase = updateData.use_case || existingTemplate.use_case;
      const departmentId =
        updateData.department_id !== undefined
          ? updateData.department_id
          : existingTemplate.department_id;
      await clearSiblingDefaults(PrintTemplate, {
        use_case: useCase,
        department_id: departmentId,
        excludeId: templateId,
      });
    }

    const updatedTemplate = await PrintTemplate.findByIdAndUpdate(
      templateId,
      { $set: updateData },
      { new: true, runValidators: true },
    );

    return res.status(200).json({
      msg: "Print template updated successfully",
      template: updatedTemplate,
    });
  } catch (error) {
    console.error("Error updating print template:", error);
    return res.status(500).json({ msg: "Internal server error" });
  }
};

const deletePrintTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return res.status(400).json({ error: "Invalid template ID format" });
    }

    const PrintTemplate = getPrintTemplateModel(req.orgDb);
    const existingTemplate = await PrintTemplate.findById(templateId).lean();

    if (!existingTemplate) {
      return res.status(404).json({ error: "Print template not found" });
    }

    const doctor = await loadRequestingDoctor(req);
    if (!canManage(doctor, existingTemplate)) {
      return res
        .status(403)
        .json({ msg: "You are not authorized to delete this print template" });
    }

    await PrintTemplate.findByIdAndDelete(templateId);
    return res.status(200).json({ msg: "Print template deleted successfully" });
  } catch (error) {
    console.error("Error deleting print template:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = {
  createPrintTemplate,
  getAllPrintTemplates,
  getPrintTemplateById,
  updatePrintTemplate,
  deletePrintTemplate,
};
