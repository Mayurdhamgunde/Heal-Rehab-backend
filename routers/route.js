const express = require("express");
const {
  createReg,
  UpdatePatient,
  AllPatients,
  getDoctorPatients,
  getDoctorPatientCount,
  exportAllPatients,
  searchPotentialPreviousPatients,
  linkRelapsedPatient,
  deletePatient,
} = require("../controllers/registrationController");
const {
  createFormTemplate,
  getAllFormTemplates,
  getFormTemplateById,
  updateFormTemplate,
  deleteFormTemplate,
  reorderFormTemplates,
} = require("../controllers/formBuilderController");
const {
  addMedicalReportToPlan,
  editMedicalReport,
  archiveMedicalReport,
  getPlanMedicalReports,
  addVitalsReading,
  editVitalsReading,
  getPlanVitalsHistory,
} = require("../controllers/medicalReportController");
const { call } = require("../controllers/patientcall");
const {
  getPatient,
  NumberOfPatients,
  PatientSearch,
  uploadPatientDocument,
  deletePatientDocument,
  ArchivePatient,
  UnarchivePatient,
  GetArchivedPatients,
  saveRehabIntakeForm,
  getRehabIntakeForm,
  DoctorPatientSearch,
} = require("../controllers/patientController");
const {
  createTherepy,
  getTherepy,
  getConvo,
  getUrl,
  backtrackUrl,
  createTherapyPlan,
  updateTherepy,
  deleteTherapy,
  createConsultation,
  getCompleteSessionDetails,
  createBulkTherapy,
  createSession,
  editSession,
  createGroupSession,
  addPrescriptionToPlan, // <-- Add this
  editPrescription, // <-- Add this
  endPrescription,
  getPrescriptionsByPlan,
  getSessionsByPatient,
  createAftercareSessions,
  getPatientRecoveryTrend,
  getAftercareSessionsByPatient,
  editAfterCareAppointment,
  getActivePrescriptionPrintData,
  getPrescriptionPrintDataById,
  completeMedicalPhase,
  completeCounselorPhase,
  getPrescriptionsByPatient,
  getFollowupSessionsByPatient,
  deleteSession, // <-- Add this
} = require("../controllers/therepyController");
const {
  createDoctor,
  updateDoctor,
  sendDoctor,
  getAllDoctors,
  getDoctorInfo,
  getDoctorInfoforWeb,
} = require("../controllers/doctorController");
const {
  createOrg,
  getOrg,
  updateOrg,
  getOrgLocations,
} = require("../controllers/orgController");
const { authenticateToken } = require("../middleware/authMiddle");
const verifyRazorpayPayment = require("../middleware/razorPay");
const { razorpayOrder } = require("../controllers/razorPayOrder");
const {
  getEventsCount,
  getAllEvents,
  getDoctorAvailability,
  AllappointmentsToday,
  startAppointment,
  endAppointment,
  getAllAppointmentsByDate,
  getAppointmentsByDateRange,
  getAftercareAppointmentsByDateRange,
  getHealtrackAppointments,
  uploadSessionImages,
  markPreviousAppointmentCompleted,
  updateSessionStatus,
  editCompletedSession,
  printSession,
  getUpcomingFollowUps,
  getDoctorUpcomingFollowUps,
} = require("../controllers/appointmentsController");
const {
  exchange,
  refreshToken,
  getLiveSwitchToken,
  verifyToken,
} = require("../codeexchange/refreshToken");
const {
  getPatientTherapyPlans,
  getTherapyPlan,
  editTherapyPlan,
  activeTherapyPlans,
  getPaymentInfo,
  recordPayment,
  editPayment,
  deletePayment,
  getPlanTherapies,
  addNoteInTherapy,
  syncTherapyPlanPayments,
  deleteTherapyPlan,
  closeTherapyPlan,
  recordPatientPayment,
  printTherapyPlan,
  printPatientRegistration,
  getGlobalAftercareReport,
  completedTherapyPlans,
  revertTherapyPlan,
} = require("../controllers/plansController");
const {
  sendOtp,
  OtpVerification,
  OtpVerificationandSetPassword,
  PasswordVerificationAndLogin,
  SuperAdminLogin,
  OtpVerificationSuperAdmin,
} = require("../controllers/otpontroller");
const { getLastUpdatedInfo } = require("../controllers/googleController");
const {
  upload,
  updateDoctorPhoto,
  deleteDoctorImage,
  updateOrganizationLogo,
  deleteOrganizationLogo,
  deleteOrganizationBackground,
  updateOrganizationBackgroud,
} = require("../controllers/imageupload");
const {
  getAppointmentDashboardData,
  getAppointmentChartData,
  getDailyReportDashboard,
  getMonthlyLeaderboard,
  getMonthlyReferralDashboard,
  getMonthlyReferralDetailsCount,
  countPractoReferralsByYear,
  getSocialMediaPivot,
  getDoctorTherapyTypesInfo,
  getDoctorTherapyTypesSummary,
  getActivePlansWithPaymentsAndSessions,
  getActivePlansCompactView,
  getAllPlansWithRemainingPayments,
  getPatientTherapyAnalysis,
  getPaymentCollectionAnalysis,
  exportPaymentCollectionToPDF,
  exportPaymentCollectionToExcel,
  exportTherapyClosureReportToPDF,
  exportTherapyClosureReportToExcel,
  getTherapyClosureReport,
  getDoctorAssessmentsInfo,
} = require("../controllers/admindashcontroller");
const { chat } = require("../controllers/genAi");
const { generateTherapyPlanPDF } = require("../controllers/pdfcontroller");
const {
  createBlog,
  getAllBlogs,
  getBlogById,
  updateBlog,
  blogImageUpload,
  getBlogsByDoctor,
} = require("../controllers/blogController");
const { addsubscription } = require("../controllers/subscriptionController");
const { buySubscription } = require("../controllers/SubscriptionPurchase");
const { authenticateUser } = require("../middleware/oldmiddleware");
const {
  createLectureSession,
  getLectureSessions,
  getLectureSessionById,
  updateLectureSession,
  addAbsentPatient,
  removeAbsentPatient,
  cancelLectureSession,
  deleteLectureSession,
} = require("../controllers/lectureSessionController");
const {
  notification,
  AllNotifications,
  notificationCount,
} = require("../controllers/notificationController");
const {
  requirePaymentAccess,
  createPayment,
  createRefund,
  listPayments,
  getPayment,
  updatePayment,
  voidPayment,
  getPatientPaymentSummary,
  getCollectionsReport,
  getMonthlyComparison,
} = require("../controllers/paymentController");
const {
  listPackages,
  getPackage,
  updatePackage,
  cancelPackage,
  createPackageTemplate,
  updatePackageTemplate,
  deletePackageTemplate,
  listTemplates,
  createPackage,
  listPackageTemplates,
} = require("../controllers/packageController");
const {
  sendTherapyReminderController,
} = require("../controllers/whatsappController");
const { logUserActivity } = require("../middleware/logs");
const { getUserActivityLogs } = require("../controllers/activitylogController");
const {
  saveConsultation,
  getConsultation,
  getConsultations,
  getConsultationById,
  editConsultation,
  getPrescriptionPrintData,
  printConsultation,
} = require("../controllers/bookConsultation");
const {
  saveInvoice,
  getInvoiceSeries,
  createInvoiceSeries,
  getInvoices,
  getInvoice,
  updateInvoiceStatus,
  recordInvoicePayment,
  editInvoice,
  getInvoicePrintData,
  getInvoiceShareData,
} = require("../controllers/invoiceCOntroller");
const {
  assignDoctorToLocation,
  updateDoctorLocationSchedule,
} = require("../controllers/locationController");
const {
  searchPartners,
  createPartner,
} = require("../controllers/partnerController");
const {
  createDrug,
  searchDrugs,
  getDrugById,
  updateDrug,
  deleteDrug,
} = require("../controllers/drugController");
const {
  addExpense,
  editExpense,
  getExpenses,
  getExpenseById,
  uploadExpenseBill,
} = require("../controllers/expenseController");
const {
  createConsentForm,
  uploadSignedDocument,
  printConsentForm,
} = require("../controllers/consentController");
const {
  createDepartment,
  getAllDepartments,
  getDepartment,
  updateDepartment,
  deleteDepartment,
  assignCareTeam,
  checkDepartmentPrivilege,
} = require("../controllers/departmentController");
const {
  createAssessment,
  getAllAssessments,
  getAssessmentById,
  updateAssessment,
  deleteAssessment,
  getPatientForPrint,
  getTherapyPlanForPrint,
  getSingleAssessmentForPrint,
  suggestNotesCompletion,
  getFollowupForPrint,
  getMonthlyOpdRegisterForExcel,
  getMonthlyIpdRegisterForExcel,
} = require("../controllers/assessmentController");
const {
  translateAssessmentPrint,
} = require("../controllers/translateController");
const { getPatientRelapseRisk } = require("../controllers/aiController");
const {
  getAgeDistribution,
  getNewPatientsToday,
  getDemographicBreakdown,
  getReferralSourceDistribution,
  getGeographicDistribution,
  getLocationVsHomeCityCrossTab,
  getRegistrationsByLocationOverTime,
  getPlanDropoutMetrics,
} = require("../controllers/rehabDashController");
const {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} = require("../controllers/prescriptionController");
const {
  requestPatientDocumentUploadUrl,
  confirmPatientDocumentUpload,
} = require("../controllers/patientDocUploadController");
const {
  createPrintTemplate,
  getAllPrintTemplates,
  updatePrintTemplate,
  getPrintTemplateById,
  deletePrintTemplate,
} = require("../controllers/Printtemplatecontroller");
const {
  getMyPerformanceReport,
} = require("../controllers/userProfileController");
const router = express.Router();

