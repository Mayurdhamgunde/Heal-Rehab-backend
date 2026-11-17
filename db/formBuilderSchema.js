const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

// 1. Match frontend ListItem interface (For general options)
const subOptionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    value: { type: String },
  },
  { _id: false },
);

const listItemSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    value: { type: String },
    subOptions: [subOptionSchema], // Added to support Nested MCQ
  },
  { _id: false },
);

// 1.a Match frontend TableColumnDef interface (NEW - To support mixed column types)
const tableColumnDefSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    value: { type: String },
    colType: {
      type: String,
      enum: ["text", "checkbox", "reference_range"],
      default: "text",
    },
  },
  { _id: false },
);

// 2. Match frontend TableRowDef interface
const tableRowDefSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    srNo: { type: String },
    label: { type: String },
    cellType: {
      type: String,
      enum: ["text", "checkbox", "none", "rubric", "per_column"],
      default: "text",
    },
    isSubRow: { type: Boolean, default: false },
    unit: { type: String },
    cellDescriptions: [{ type: String }],
    labelEditable: { type: Boolean, default: false },
    referenceValues: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Keyed by column id, like referenceValues, but these pre-fill the
    // fillable cell for that column/row and remain editable at fill time.
    defaultValues: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

// 3. Match frontend BlankLineDef interface
const blankLineSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    text: { type: String },
    // One entry per [blank] occurrence in `text` (index-aligned). Pre-fills
    // that blank when the assessment is taken; staff can still edit it.
    defaultValues: [{ type: String }],
  },
  { _id: false },
);

// 4. Match frontend Question interface
const questionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    title: { type: String },
    description: { type: String },
    templateText: { type: String },
    blankLines: [blankLineSchema],
    showTotalScore: { type: Boolean, default: false },
    blankType: {
      type: String,
      enum: ["text", "dropdown"],
    },
    type: {
      type: String,
      enum: [
        "text",
        "radio",
        "checkbox",
        "dropdown",
        "table",
        "inline_blanks",
        "section_header",
        "nested_mcq", // Added Nested MCQ type
      ],
      required: true,
    },
    options: [listItemSchema],
    columns: [tableColumnDefSchema],
    rows: [tableRowDefSchema],
    hasRowLabels: { type: Boolean, default: true },
    printSideBySide: { type: Boolean, default: false },
    hideEmptyDashes: { type: Boolean, default: false },
    largeTablePrint: { type: Boolean, default: false },
    // Pre-fills the answer when the assessment is taken; still editable.
    // Shape depends on `type`: string for text/dropdown/radio, string[] for
    // checkbox, { selectedParent, subSelections } for nested_mcq.
    defaultValue: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

// 5. Main Form Template Schema
const formTemplateSchema = new mongoose.Schema(
  {
    assessmentName: {
      type: String,
      required: true,
      trim: true,
    },
    sequence: {
      type: Number,
      default: null,
    },
    department_id: {
      type: ObjectId,
      ref: "Department",
    },
    questions: [questionSchema],
    status: {
      type: String,
      enum: ["Draft", "Published", "Archived"],
      default: "Published",
    },
    created_by: {
      type: ObjectId,
      ref: "Doctor",
    },
  },
  {
    timestamps: true,
  },
);

formTemplateSchema.index({ assessmentName: 1 });
formTemplateSchema.index({ status: 1 });
formTemplateSchema.index({ department_id: 1 });

module.exports = {
  getFormTemplateModel: function (connection) {
    return connection.model(
      "FormTemplate",
      formTemplateSchema,
      "form_templates",
    );
  },
  formTemplateSchema,
};
