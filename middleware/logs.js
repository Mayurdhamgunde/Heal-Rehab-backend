// middleware/activityLogger.js
const { getUserActivityLogModel } = require("../db/activitylogschema");
const mongoose = require("mongoose");

// Helper function to determine action type from endpoint and method
const determineAction = (method, endpoint) => {
  const path = endpoint.toLowerCase();

  if (path.includes("/login") || path.includes("/verify/password"))
    return "LOGIN";
  if (path.includes("/logout")) return "LOGOUT";
  if (
    path.includes("/create") ||
    path.includes("/registration") ||
    path.includes("/register") ||
    (method === "POST" && !path.includes("/get") && !path.includes("/verify"))
  )
    return "CREATE";
  if (path.includes("/update") || method === "PUT" || method === "PATCH")
    return "UPDATE";
  if (path.includes("/delete") || method === "DELETE") return "DELETE";
  if (path.includes("/search")) return "SEARCH";
  if (path.includes("/upload")) return "UPLOAD";
  if (path.includes("/download") || path.includes("/pdf")) return "DOWNLOAD";
  if (path.includes("/payment") || path.includes("/razorpay")) return "PAYMENT";
  if (
    path.includes("/appointment") ||
    path.includes("/therapy/start") ||
    path.includes("/therapy/end")
  )
    return "APPOINTMENT";
  if (path.includes("/therapy") || path.includes("/therepy"))
    return "THERAPY_SESSION";
  if (path.includes("/notification")) return "NOTIFICATION";
  if (
    path.includes("/dashboard") ||
    path.includes("/report") ||
    path.includes("/chart")
  )
    return "REPORT_GENERATION";
  if (path.includes("/plan")) return "PLAN_MANAGEMENT";
  if (path.includes("/patient")) return "PATIENT_MANAGEMENT";
  if (path.includes("/doctor")) return "DOCTOR_MANAGEMENT";
  if (path.includes("/org")) return "ORGANIZATION_MANAGEMENT";
  if (path.includes("/blog")) return "BLOG_MANAGEMENT";
  if (path.includes("/subscription")) return "SUBSCRIPTION";
  if (path.includes("/whatsapp")) return "WHATSAPP_REMINDER";
  if (path.includes("/pdf")) return "PDF_GENERATION";
  if (
    path.includes("/photo") ||
    path.includes("/image") ||
    path.includes("/banner")
  )
    return "IMAGE_UPLOAD";
  if (path.includes("/consultation")) return "CONSULTATION";
  if (path.includes("/assessment")) return "ASSESSMENT";
  if (path.includes("/department")) return "DEPARTMENT";
  if (path.includes("/drug")) return "DRUG_MANAGEMENT";
  if (path.includes("/expense")) return "EXPENSE_MANAGEMENT";
  if (path.includes("/consent")) return "CONSENT_FORM";
  if (path.includes("/invoice")) return "INVOICE";
  if (path.includes("/partner")) return "PARTNER_MANAGEMENT";
  if (path.includes("/form-builder") || path.includes("/templates"))
    return "FORM_BUILDER";
  if (path.includes("/session")) return "SESSION_MANAGEMENT";
  if (method === "GET") return "VIEW";

  return "OTHER";
};

// Helper function to determine resource type from endpoint
const determineResource = (endpoint) => {
  const path = endpoint.toLowerCase();

  if (path.includes("/patient")) return "patient";
  if (path.includes("/doctor")) return "doctor";
  if (path.includes("/therapy") || path.includes("/therepy")) return "therapy";
  if (path.includes("/appointment")) return "appointment";
  if (path.includes("/plan")) return "therapy_plan";
  if (path.includes("/payment")) return "payment";
  if (path.includes("/org")) return "organization";
  if (path.includes("/blog")) return "blog";
  if (path.includes("/notification")) return "notification";
  if (path.includes("/subscription")) return "subscription";
  if (path.includes("/dashboard")) return "dashboard";
  if (path.includes("/report")) return "report";
  if (path.includes("/invoice")) return "invoice";
  if (path.includes("/assessment")) return "assessment";
  if (path.includes("/department")) return "department";
  if (path.includes("/drug")) return "drug";
  if (path.includes("/expense")) return "expense";
  if (path.includes("/consent")) return "consent_form";
  if (path.includes("/partner")) return "partner";
  if (path.includes("/form-builder") || path.includes("/templates"))
    return "form_template";
  if (path.includes("/session")) return "session";
  if (path.includes("/consultation")) return "consultation";
  return "system";
};