router.route("/exchange").post(authenticateToken, logUserActivity, exchange);

router
  .route("/patient/registration")
  .post(
    authenticateUser,
    checkDepartmentPrivilege("can_register_patients"),
    logUserActivity,
    upload.single("patient_image"),
    createReg,
  );
router.route("/patient/update/:id").post(
  authenticateUser,
  logUserActivity,
  upload.fields([
    { name: "patient_image", maxCount: 1 },
    { name: "witness_photo", maxCount: 1 },
  ]),
  UpdatePatient,
);
router
  .route("/patient/archive/:id")
  .post(authenticateUser, logUserActivity, ArchivePatient);
router
  .route("/patient/unarchive/:id")
  .post(authenticateUser, logUserActivity, UnarchivePatient);
router
  .route("/patient/archived")
  .get(authenticateUser, logUserActivity, GetArchivedPatients);
router
  .route("/patient/:patientId/rehab_intake")
  .post(authenticateToken, logUserActivity, saveRehabIntakeForm);
router
  .route("/patient/:patientId/rehab_intake")
  .get(authenticateToken, logUserActivity, getRehabIntakeForm);
router.route("/patient/getAll").get(authenticateUser, AllPatients);
router.route("/patient/getAllMy").get(authenticateUser, getDoctorPatients);
router
  .route("/patient/getAllMy/count")
  .get(authenticateUser, getDoctorPatientCount);
