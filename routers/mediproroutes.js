const express = require("express");
const Mediprorouter = express.Router();
const {
  onboardDoctor,
  updateMediproPhoto,
  deleteMediproPhoto,
  updateMediproResume,
  deleteMediproResume,
  upload,
  getApplicationById,
  getAllApplications,
  getLocationWithSpeciality,
  approveDoctor,
} = require("../controllers/mediproController");
const {
  getSuperAdminRefundRequests,
  decideRefund,
  markRefundCompleted,
} = require("../controllers/consultationRefundController");
const { authenticateSuperAdmin } = require("../middleware/isAdmin");
// Onboarding route
Mediprorouter.route("/onboard-doctor").post(
  upload.fields([
    { name: "profile_pic", maxCount: 1 },
    { name: "resume", maxCount: 1 },
  ]),
  onboardDoctor
);

// Profile photo routes
Mediprorouter.route("/update-photo/:profileId").put(
  upload.single("profile_pic"),
  updateMediproPhoto
);

Mediprorouter.route("/delete-photo/:profileId").delete(deleteMediproPhoto);

// Resume routes
Mediprorouter.route("/update-resume/:profileId").put(
  upload.single("resume"),
  updateMediproResume
);
Mediprorouter.route("/get/all/application").get(
  authenticateSuperAdmin,
  getAllApplications
);
Mediprorouter.route("/approve/application/by/:doctorId").put(
  authenticateSuperAdmin,
  approveDoctor
);
Mediprorouter.route("/get/application/by/id/:id").get(
  authenticateSuperAdmin,
  getApplicationById
);
Mediprorouter.route("/delete-resume/:profileId").delete(deleteMediproResume);

Mediprorouter.get("/getStatesandSpeciality", authenticateSuperAdmin, getLocationWithSpeciality)
Mediprorouter.get(
  "/superAdmin/refunds",
  authenticateSuperAdmin,
  getSuperAdminRefundRequests
);

Mediprorouter.post(
  "/superAdmin/refunds/action",
  authenticateSuperAdmin,
  decideRefund
);

Mediprorouter.post(
  "/superAdmin/refunds/mark-refunded",
  authenticateSuperAdmin,
  markRefundCompleted
);

module.exports = Mediprorouter;