// Helper function to extract resource ID from endpoint and params
const extractResourceId = (endpoint, params) => {
  if (params.id) return params.id;
  if (params.patientId) return params.patientId;
  if (params.doctorId) return params.doctorId;
  if (params.planId) return params.planId;
  if (params.assessmentId) return params.assessmentId;
  if (params.departmentId) return params.departmentId;
  if (params.invoiceId) return params.invoiceId;
  if (params.consultationId) return params.consultationId;
  if (params.expenseId) return params.expenseId;
  if (params.templateId) return params.templateId;
  if (params.prescriptionId) return params.prescriptionId;
  if (params.sessionId) return params.sessionId;

  const matches = endpoint.match(/\/([a-fA-F0-9]{24})/);
  return matches ? matches[1] : null;
};

// Helper function to generate specific action messages based on actual endpoints
const generateActionMessage = (
  action,
  resource,
  method,
  endpoint,
  body,
  params,
  user,
) => {
  const path = endpoint.toLowerCase().split("?")[0]; // strip query params
  const userName = user
    ? `${user.doctor_first_name} ${user.doctor_last_name}`
    : "User";

  // ─── Authentication ───────────────────────────────────────────────────────
  if (path === "/verify/password")
    return `${userName} logged in with password verification`;
  if (path === "/sendotp") return `${userName} requested OTP for login`;
  if (path === "/otpverify") return `${userName} verified OTP`;
  if (path === "/otpverification/passwordsetup")
    return `${userName} set up password after OTP verification`;
  if (path === "/superadmin/login")
    return `${userName} logged in as super admin`;
  if (path === "/superadmin/login/otp/verification")
    return `${userName} verified OTP for super admin login`;
  if (path === "/exchange") return `${userName} exchanged authentication token`;
  if (path === "/refresh-token")
    return `${userName} refreshed authentication token`;
  if (path === "/verifytoken")
    return `${userName} verified authentication token`;
  if (path === "/exchange-liveswitch-code")
    return `${userName} exchanged LiveSwitch code`;

  // ─── Patient Registration & Management ────────────────────────────────────
  if (path === "/patient/registration")
    return `${userName} registered a new patient`;
  if (path.startsWith("/patient/update/"))
    return `${userName} updated patient information (ID: ${params.id || "unknown"})`;
  if (path.startsWith("/patient/archive/"))
    return `${userName} archived patient (ID: ${params.id || "unknown"})`;
  if (path.startsWith("/patient/unarchive/"))
    return `${userName} unarchived patient (ID: ${params.id || "unknown"})`;
  if (path === "/patient/getall") return `${userName} viewed all patients list`;
  if (path === "/patient/getallmy")
    return `${userName} viewed their assigned patients`;
  if (path === "/patient/getallmy/count")
    return `${userName} viewed their patient count`;
  if (path === "/patient/getallno")
    return `${userName} viewed total patient count`;
  if (path === "/search/patient") return `${userName} searched for patients`;
  if (path.match(/^\/patient\/[^/]+\/rehab_intake$/) && method === "POST")
    return `${userName} saved rehab intake form for patient`;
  if (path.match(/^\/patient\/[^/]+\/rehab_intake$/) && method === "GET")
    return `${userName} viewed rehab intake form for patient`;
  if (
    path.match(/^\/patients\/[^/]+\/documents\/[^/]+$/) &&
    method === "DELETE"
  )
    return `${userName} deleted patient document`;
  if (path.match(/^\/upload-document\//))
    return `${userName} uploaded document for patient`;
  if (path.match(/^\/patient\/[^/]+$/) && method === "GET")
    return `${userName} viewed patient details`;

  // ─── Patient Consultations ────────────────────────────────────────────────
  if (path.match(/^\/patient\/[^/]+\/consultations$/) && method === "POST")
    return `${userName} created consultation for patient`;
  if (path.match(/^\/.+\/consultations$/) && method === "POST")
    return `${userName} saved consultation for patient`;
  if (path.match(/^\/fetch\/consultations\//))
    return `${userName} fetched consultations for patient`;
  if (path.match(/^\/fetch\/consultation\//))
    return `${userName} viewed consultation details`;
  if (path.match(/^\/edit\/consultation\//))
    return `${userName} edited consultation`;
  if (path.match(/^\/print\/consultation\/prescription\//))
    return `${userName} printed prescription`;
  if (path.match(/^\/prescription\/pdf\//))
    return `${userName} generated PDF for consultation prescription`;
  if (path.match(/^\/prescription\/session\/pdf\//))
    return `${userName} generated PDF for session prescription`;

  // ─── Doctor Management ────────────────────────────────────────────────────
  if (path === "/doctor/create")
    return `${userName} created a new doctor profile`;
  if (path.match(/^\/doctor\/update\//))
    return `${userName} updated doctor information`;
  if (path.match(/^\/doctor\/update-photo\//))
    return `${userName} updated doctor profile photo`;
  if (path === "/doctor/photo" && method === "DELETE")
    return `${userName} deleted doctor profile photo`;
  if (path === "/getalldoctor") return `${userName} viewed all doctors list`;
  if (path === "/doctor" && method === "GET")
    return `${userName} viewed doctor information`;
  if (path.match(/^\/web\/doctor\//))
    return `${userName} viewed doctor web profile`;
  if (path.match(/^\/doctor\/[^/]+$/) && method === "GET")
    return `${userName} viewed specific doctor details`;

  // ─── Therapy Sessions ─────────────────────────────────────────────────────
  if (path === "/therepy/create")
    return `${userName} created a new therapy session`;
  if (path === "/therepy/bulk/create")
    return `${userName} created bulk therapy sessions`;
  if (path.match(/^\/therepy\/update\//))
    return `${userName} updated therapy session`;
  if (path.match(/^\/therepy\/[^/]+$/) && method === "GET")
    return `${userName} viewed therapy session details`;
  if (path.match(/^\/therapy\/delete\//))
    return `${userName} deleted therapy session`;
  if (path.match(/^\/therapy\/start\//))
    return `${userName} started therapy session`;
  if (path.match(/^\/therapy\/end\//))
    return `${userName} ended therapy session`;

  // ─── Sessions (createSession / editSession / getSessionsByPlan) ──────────
  if (path === "/create/session") return `${userName} created a new session`;
  if (path.match(/^\/edit\/session\//)) return `${userName} edited session`;
  if (path.match(/^\/all\/sessions\//))
    return `${userName} viewed all sessions for therapy plan`;
  if (path.match(/^\/get\/session\/details\//))
    return `${userName} viewed complete session details`;
  if (path.match(/^\/mark\/completed\//))
    return `${userName} marked previous appointment as completed`;
  if (path.match(/^\/update\/completed\//))
    return `${userName} updated completed session`;
  if (path.match(/^\/mark\/status\//))
    return `${userName} updated session status`;
  if (path.match(/^\/prescription\/session\/pdf\//))
    return `${userName} printed session PDF`;

  // ─── Therapy Plans ────────────────────────────────────────────────────────
  if (path.match(/^\/therapy\/plan\//))
    return `${userName} created therapy plan`;
  if (path.match(/^\/get\/plans\//))
    return `${userName} viewed therapy plans for patient`;
  if (path.match(/^\/get\/plan\//))
    return `${userName} viewed therapy plan details`;
  if (path.match(/^\/update\/plan\//))
    return `${userName} updated therapy plan`;
  if (path.match(/^\/addnote\/plan\//))
    return `${userName} added note to therapy plan`;
  if (path === "/get/active/plans")
    return `${userName} viewed active therapy plans`;
  if (path.match(/^\/plan\/therapy\//))
    return `${userName} viewed therapies in plan`;
  if (path.match(/^\/plan\/close\//)) return `${userName} closed therapy plan`;
  if (path.match(/^\/plan\/closuresummery\//))
    return `${userName} viewed plan closure summary`;
  if (path.match(/^\/delete\/therapyplan\//))
    return `${userName} deleted therapy plan`;
  if (path.match(/^\/print\/plan\//)) return `${userName} printed therapy plan`;
  if (path === "/doctor/therapy/analytics")
    return `${userName} viewed therapy closure analytics`;
  if (path === "/doctor/therapy/analytics/pdf")
    return `${userName} exported therapy closure analytics to PDF`;
  if (path === "/doctor/therapy/analytics/excel")
    return `${userName} exported therapy closure analytics to Excel`;

  // ─── Payments ─────────────────────────────────────────────────────────────
  if (path.match(/^\/put\/payment\/patient\//))
    return `${userName} recorded payment for patient`;
  if (path.match(/^\/put\/payment\//))
    return `${userName} recorded payment for session`;
  if (path.match(/^\/get\/paymentinfo\//))
    return `${userName} viewed payment information`;
  if (path.match(/^\/plans\/[^/]+\/payments\//) && method === "PUT")
    return `${userName} updated payment record`;
  if (path.match(/^\/plans\/[^/]+\/payments\//) && method === "DELETE")
    return `${userName} deleted payment record`;
  if (path === "/syncpayments")
    return `${userName} synchronized therapy plan payments`;
  if (path === "/create-razorpay-order")
    return `${userName} created Razorpay payment order`;
  if (path === "/collection/analysis")
    return `${userName} viewed payment collection analysis`;
  if (path === "/collection/export/excel")
    return `${userName} exported payment collection to Excel`;
  if (path === "/collection/export/pdf")
    return `${userName} exported payment collection to PDF`;
  if (path === "/get/payment/bytype")
    return `${userName} viewed doctor earnings by therapy type`;
  if (path === "/get/payment/comparison")
    return `${userName} viewed doctor earnings comparison`;
  if (path === "/get/payment/allbytype")
    return `${userName} viewed all doctors earnings by type`;

  // ─── Appointments ─────────────────────────────────────────────────────────
  if (path === "/appointments/getcount")
    return `${userName} viewed appointment counts`;
  if (path === "/appointments/getevents")
    return `${userName} viewed appointment events`;
  if (path === "/get/appointments")
    return `${userName} viewed appointments by date`;
  if (path === "/all/appointments")
    return `${userName} viewed today's appointments`;
  if (path === "/get/appointments/dates")
    return `${userName} viewed appointments by date range`;
  if (path === "/get/appointments/dates/web")
    return `${userName} viewed HealTrack appointments`;
  if (path === "/availability")
    return `${userName} checked doctor availability`;
  if (path === "/appointments/dashboard")
    return `${userName} accessed appointment dashboard`;
  if (path === "/appointments/chart")
    return `${userName} viewed appointment charts`;

  // ─── Organization ─────────────────────────────────────────────────────────
  if (path === "/organization/create")
    return `${userName} created organization profile`;
  if (path === "/getorg") return `${userName} viewed organization details`;
  if (path === "/update/org")
    return `${userName} updated organization information`;
  if (path === "/org/updatephoto")
    return `${userName} updated organization logo`;
  if (path === "/org/photo" && method === "DELETE")
    return `${userName} deleted organization logo`;
  if (path === "/org/updatebanner")
    return `${userName} updated organization banner`;
  if (path === "/org/banner" && method === "DELETE")
    return `${userName} deleted organization banner`;
  if (path === "/get/orglocations")
    return `${userName} viewed organization locations`;
  if (path.match(/^\/assign\/location\//))
    return `${userName} assigned doctor to location`;
  if (path.match(/^\/add\/schedule\//))
    return `${userName} updated doctor location schedule`;

  // ─── Blogs ────────────────────────────────────────────────────────────────
  if (path === "/create/blog") return `${userName} created a new blog post`;
  if (path === "/blogs") return `${userName} viewed all blog posts`;
  if (path === "/my/blogs") return `${userName} viewed their own blog posts`;
  if (path.match(/^\/blog\//)) return `${userName} viewed blog post details`;
  if (path.match(/^\/update\/blog\//)) return `${userName} updated blog post`;

  // ─── Dashboard & Reports ──────────────────────────────────────────────────
  if (path === "/daily/report") return `${userName} generated daily report`;
  if (path === "/monthly/leaderboard")
    return `${userName} viewed monthly leaderboard`;
  if (path === "/get/refrells")
    return `${userName} viewed monthly referral dashboard`;
  if (path === "/get/referraldetails")
    return `${userName} viewed referral details count`;
  if (path === "/get/practo")
    return `${userName} viewed Practo referrals by year`;
  if (path === "/get/socialrefrence")
    return `${userName} viewed social media pivot data`;
  if (path === "/get/typessummery")
    return `${userName} viewed therapy types summary`;
  if (path === "/get/typemonthly")
    return `${userName} viewed monthly therapy types info`;
  if (path === "/getplans/sessions")
    return `${userName} viewed active plans with sessions`;
  if (path === "/getplans/remainingpayments")
    return `${userName} viewed plans with remaining payments`;
  if (path === "/getplans/slimsessions")
    return `${userName} viewed compact active plans`;
  if (path === "/therapyplan/analysis")
    return `${userName} viewed patient therapy analysis`;

  // ─── Notifications ────────────────────────────────────────────────────────
  if (path === "/notification" && method === "GET")
    return `${userName} viewed all notifications`;
  if (path === "/notification/count")
    return `${userName} checked notification count`;
  if (path.match(/^\/notification\//) && method === "GET")
    return `${userName} viewed notification details`;

  // ─── Communication ────────────────────────────────────────────────────────
  if (path === "/send/whatsapp/reminder")
    return `${userName} sent WhatsApp reminder`;
  if (path === "/patient/convo")
    return `${userName} initiated patient conversation`;
  if (path === "/chat") return `${userName} used AI chat feature`;

  // ─── PDF & Documents ──────────────────────────────────────────────────────
  if (path.match(/^\/[^/]+\/pdf$/))
    return `${userName} generated therapy plan PDF`;
  if (path.includes("/pdf")) return `${userName} generated PDF document`;
  if (path === "/print/registration/" || path.match(/^\/print\/registration\//))
    return `${userName} printed patient registration`;

  // ─── Subscriptions ────────────────────────────────────────────────────────
  if (path === "/create/subscription")
    return `${userName} created subscription plan`;
  if (path === "/purchase/plan")
    return `${userName} purchased subscription plan`;

  // ─── Invoices ─────────────────────────────────────────────────────────────
  if (path === "/save/invoice") return `${userName} created a new invoice`;
  if (path.match(/^\/edit\/invoice\//)) return `${userName} edited invoice`;
  if (path.match(/^\/generate\/invoice\//))
    return `${userName} generated PDF for invoice`;
  if (path === "/get/invoice/series")
    return `${userName} viewed invoice series list`;
  if (path === "/create/invoice/series")
    return `${userName} created new invoice series`;
  if (path === "/get/invoices") return `${userName} viewed invoices list`;
  if (path.match(/^\/get\/invoice\//) && method === "GET")
    return `${userName} viewed invoice details`;
  if (path.match(/^\/update\/invoice\//))
    return `${userName} updated invoice status`;
  if (path.match(/^\/record\/invoice\/payment\//))
    return `${userName} recorded invoice payment`;
  if (path.match(/^\/get\/invoice\/[^/]+\/share/))
    return `${userName} shared invoice`;

  // ─── Partners ─────────────────────────────────────────────────────────────
  if (path === "/create/partner") return `${userName} created a new partner`;
  if (path === "/partners/search") return `${userName} searched for partners`;

  // ─── Drugs ────────────────────────────────────────────────────────────────
  if (path === "/drug/create") return `${userName} created a new drug entry`;
  if (path === "/search/drug") return `${userName} searched for drugs`;
  if (path.match(/^\/get\/drug\//)) return `${userName} viewed drug details`;
  if (path.match(/^\/update\/drug\//)) return `${userName} updated drug entry`;
  if (path.match(/^\/delete\/drug\//)) return `${userName} deleted drug entry`;

  // ─── Expenses ─────────────────────────────────────────────────────────────
  if (path === "/create/expense") return `${userName} recorded a new expense`;
  if (path.match(/^\/update\/expense\//))
    return `${userName} updated expense record`;
  if (path === "/all/expenses") return `${userName} viewed all expenses`;
  if (path.match(/^\/expense\//)) return `${userName} viewed expense details`;

  // ─── Consent Forms ────────────────────────────────────────────────────────
  if (path.match(/^\/patients\/[^/]+\/consent$/) && method === "POST")
    return `${userName} created consent form for patient`;
  if (path.match(/^\/consent\/signed-document\//) && method === "PUT")
    return `${userName} uploaded signed consent document for patient`;
  if (path.match(/^\/print\/consent\//))
    return `${userName} printed consent form for patient`;

  // ─── Assessments ─────────────────────────────────────────────────────────
  if (path === "/create/assessment")
    return `${userName} created a new assessment`;
  if (path === "/assessments" && method === "GET")
    return `${userName} viewed all assessments`;
  if (path.match(/^\/assessment\/[^/]+$/) && method === "GET")
    return `${userName} viewed assessment details (ID: ${params.assessmentId || "unknown"})`;
  if (path.match(/^\/assessment\/[^/]+$/) && method === "PUT")
    return `${userName} updated assessment (ID: ${params.assessmentId || "unknown"})`;
  if (path.match(/^\/assessment\/[^/]+$/) && method === "DELETE")
    return `${userName} deleted assessment (ID: ${params.assessmentId || "unknown"})`;

  // ─── Departments ──────────────────────────────────────────────────────────
  if (path === "/department/create")
    return `${userName} created a new department`;
  if (path === "/departments" && method === "GET")
    return `${userName} viewed all departments`;
  if (path.match(/^\/department\/[^/]+$/) && method === "GET")
    return `${userName} viewed department details`;
  if (path.match(/^\/department\/update\//))
    return `${userName} updated department`;
  if (path.match(/^\/department\/delete\//))
    return `${userName} deleted department`;
  if (path.match(/^\/assigning\/patient\//))
    return `${userName} assigned care team to patient`;

  // ─── Form Builder / Templates ─────────────────────────────────────────────
  if (path === "/form-builder/templates" && method === "POST")
    return `${userName} created a new form template`;
  if (path === "/form-builder/templates" && method === "GET")
    return `${userName} viewed all form templates`;
  if (path === "/templates/reorder")
    return `${userName} reordered form templates`;
  if (path.match(/^\/form-builder\/templates\/[^/]+$/) && method === "GET")
    return `${userName} viewed form template details`;
  if (path.match(/^\/form-builder\/templates\/[^/]+$/) && method === "PUT")
    return `${userName} updated form template`;
  if (path.match(/^\/form-builder\/templates\/[^/]+$/) && method === "DELETE")
    return `${userName} deleted form template`;

  // ─── Google Integration ───────────────────────────────────────────────────
  if (path === "/get/googlestatus")
    return `${userName} checked Google integration status`;

  // ─── User Logs ────────────────────────────────────────────────────────────
  if (path === "/get/user/logs") return `${userName} viewed user activity logs`;

  // ─── Generic fallback messages based on action and resource ──────────────
  const resourceName = resource.replace(/_/g, " ");
  switch (action) {
    case "CREATE":
      return `${userName} created new ${resourceName}`;
    case "UPDATE":
      return `${userName} updated ${resourceName}`;
    case "DELETE":
      return `${userName} deleted ${resourceName}`;
    case "VIEW":
      return `${userName} viewed ${resourceName}`;
    case "SEARCH":
      return `${userName} searched ${resourceName}`;
    case "UPLOAD":
      return `${userName} uploaded ${resourceName}`;
    case "DOWNLOAD":
      return `${userName} downloaded ${resourceName}`;
    case "LOGIN":
      return `${userName} logged into the system`;
    case "LOGOUT":
      return `${userName} logged out of the system`;
    case "PAYMENT":
      return `${userName} processed payment transaction`;
    case "WHATSAPP_REMINDER":
      return `${userName} sent WhatsApp reminder`;
    case "PDF_GENERATION":
      return `${userName} generated PDF document`;
    case "REPORT_GENERATION":
      return `${userName} generated report`;
    case "SUBSCRIPTION":
      return `${userName} managed subscription`;
    case "ASSESSMENT":
      return `${userName} managed assessment`;
    case "DEPARTMENT":
      return `${userName} managed department`;
    case "FORM_BUILDER":
      return `${userName} managed form template`;
    case "SESSION_MANAGEMENT":
      return `${userName} managed session`;
    default:
      return `${userName} performed ${action.toLowerCase()} on ${resourceName}`;
  }
};

// Helper function to sanitize request body (remove sensitive data)
const sanitizeRequestBody = (body) => {
  if (!body || typeof body !== "object") return body;

  const sensitiveFields = [
    "password",
    "token",
    "secret",
    "key",
    "authorization",
    "otp",
    "client_secret",
  ];
  const sanitized = { ...body };

  sensitiveFields.forEach((field) => {
    if (sanitized[field]) {
      sanitized[field] = "[REDACTED]";
    }
  });

  return sanitized;
};

const logUserActivity = async (req, res, next) => {
  const startTime = new Date();

  // Store original res.json to capture response
  const originalJson = res.json;
  let responseStatus = 200;
  let errorMessage = null;

  res.json = function (body) {
    responseStatus = res.statusCode;
    if (res.statusCode >= 400 && body) {
      // Check for common error properties in the response payload
      errorMessage = body.error || body.message || body.err || null;

      // If the body is just a plain string instead of JSON, capture it
      if (!errorMessage && typeof body === "string") {
        errorMessage = body;
      }
    }
    return originalJson.call(this, body);
  };

  // Continue with the request
  res.on("finish", async () => {
    try {
      const endTime = new Date();
      const responseTime = endTime - startTime;

      // Only log if user is authenticated (has req.user) and orgDb is available
      if (req.user && req.orgDb) {
        try {
          // Get the tenant-specific UserActivityLog model
          const UserActivityLog = getUserActivityLogModel(req.orgDb);

          const action = determineAction(req.method, req.originalUrl);
          const resource = determineResource(req.originalUrl);
          const resourceId = extractResourceId(req.originalUrl, req.params);

          // Generate specific action message based on exact endpoint
          const actionMessage = generateActionMessage(
            action,
            resource,
            req.method,
            req.originalUrl,
            req.body,
            req.params,
            req.user,
          );

          const logEntry = {
            user_id: req.user.doctor_id || req.user.user_id,
            doctor_id: req.user.doctor_id,
            email: req.user.email,
            action: action,
            action_message: actionMessage,
            resource: resource,
            resource_id: resourceId,
            method: req.method,
            doctor_name: `${req.user.doctor_first_name} ${req.user.doctor_last_name}`,
            endpoint: req.originalUrl,
            ip_address:
              req.ip ||
              req.connection.remoteAddress ||
              req.headers["x-forwarded-for"] ||
              "unknown",
            user_agent: req.headers["user-agent"] || "unknown",
            request_body:
              req.method !== "GET" ? sanitizeRequestBody(req.body) : null,
            response_status: responseStatus,
            response_time: responseTime,
            error_message: errorMessage,
            session_id: req.headers["x-session-id"] || req.sessionID || null,
            metadata: {
              organization_name: req.user.organization_name,
              is_admin: req.user.is_admin,
              subscription_plan: req.subscription?.plan || null,
              query_params: req.query || {},
              file_uploaded: req.file ? req.file.filename : null,
              files_uploaded: req.files
                ? Array.isArray(req.files)
                  ? req.files.length
                  : Object.values(req.files).flat().length
                : 0,
              tenant_id: req.user.tenant_id,
              success: responseStatus < 400,
              endpoint_matched: true,
            },
            timestamp: startTime,
          };

          // Save to tenant-specific database asynchronously (don't block response)
          setImmediate(async () => {
            try {
              await UserActivityLog.create(logEntry);
            } catch (error) {
              console.error(
                `Error saving user activity log for tenant ${req.user.tenant_id}:`,
                error,
              );
            }
          });
        } catch (modelError) {
          console.error(
            `Error getting UserActivityLog model for tenant ${req.user.tenant_id}:`,
            modelError,
          );
        }
      }
    } catch (error) {
      console.error("Error in activity logging middleware:", error);
    }
  });

  next();
};

module.exports = { logUserActivity };