router.route("/patient/getAllno").get(authenticateUser, NumberOfPatients);
router.route("/patient/convo").post(call);
router
  .route("/patients/:patientId/documents/:documentId")
  .delete(authenticateToken, logUserActivity, deletePatientDocument);
router.route("/patient/:id").get(authenticateUser, getPatient);

// Consultation routes
router
  .route("/patient/:patientId/consultations")
  .post(authenticateToken, logUserActivity, createConsultation);
router
  .route("/:patientId/consultations")
  .post(authenticateToken, logUserActivity, saveConsultation);
router.route("/appointments/getcount").get(authenticateUser, getEventsCount);
router.route("/appointments/getevents").get(authenticateUser, getAllEvents);

router
  .route("/therepy/create")
  .post(authenticateToken, logUserActivity, createTherepy);
router
  .route("/therepy/bulk/create")
  .post(authenticateToken, logUserActivity, createBulkTherapy);

router.route("/therepy/Convo").get(getConvo);
router.route("/therepy/:id").get(authenticateToken, getTherepy);
router
  .route("/therepy/update/:id")
  .patch(authenticateToken, logUserActivity, updateTherepy);
router
  .route("/get/plans/:patientId")
  .get(authenticateUser, getPatientTherapyPlans);

router.route("/verifyToken").get(verifyToken);
router
  .route("/doctor/create")
  .post(authenticateToken, logUserActivity, createDoctor);
router
  .route("/doctor/update/:id")
  .put(authenticateToken, logUserActivity, updateDoctor);
router.route("/getalldoctor").get(authenticateUser, getAllDoctors);
router.route("/doctor").get(authenticateUser, sendDoctor);
router.route("/organization/create").post(createOrg);
router.route("/refresh-token").post(refreshToken);
router.route("/doctor/:id").get(authenticateUser, getDoctorInfo);
router.route("/web/doctor/:id").get(authenticateUser, getDoctorInfoforWeb);
router
  .route("/therapy/plan/:patientId")
  .post(authenticateToken, logUserActivity, createTherapyPlan);
router.route("/plan/therapy/:id").get(authenticateUser, getPlanTherapies);
router
  .route("/plan/close/:id")
  .post(authenticateToken, logUserActivity, closeTherapyPlan);
router
  .route("/plan/revert/:id")
  .post(authenticateToken, logUserActivity, revertTherapyPlan);
router
  .route("/followup/prescription/:sessionId")
  .get(authenticateToken, getFollowupForPrint);
router
  .route("/create/aftercareSessions/:patientId")
  .post(authenticateToken, logUserActivity, createAftercareSessions);

router
  .route("/doctor/therapy/analytics")
  .get(authenticateToken, getTherapyClosureReport);
