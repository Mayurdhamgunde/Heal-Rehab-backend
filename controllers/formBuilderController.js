const mongoose = require("mongoose");
const { getFormTemplateModel } = require("../db/formBuilderSchema");
const { getDoctorModel } = require("../db/doctorschema");

// 1. Create a new Form/Assessment Template
const createFormTemplate = async (req, res) => {
  try {
    const { assessmentName, department_id, questions, status } = req.body;

    if (!assessmentName || !questions || !Array.isArray(questions)) {
      return res.status(400).json({ msg: "assessmentName and questions are required." });
    }

    const FormTemplate = getFormTemplateModel(req.orgDb);
    const Doctor = getDoctorModel(req.orgDb);
    const doctor = await Doctor.findOne({ doctor_email: req.user.email }).lean();

    // ISOLATE BY DEPARTMENT
    const targetDept = department_id || null; 

    // --- DEPARTMENT-SCOPED SEQUENCE LOGIC ---
    if (req.body.sequence !== undefined && req.body.sequence !== null) {
      // Shift templates down ONLY in the same department
      await FormTemplate.updateMany(
        { 
          department_id: targetDept, 
          sequence: { $gte: req.body.sequence },
          status: { $ne: "Archived" }
        },
        { $inc: { sequence: 1 } }
      );
    } else {
      // Find the max sequence ONLY in the same department
      const maxTemplate = await FormTemplate.findOne({ 
        department_id: targetDept, 
        status: { $ne: "Archived" } 
      }).sort({ sequence: -1 });
      req.body.sequence = maxTemplate && maxTemplate.sequence ? maxTemplate.sequence + 1 : 1;
    }

    const newTemplate = new FormTemplate({
      assessmentName,
      department_id: targetDept,
      sequence: req.body.sequence,
      questions,
      status: status || "Published",
      created_by: doctor ? doctor._id : null,
    });

    const savedTemplate = await newTemplate.save();
    res.status(201).json({ message: "Assessment created successfully", template: savedTemplate });
  } catch (error) {
    console.error("Error creating form template:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// 2. Get all Form Templates
const getAllFormTemplates = async (req, res) => {
  try {
    const FormTemplate = getFormTemplateModel(req.orgDb);
    const templates = await FormTemplate.find({ status: { $ne: "Archived" } })
      .sort({ department_id: 1, sequence: 1, createdAt: -1 }) // Sort by dept first, then sequence
      .lean();
    return res.status(200).json({ templates });
  } catch (error) {
    console.error("Error retrieving templates:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// 3. Get a single Form Template
const getFormTemplateById = async (req, res) => {
  try {
    const { templateId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(templateId)) return res.status(400).json({ error: "Invalid ID" });

    const FormTemplate = getFormTemplateModel(req.orgDb);
    const template = await FormTemplate.findById(templateId).lean();

    if (!template) return res.status(404).json({ error: "Template not found" });
    return res.status(200).json({ template });
  } catch (error) {
    console.error("Error fetching template:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// 4. Update an existing Form Template
const updateFormTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;
    const { assessmentName, department_id, questions, status, sequence } = req.body;

    if (!mongoose.Types.ObjectId.isValid(templateId)) return res.status(400).json({ error: "Invalid ID" });

    const FormTemplate = getFormTemplateModel(req.orgDb);
    const oldTemplate = await FormTemplate.findById(templateId);
    if (!oldTemplate) return res.status(404).json({ msg: "Template not found" });

    const oldDept = oldTemplate.department_id ? oldTemplate.department_id.toString() : null;
    const newDept = department_id !== undefined ? (department_id || null) : oldDept;

    // --- DEPARTMENT-SCOPED AUTO-SHIFT LOGIC ---
    if ((sequence !== undefined && oldTemplate.sequence !== sequence) || oldDept !== newDept) {
      const oldSeq = oldTemplate.sequence !== null ? oldTemplate.sequence : null;
      const newSeq = sequence !== undefined ? sequence : oldSeq;

      if (oldDept !== newDept) {
        // Form changed departments! Fix the old department gap, make room in new department.
        if (oldSeq !== null) {
          await FormTemplate.updateMany(
            { department_id: oldDept, sequence: { $gt: oldSeq }, status: { $ne: "Archived" } },
            { $inc: { sequence: -1 } }
          );
        }
        if (newSeq !== null) {
          await FormTemplate.updateMany(
            { department_id: newDept, sequence: { $gte: newSeq }, status: { $ne: "Archived" } },
            { $inc: { sequence: 1 } }
          );
        }
      } else if (oldSeq !== newSeq) {
        // Department is the same, but the sequence number changed
        if (oldSeq !== null && newSeq === null) {
          await FormTemplate.updateMany(
            { department_id: oldDept, sequence: { $gt: oldSeq }, status: { $ne: "Archived" } },
            { $inc: { sequence: -1 } }
          );
        } else if (oldSeq === null && newSeq !== null) {
          await FormTemplate.updateMany(
            { department_id: oldDept, sequence: { $gte: newSeq }, status: { $ne: "Archived" } },
            { $inc: { sequence: 1 } }
          );
        } else if (oldSeq !== null && newSeq !== null) {
          if (newSeq < oldSeq) {
            await FormTemplate.updateMany(
              { department_id: oldDept, sequence: { $gte: newSeq, $lt: oldSeq }, status: { $ne: "Archived" } },
              { $inc: { sequence: 1 } }
            );
          } else if (newSeq > oldSeq) {
            await FormTemplate.updateMany(
              { department_id: oldDept, sequence: { $gt: oldSeq, $lte: newSeq }, status: { $ne: "Archived" } },
              { $inc: { sequence: -1 } }
            );
          }
        }
      }
    }

    const updateFields = {};
    if (assessmentName != null) updateFields.assessmentName = assessmentName;
    if (questions != null) updateFields.questions = questions;
    if (status != null) updateFields.status = status;
    if (department_id !== undefined) updateFields.department_id = department_id;
    if (sequence !== undefined) updateFields.sequence = sequence; // Saves null properly now

    const updatedTemplate = await FormTemplate.findByIdAndUpdate(
      templateId,
      { $set: updateFields },
      { new: true }
    ).lean();

    return res.status(200).json({ msg: "Updated successfully", template: updatedTemplate });
  } catch (error) {
    console.error("Error updating template:", error);
    return res.status(500).json({ msg: "Internal server error" });
  }
};

// 5. Delete / Archive
const deleteFormTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(templateId)) return res.status(400).json({ error: "Invalid ID" });

    const FormTemplate = getFormTemplateModel(req.orgDb);
    const archivedTemplate = await FormTemplate.findByIdAndUpdate(
      templateId,
      { $set: { status: "Archived" } },
      { new: true }
    );

    if (!archivedTemplate) return res.status(404).json({ error: "Template not found" });

    // Close the numbering gap in the specific department
    if (archivedTemplate.sequence) {
      await FormTemplate.updateMany(
        { 
          department_id: archivedTemplate.department_id || null, 
          sequence: { $gt: archivedTemplate.sequence }, 
          status: { $ne: "Archived" } 
        },
        { $inc: { sequence: -1 } }
      );
    }

    return res.status(200).json({ msg: "Archived successfully", deletedId: templateId });
  } catch (error) {
    console.error("Error archiving template:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// 6. Bulk Reorder
const reorderFormTemplates = async (req, res) => {
  try {
    const { orderedIds } = req.body;
    if (!orderedIds || !Array.isArray(orderedIds)) return res.status(400).json({ error: "Array required." });

    const FormTemplate = getFormTemplateModel(req.orgDb);
    const bulkOps = orderedIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { sequence: index + 1 } },
      },
    }));

    if (bulkOps.length > 0) await FormTemplate.bulkWrite(bulkOps);
    return res.status(200).json({ msg: "Sequence updated successfully" });
  } catch (error) {
    console.error("Error reordering:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = {
  createFormTemplate,
  getAllFormTemplates,
  getFormTemplateById,
  updateFormTemplate,
  deleteFormTemplate,
  reorderFormTemplates, 
};