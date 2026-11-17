const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

// ---------- Conditions ----------
const printConditionSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    operator: {
      type: String,
      enum: [
        "exists",
        "not_exists",
        "truthy",
        "falsy",
        "equals",
        "not_equals",
        "in",
        "not_in",
        "gt",
        "gte",
        "lt",
        "lte",
      ],
      required: true,
    },
    value: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false },
);

const printFormatEnum = [
  "none",
  "date",
  "date_time",
  "currency",
  "uppercase",
  "list_join",
];

// ---------- Key/value grid ----------
const printKeyValueItemSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    labelSecondary: { type: String },
    binding: { type: String, required: true },
    fallback: { type: String, default: "" },
    format: { type: String, enum: printFormatEnum, default: "none" },
  },
  { _id: false },
);

// ---------- Rich text ----------
const printRichTextSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    textSecondary: { type: String },
  },
  { _id: false },
);

// ---------- Callout / Provider Notes Box ----------
const printCalloutSchema = new mongoose.Schema(
  {
    title: { type: String, default: "Provider Notes" },
    binding: { type: String, default: "assessment.general_notes" },
    text: { type: String },
    variant: {
      type: String,
      enum: ["clinical_accent", "neutral", "warning"],
      default: "clinical_accent",
    },
  },
  { _id: false },
);

// ---------- Tables ----------
const printTableColumnSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    header: { type: String, default: "" },
    headerSecondary: { type: String },
    binding: { type: String },
    width: { type: String },
    align: { type: String, enum: ["left", "center", "right"], default: "left" },
    format: { type: String, enum: printFormatEnum, default: "none" },
  },
  { _id: false },
);

const printTableCellSchema = new mongoose.Schema(
  {
    column_id: { type: String, required: true },
    binding: { type: String },
    value: { type: String },
  },
  { _id: false },
);

const printTableRowSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String },
    labelSecondary: { type: String },
    cells: [printTableCellSchema],
  },
  { _id: false },
);

const printTableSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: ["dynamic", "fixed"], required: true },
    rowsSource: { type: String },
    columns: [printTableColumnSchema],
    rows: [printTableRowSchema],
    showHeader: { type: Boolean, default: true },
  },
  { _id: false },
);

// ---------- Repeating groups ----------
const printRepeatingFieldSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String },
    binding: { type: String, required: true },
    fallback: { type: String, default: "" },
    format: { type: String, enum: printFormatEnum, default: "none" },
  },
  { _id: false },
);

const printRepeatingGroupSchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    layout: {
      type: String,
      enum: ["table", "stacked_cards"],
      default: "table",
    },
    fields: [printRepeatingFieldSchema],
  },
  { _id: false },
);

// ---------- Assessment Responses Block (Polymorphic Engine) ----------
const printAssessmentResponsesSchema = new mongoose.Schema(
  {
    source: { type: String, default: "assessment.responses" },
    allowSideBySideTables: { type: Boolean, default: true },
    maxSideBySideColumns: { type: Number, default: 2 },
    showQuestionNumbers: { type: Boolean, default: true },
    inlineSimpleAnswers: { type: Boolean, default: true },
    highlightScores: { type: Boolean, default: true },
  },
  { _id: false },
);

// ---------- Custom HTML/CSS block (mixes with dynamic modules) ----------
const printHtmlBlockSchema = new mongoose.Schema(
  {
    html: { type: String, default: "" },
    css: { type: String, default: "" },
  },
  { _id: false },
);

// ---------- Header / signature / image primitives ----------
const printHeaderBannerSchema = new mongoose.Schema(
  {
    showLogo: { type: Boolean, default: true },
    logoBinding: { type: String, default: "organization.logo" },
    titleText: { type: String, default: "" },
    titleSecondary: { type: String },
    showRegistrationRow: { type: Boolean, default: false },
    bannerStyle: {
      type: String,
      enum: ["standard", "clinical_boxed"],
      default: "clinical_boxed",
    },
  },
  { _id: false },
);

const printSignatureBlockSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    labelSecondary: { type: String },
    dateBinding: { type: String },
    clinicianBinding: { type: String, default: "assessment.doctor" },
    showOrgSeal: { type: Boolean, default: false },
  },
  { _id: false },
);

const printImageSchema = new mongoose.Schema(
  {
    binding: { type: String, required: true },
    width: { type: String, default: "auto" },
    height: { type: String, default: "auto" },
    fallbackText: { type: String, default: "" },
  },
  { _id: false },
);

// ---------- Section Schema ----------
const printSectionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: [
        "header_banner",
        "key_value_grid",
        "rich_text",
        "callout_box", // <-- Add this
        "data_table",
        "repeating_group",
        "assessment_responses", // <-- Add this
        "html_block",
        "signature_block",
        "image",
        "divider",
        "page_break",
      ],
      required: true,
    },
    title: { type: String },
    customClass: { type: String, default: "" }, // <-- Add this
    visibleWhen: [printConditionSchema],

    headerBanner: printHeaderBannerSchema,
    keyValueItems: [printKeyValueItemSchema],
    richText: printRichTextSchema,
    callout: printCalloutSchema, // <-- Add this
    table: printTableSchema,
    repeatingGroup: printRepeatingGroupSchema,
    assessmentResponses: printAssessmentResponsesSchema, // <-- Add this
    htmlBlock: printHtmlBlockSchema,
    signature: printSignatureBlockSchema,
    image: printImageSchema,

    style: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

// ---------- Top-level template ----------
const printTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    use_case: {
      type: String,
      enum: [
        "assessment",
        "single_assessment",
        "therapy_plan",
        "prescription",
        "consent",
        "followup_session",
        "custom",
      ],
      required: true,
    },

    department_id: { type: ObjectId, ref: "Department" },
    is_default: { type: Boolean, default: false },
    design_mode: {
      type: String,
      enum: ["builder", "html"],
      default: "builder",
    },

    custom_html: { type: String, default: "" },
    custom_css: { type: String, default: "" },

    page_setup: {
      size: { type: String, enum: ["A4", "A5", "Letter"], default: "A4" },
      orientation: {
        type: String,
        enum: ["portrait", "landscape"],
        default: "portrait",
      },
      margin: { type: String, default: "12mm 14mm" },
    },

    theme: {
      primary_color: { type: String, default: "#007b8e" },
      text_color: { type: String, default: "#0f172a" },
      muted_color: { type: String, default: "#64748b" },
      border_color: { type: String, default: "#cbd5e1" },
      font_family: { type: String, default: "Cambria, serif" },
    },

    sections: { type: [printSectionSchema], default: [] },

    footer: {
      text: { type: String, default: "" },
      textSecondary: { type: String },
      showPageNumbers: { type: Boolean, default: true },
    },

    status: {
      type: String,
      enum: ["Draft", "Published", "Archived"],
      default: "Draft",
    },
    version: { type: Number, default: 1 },
    created_by: { type: ObjectId, ref: "Doctor" },
  },
  { timestamps: true },
);

printTemplateSchema.index({ use_case: 1, status: 1 });
printTemplateSchema.index({ use_case: 1, is_default: 1, department_id: 1 });
printTemplateSchema.index({ department_id: 1 });

module.exports = {
  getPrintTemplateModel: function (connection) {
    return connection.model(
      "PrintTemplate",
      printTemplateSchema,
      "print_templates",
    );
  },
  printTemplateSchema,
};