router
  .route("/doctor/therapy/analytics/pdf")
  .get(authenticateToken, exportTherapyClosureReportToPDF);
router
  .route("/doctor/therapy/analytics/excel")
  .get(authenticateToken, exportTherapyClosureReportToExcel);
router.route("/search/patient").get(authenticateUser, PatientSearch);
router
  .route("/search/doctor-patient")
  .get(authenticateUser, DoctorPatientSearch);
router
  .route("/get/previous")
  .get(authenticateUser, searchPotentialPreviousPatients);
router.route("/link/previous/:id").patch(authenticateUser, linkRelapsedPatient);
router
  .route("/therapy/delete/:id")
  .delete(authenticateToken, logUserActivity, deleteTherapy);
router
  .route("/delete/therapyplan/:id")
  .post(authenticateToken, logUserActivity, deleteTherapyPlan);
router
  .route("/therapy/start/:id")
  .post(
    authenticateToken,
    logUserActivity,
    uploadSessionImages.array("images"),
    startAppointment,
  );
router
  .route("/therapy/end/:id")
  .post(
    authenticateToken,
    logUserActivity,
    uploadSessionImages.array("images"),
    endAppointment,
  );
router
  .route("/availability")
  .post(authenticateToken, logUserActivity, getDoctorAvailability);
router.route("/All/appointments").get(authenticateToken, AllappointmentsToday);
router
  .route("/get/appointments")
  .post(authenticateToken, logUserActivity, getAllAppointmentsByDate);
router.route("/exchange-liveswitch-code").post(getLiveSwitchToken);
router.route("/sendOtp").post(sendOtp);
router.route("/otpVerify").post(OtpVerification);
router
  .route("/otpVerification/passwordsetup")
  .post(OtpVerificationandSetPassword);
router.route("/verify/password").post(PasswordVerificationAndLogin);
router.route("/get/googlestatus").get(authenticateUser, getLastUpdatedInfo);
router.route("/get/plan/:id").get(authenticateUser, getTherapyPlan);
router
  .route("/update/plan/:id")
  .put(authenticateToken, logUserActivity, editTherapyPlan);
router
  .route("/addNote/plan/:id")
  .put(authenticateToken, logUserActivity, addNoteInTherapy);
router.route("/get/active/plans").get(authenticateUser, activeTherapyPlans);
router
  .route("/get/completed/plans")
  .get(authenticateUser, completedTherapyPlans);
router.route("/get/paymentinfo/:id").get(authenticateUser, getPaymentInfo);
router
  .route("/put/payment/patient/:patientId")
  .post(authenticateToken, logUserActivity, recordPatientPayment);
router
  .route("/put/payment/:id/:therapyId")
  .post(authenticateToken, logUserActivity, recordPayment);
router.route("/syncpayments").get(authenticateToken, syncTherapyPlanPayments);
router
  .route("/plans/:planId/payments/:paymentDate")
  .put(authenticateToken, logUserActivity, editPayment);
router
  .route("/plans/:planId/payments/:paymentDate")
  .delete(authenticateToken, logUserActivity, deletePayment);

router
  .route("/get/appointments/dates")
  .post(authenticateUser, getAppointmentsByDateRange);

router
  .route("/get/appointments/dates/web")
  .post(authenticateUser, getHealtrackAppointments);

router
  .route("/doctor/update-photo/:id")
  .put(
    authenticateToken,
    logUserActivity,
    upload.single("profile_photo"),
    updateDoctorPhoto,
  );
router
  .route("/doctor/photo")
  .delete(authenticateToken, logUserActivity, deleteDoctorImage);
router
  .route("/send/whatsapp/reminder")
  .post(authenticateToken, logUserActivity, sendTherapyReminderController);
router
  .route("/org/updatePhoto")
  .put(
    authenticateToken,
    logUserActivity,
    upload.single("profile_photo"),
    updateOrganizationLogo,
  );
router
  .route("/org/photo")
  .delete(authenticateToken, logUserActivity, deleteOrganizationLogo);
router
  .route("/org/updateBanner")
  .put(
    authenticateToken,
    logUserActivity,
    upload.single("profile_photo"),
    updateOrganizationBackgroud,
  );
router
  .route("/upload-document/:patientId")
  .post(
    authenticateToken,
    logUserActivity,
    upload.single("file"),
    uploadPatientDocument,
  );
router
  .route("/upload-document/url/:patientId")
  .post(authenticateToken, logUserActivity, requestPatientDocumentUploadUrl);

router
  .route("/upload-document/confirm/:patientId")
  .post(authenticateToken, logUserActivity, confirmPatientDocumentUpload);
router
  .route("/org/banner")
  .delete(authenticateToken, logUserActivity, deleteOrganizationBackground);

router
  .route("/appointments/chart")
  .get(authenticateToken, getAppointmentChartData);
router
  .route("/appointments/dashboard")
  .get(authenticateToken, getAppointmentDashboardData);
router.route("/daily/report").get(authenticateToken, getDailyReportDashboard);
router
  .route("/monthly/leaderboard")
  .get(authenticateToken, getMonthlyLeaderboard);
router
  .route("/getplans/sessions")
  .get(authenticateToken, getActivePlansWithPaymentsAndSessions);
router
  .route("/getplans/remainingpayments")
  .get(authenticateToken, getAllPlansWithRemainingPayments);
router
  .route("/collection/analysis")
  .get(authenticateToken, getPaymentCollectionAnalysis);
router
  .route("/collection/export/excel")
  .get(authenticateToken, exportPaymentCollectionToExcel);
router
  .route("/collection/export/pdf")
  .get(authenticateToken, exportPaymentCollectionToPDF);
router
  .route("/therapyplan/analysis")
  .get(authenticateToken, getPatientTherapyAnalysis);
router
  .route("/getplans/slimsessions")
  .get(authenticateToken, getActivePlansCompactView);
router
  .route("/get/refrells")
  .get(authenticateToken, getMonthlyReferralDashboard);
router
  .route("/get/referralDetails")
  .get(authenticateToken, getMonthlyReferralDetailsCount);
router.route("/get/practo").get(authenticateToken, countPractoReferralsByYear);
router.route("/get/socialrefrence").get(authenticateToken, getSocialMediaPivot);
router.route("/chat").post(chat);
router.route("/getOrg").get(authenticateToken, getOrg);
router.route("/update/org").post(authenticateToken, logUserActivity, updateOrg);
router.route("/:id/pdf").get(authenticateToken, generateTherapyPlanPDF);
router.route("/blogs").get(authenticateToken, getAllBlogs);
router.route("/my/blogs").get(authenticateToken, getBlogsByDoctor);
router.route("/get/orgLocations").get(authenticateToken, getOrgLocations);
router
  .route("/create/blog")
  .post(authenticateToken, logUserActivity, blogImageUpload, createBlog);
router.route("/blog/:id").get(authenticateToken, getBlogById);
router
  .route("/update/blog/:id")
  .put(authenticateToken, logUserActivity, blogImageUpload, updateBlog);
router
  .route("/get/typessummery")
  .get(authenticateToken, getDoctorTherapyTypesSummary);

router
  .route("/get/typemonthly")
  .get(authenticateToken, getDoctorTherapyTypesInfo);

router
  .route("/get/typemonthly/assessments")
  .get(authenticateToken, getDoctorAssessmentsInfo);

router.route("/create/subscription").post(addsubscription);

router
  .route("/purchase/plan")
  .post(
    authenticateUser,
    logUserActivity,
    verifyRazorpayPayment,
    buySubscription,
  );

//Notifications
router.route("/notification").get(authenticateUser, AllNotifications);
router.route("/notification/count").get(authenticateUser, notificationCount);
router.route("/notification/:id").get(authenticateUser, notification);
//PAyment dashboard paths

router.route("/create-razorpay-order").post(razorpayOrder);
router.route("/get/user/logs").get(authenticateToken, getUserActivityLogs);

//Invoice routes
router
  .route("/save/invoice")
  .post(authenticateToken, logUserActivity, saveInvoice);
router
  .route("/edit/invoice/:invoiceId")
  .post(authenticateToken, logUserActivity, editInvoice);
router
  .route("/generate/invoice/:invoiceId")
  .get(authenticateToken, getInvoicePrintData);
router.route("/get/invoice/series").get(authenticateToken, getInvoiceSeries);
router
  .route("/create/invoice/series")
  .post(authenticateToken, logUserActivity, createInvoiceSeries);
router.route("/get/invoices").get(authenticateToken, getInvoices);
router.route("/get/invoice/:invoiceId").get(authenticateToken, getInvoice);
router
  .route("/update/invoice/:invoiceId")
  .put(authenticateToken, logUserActivity, updateInvoiceStatus);
router
  .route("/record/invoice/payment/:invoiceId")
  .post(authenticateToken, logUserActivity, recordInvoicePayment);

//Location management routes
router
  .route("/assign/location/:doctorId")
  .post(authenticateToken, assignDoctorToLocation);
router
  .route("/mark/completed/:id")
  .post(
    authenticateToken,
    uploadSessionImages.array("images"),
    logUserActivity,
    markPreviousAppointmentCompleted,
  );
router
  .route("/get/session/details/:id")
  .get(authenticateToken, getCompleteSessionDetails);
router
  .route("/edit/aftercare/:id")
  .patch(authenticateToken, editAfterCareAppointment);

router
  .route("/update/completed/:id")
  .patch(
    authenticateToken,
    logUserActivity,
    uploadSessionImages.array("images"),
    editCompletedSession,
  );
router
  .route("/mark/status/:id")
  .patch(authenticateToken, logUserActivity, updateSessionStatus);

router
  .route("/add/schedule/:doctorId/:locationId")
  .post(authenticateToken, logUserActivity, updateDoctorLocationSchedule);
router.route("/superadmin/login").post(SuperAdminLogin);
router
  .route("/superadmin/login/otp/verification")
  .post(OtpVerificationSuperAdmin);

//Partner Api
router
  .route("/create/partner")
  .post(authenticateUser, logUserActivity, createPartner);
router.route("/partners/search").get(authenticateToken, searchPartners);

//Prescriptions routes
router
  .route("/fetch/consultations/:patientId")
  .get(authenticateToken, getConsultations);
router
  .route("/fetch/consultation/:consultationId")
  .get(authenticateToken, getConsultationById);
router
  .route("/edit/consultation/:consultationId")
  .put(authenticateToken, logUserActivity, editConsultation);
router
  .route("/print/consultation/prescription/:prescriptionId")
  .get(authenticateToken, getPrescriptionPrintData);
//Drug routes
router
  .route("/drug/create")
  .post(authenticateToken, logUserActivity, createDrug);
router.route("/search/drug").get(authenticateToken, searchDrugs);
router.route("/get/drug/:id").get(authenticateToken, getDrugById);
router
  .route("/update/drug/:id")
  .put(authenticateToken, logUserActivity, updateDrug);
router
  .route("/delete/drug/:id")
  .delete(authenticateToken, logUserActivity, deleteDrug);

//Expense Route
router
  .route("/create/expense")
  .post(
    authenticateToken,
    logUserActivity,
    uploadExpenseBill.array("images"),
    addExpense,
  );
router
  .route("/update/expense/:expenseId")
  .patch(
    authenticateToken,
    logUserActivity,
    uploadExpenseBill.array("images"),
    editExpense,
  );
router.route("/all/expenses").get(authenticateToken, getExpenses);
router.route("/expense/:expenseId").get(authenticateToken, getExpenseById);
//PDF route View
router
  .route("/prescription/pdf/:consultationId")
  .get(authenticateToken, printConsultation);
router
  .route("/prescription/session/pdf/:sessionId")
  .get(authenticateToken, printSession);
//Consent Form ROutes
router.post(
  "/patients/:patientId/consent",
  authenticateToken,
  logUserActivity,
  upload.fields([
    { name: "patient_photo", maxCount: 1 },
    { name: "witness_photo", maxCount: 1 },
  ]),
  createConsentForm,
);

// Route 2: Attach the signed document later
router.put(
  "/consent/signed-document/:patientId",
  authenticateToken,
  logUserActivity,
  upload.single("signed_document"),
  uploadSignedDocument,
);
router
  .route("/print/consent/:patientId")
  .get(authenticateToken, logUserActivity, printConsentForm);
router
  .route("/print/plan/:planId")
  .get(authenticateToken, logUserActivity, printTherapyPlan);
router
  .route("/print/registration/:patientId")
  .get(authenticateToken, printPatientRegistration);

//formBuilder
router
  .route("/form-builder/templates")
  .post(authenticateUser, logUserActivity, createFormTemplate)
  .get(authenticateUser, getAllFormTemplates);
router
  .route("/templates/reorder")
  .post(authenticateUser, logUserActivity, reorderFormTemplates);
router
  .route("/form-builder/templates")
  .get(authenticateUser, getAllFormTemplates);
router
  .route("/form-builder/templates/:templateId")
  .get(authenticateUser, getFormTemplateById);
router
  .route("/form-builder/templates/:templateId")
  .put(authenticateUser, logUserActivity, updateFormTemplate);
router
  .route("/form-builder/templates/:templateId")
  .delete(authenticateUser, logUserActivity, deleteFormTemplate);
//Assessment Routes
//Assessment Routes
router
  .route("/create/assessment")
  .post(authenticateToken, logUserActivity, createAssessment);
router.route("/assessments").get(authenticateToken, getAllAssessments);

// DELETE all the other duplicate /assessment/:assessmentId routes and just keep this ONE:
router
  .route("/assessment/:assessmentId")
  .get(authenticateToken, getAssessmentById)
  .put(authenticateToken, logUserActivity, updateAssessment)
  .delete(authenticateToken, logUserActivity, deleteAssessment);

//Department Routes

router
  .route("/department/create")
  .post(authenticateToken, logUserActivity, createDepartment);
router.route("/departments").get(authenticateToken, getAllDepartments);
router.route("/department/:departmentId").get(authenticateToken, getDepartment);
router
  .route("/department/update/:departmentId")
  .put(authenticateToken, logUserActivity, updateDepartment);
router
  .route("/department/delete/:departmentId")
  .delete(authenticateToken, logUserActivity, deleteDepartment);
router
  .route("/assigning/patient/:patientId")
  .put(authenticateToken, logUserActivity, assignCareTeam);
router
  .route("/create/session")
  .post(authenticateToken, logUserActivity, createSession);
router
  .route("/edit/session/:id")
  .put(authenticateToken, logUserActivity, editSession);
router
  .route("/all/sessions/:patientId")
  .get(authenticateToken, getSessionsByPatient);
router
  .route("/all/rehabsessions/:patientId")
  .get(authenticateToken, getFollowupSessionsByPatient);
router
  .route("/create/group/Session")
  .post(authenticateToken, logUserActivity, createGroupSession);
router
  .route("/create/lecture/session")
  .post(authenticateToken, logUserActivity, createLectureSession);

router.route("/lecture/sessions").get(authenticateToken, getLectureSessions);

router
  .route("/lecture/session/:id")
  .get(authenticateToken, getLectureSessionById)
  .put(authenticateToken, logUserActivity, updateLectureSession);

router
  .route("/lecture/session/:id/absent")
  .post(authenticateToken, logUserActivity, addAbsentPatient);

router
  .route("/lecture/session/:id/absent/:patientId")
  .delete(authenticateToken, logUserActivity, removeAbsentPatient);

router
  .route("/cancel/lecture/session/:id")
  .post(authenticateToken, logUserActivity, cancelLectureSession);

router
  .route("/delete/lecture/session/:id")
  .delete(authenticateToken, logUserActivity, deleteLectureSession);
//printing ROutes
router
  .route("/print/patient/:patientId")
  .get(authenticateToken, logUserActivity, getPatientForPrint);
router
  .route("/plan/summery/print/:planId")
  .get(authenticateToken, getTherapyPlanForPrint);

router
  .route("/session/report/:patientId")
  .get(authenticateToken, getAftercareSessionsByPatient);
router
  .route("/prescription/plan/:planId/patient/:patientId")
  .post(authenticateToken, logUserActivity, addPrescriptionToPlan);

// Edit an existing active prescription
router
  .route("/prescription/:prescriptionId")
  .put(authenticateToken, logUserActivity, editPrescription);

// End an active prescription early
router
  .route("/prescription/:prescriptionId/end")
  .put(authenticateToken, logUserActivity, endPrescription);

// Get all prescriptions for a specific therapy plan
router
  .route("/prescriptions/plan/:planId")
  .get(authenticateToken, getPrescriptionsByPlan);

router
  .route("/prescriptions/patient/:patientId")
  .get(authenticateToken, getPrescriptionsByPatient);

router.route("/patients/export").get(authenticateToken, exportAllPatients);
router
  .route("/conducted/aftercares")
  .get(authenticateToken, getGlobalAftercareReport);

router
  .route("/patient/score/:patientId")
  .get(authenticateToken, getPatientRecoveryTrend);
router
  .route("/get/prescription/print/:prescriptionId")
  .get(authenticateToken, getPrescriptionPrintDataById);
router
  .route("/print/assessment/:assessmentId")
  .get(authenticateToken, getSingleAssessmentForPrint);
// ==========================================
// Medical Reports Routes
// ==========================================

// Add a medical report to a specific plan and patient
router
  .route("/plan/:planId/patient/:patientId/medical-report")
  .post(authenticateToken, logUserActivity, addMedicalReportToPlan);

// Get all medical reports for a specific therapy plan
router
  .route("/plan/:planId/medical-reports")
  .get(authenticateToken, getPlanMedicalReports);

// Edit a specific medical report
router
  .route("/edit/medical-report/:reportId")
  .put(authenticateToken, logUserActivity, editMedicalReport);

// Archive (soft delete) a specific medical report
router
  .route("/archive/medical-report/:reportId")
  .patch(authenticateToken, logUserActivity, archiveMedicalReport);

// ==========================================
// Vitals History Routes
// ==========================================

// Add a vitals reading to a therapy plan
router
  .route("/plan/:planId/vitals")
  .post(authenticateToken, logUserActivity, addVitalsReading);

// Get vitals history for a specific therapy plan
router
  .route("/plan/:planId/vitals")
  .get(authenticateToken, getPlanVitalsHistory);

// Edit a specific vitals reading inside a plan
router
  .route("/plan/:planId/vitals/:readingId")
  .put(authenticateToken, logUserActivity, editVitalsReading);

//AI features
router.route("/auto/complete").post(authenticateToken, suggestNotesCompletion);
router
  .route("/print/translate")
  .post(authenticateToken, translateAssessmentPrint);
router
  .route("/patient/relapse/risk/:patientId")
  .get(authenticateToken, getPatientRelapseRisk);

router
  .route("/get/aftercare/appointments/dates")
  .post(authenticateToken, getAftercareAppointmentsByDateRange);
router.route("/get/followups").get(authenticateToken, getUpcomingFollowUps);
router
  .route("/get/my/followups")
  .get(authenticateToken, getDoctorUpcomingFollowUps);
router
  .route("/aftercare/medicalpart/:id")
  .post(authenticateToken, completeMedicalPhase);
router
  .route("/aftercare/councellarpart/:id")
  .post(authenticateToken, completeCounselorPhase);
router.route("/age/patients").get(authenticateToken, getAgeDistribution);
router.route("/new/patients").get(authenticateToken, getNewPatientsToday);
router
  .route("/demographics/patients")
  .get(authenticateToken, getDemographicBreakdown);
router
  .route("/referral/patients")
  .get(authenticateToken, getReferralSourceDistribution);
router
  .route("/geographic/patients")
  .get(authenticateToken, getGeographicDistribution);
router
  .route("/locationHome")
  .get(authenticateToken, getLocationVsHomeCityCrossTab);
router.route("/get/dropoutrate").get(authenticateToken, getPlanDropoutMetrics);
//prescription Template routes
router
  .route("/prescription-templates")
  .get(authenticateToken, getTemplates)
  .post(authenticateToken, createTemplate);
router
  .route("/prescription-templates/:id")
  .put(authenticateToken, updateTemplate)
  .delete(authenticateToken, deleteTemplate);

router
  .route("/delete/patient/:id")
  .delete(
    authenticateToken,
    checkDepartmentPrivilege("can_delete_patients"),
    deletePatient,
  );
router
  .route("/print-templates")
  .post(authenticateToken, createPrintTemplate)
  .get(authenticateToken, getAllPrintTemplates);

router
  .route("/monthly/opd")
  .get(authenticateToken, getMonthlyOpdRegisterForExcel);
router
  .route("/monthly/ipd")
  .get(authenticateToken, getMonthlyIpdRegisterForExcel);
router
  .route("/print-templates/:templateId")
  .put(authenticateToken, updatePrintTemplate)
  .get(authenticateToken, getPrintTemplateById)
  .delete(authenticateToken, deletePrintTemplate);
router.route("/my/performance").get(authenticateToken, getMyPerformanceReport);
router.route("/session/delete/:id").delete(authenticateToken, deleteSession);
// ==========================================
// Patient Payments Routes
// Billing hangs off the patient only (no plan / session / doctor linkage).
// Static paths are declared before "/payments/:id" so they are not read as ids.
// ==========================================
router
  .route("/payments/reports/collections")
  .get(authenticateToken, getCollectionsReport);
router
  .route("/payments/reports/monthly-comparison")
  .get(authenticateToken, getMonthlyComparison);
router
  .route("/payments/patient/:patientId/summary")
  .get(authenticateToken, getPatientPaymentSummary);
router
  .route("/payments")
  .post(authenticateToken, logUserActivity, createPayment)
  .get(authenticateToken, listPayments);
router
  .route("/payments/:id")
  .get(authenticateToken, getPayment)
  .patch(authenticateToken, logUserActivity, updatePayment);
router
  .route("/payments/:id/refund")
  .post(authenticateToken, logUserActivity, createRefund);
// "Delete" is a void with a reason; payments are never hard-deleted.
router
  .route("/payments/:id/void")
  .post(authenticateToken, logUserActivity, voidPayment);
// ==========================================
// Patient Package Routes (what each patient is charged)
// "/packages/templates" is declared before "/packages/:id" so it is not read as an id.
// ==========================================
router
  .route("/packages/templates")
  .get(authenticateToken, listPackageTemplates)
  .post(authenticateToken, logUserActivity, createPackageTemplate);
router
  .route("/packages/templates/:id")
  .patch(authenticateToken, logUserActivity, updatePackageTemplate)
  .delete(authenticateToken, logUserActivity, deletePackageTemplate);
router
  .route("/packages")
  .get(authenticateToken, listPackages)
  .post(authenticateToken, logUserActivity, createPackage);
router
  .route("/packages/:id")
  .get(authenticateToken, getPackage)
  .patch(authenticateToken, logUserActivity, updatePackage);
// Packages are cancelled, never deleted.
router
  .route("/packages/:id/cancel")
  .post(authenticateToken, logUserActivity, cancelPackage);

module.exports = router;
