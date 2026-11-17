const nodemailer = require("nodemailer");
const { email } = require("../config/config");

// --- CONFIGURATION ---
const transporter = nodemailer.createTransport({
  host: "smtp.office365.com",
  port: 587,
  secure: false,
  auth: {
    user: email.user,
    pass: email.pass,
  },
  debug: true,
  logger: true,
  tls: {
    ciphers: "SSLv3",
    rejectUnauthorized: false,
  },
});

// --- QUEUE SYSTEM ---
const emailQueue = [];
let isProcessingQueue = false;

const processEmailQueue = async () => {
  if (emailQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  const task = emailQueue.shift();

  try {
    let info;

    // Route to appropriate email function based on type
    switch (task.type) {
      case "registration":
        info = await sendDoctorSuccessEmail(task.email, task.name);
        break;
      case "approval":
        info = await sendDoctorApprovalEmail(task.email, task.name, task.data);
        break;
      case "rejection":
        info = await sendDoctorRejectionEmail(task.email, task.name, task.data);
        break;
      default:
        throw new Error(`Unknown email type: ${task.type}`);
    }

    console.log(
      `[Queue] ✅ Email accepted by server for ${task.email}. MessageID: ${info.messageId}`
    );
  } catch (error) {
    console.error(`[Queue] ❌ Failed to send to ${task.email}:`, error);
  }

  setTimeout(processEmailQueue, 1000);
};

const addToEmailQueue = (email, name, type = "registration", data = {}) => {
  emailQueue.push({ email, name, type, data });
  if (!isProcessingQueue) {
    processEmailQueue();
  }
};

// --- EMAIL FUNCTIONS ---

// Original registration email
const sendDoctorSuccessEmail = (userEmail, userName) => {
  return new Promise((resolve, reject) => {
    const mailOptions = {
      from: `"HealTrack Pro Support" <${email.user}>`,
      to: userEmail,
      replyTo: email.user,
      subject: "Thank you for registering with HealTrack Pro",
      text: `Dear Dr. ${userName},

Thank you for registering with HealTrack Pro.

We are pleased to inform you that your profile is currently under review. Our team is reviewing your details, and we will reach out to you in no time.

Once the review is successfully completed, you will receive a separate email from us with your login information and next steps.

If you have any questions in the meantime, feel free to reply to this email.

Warm regards,
HealTrack Pro Support
`,
      html: `
  <div style="font-family: Arial, Helvetica, sans-serif; color:#333; line-height:1.6; max-width:600px; margin:0 auto;">
    <h2 style="color:#2c3e50; margin-bottom:16px;">
      Thank you for registering with HealTrack Pro
    </h2>
    <p>Dear Dr. ${userName},</p>
    <p>
      Thank you for registering with <strong>HealTrack Pro</strong>.
      We are pleased to have you on our platform.
    </p>
    <p>
      Your profile is currently <strong>under review</strong>.
      Our team is reviewing your details, and we will reach out to you in no time.
    </p>
    <p>
      Once the review is successfully completed, you will receive a separate email from us
      with your login information and further instructions.
    </p>
    <p style="margin-top:24px;">
      Warm regards,<br/>
      <strong>HealTrack Pro Support</strong>
    </p>
    <hr style="border:none; border-top:1px solid #eaeaea; margin:24px 0;" />
    <p style="font-size:12px; color:#777;">
      This email was sent to you because a registration was completed using your email address.
      If this was not you, you may safely ignore this message.
    </p>
  </div>
  `,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        reject(error);
      } else {
        resolve(info);
      }
    });
  });
};

// New approval email
const sendDoctorApprovalEmail = (userEmail, userName) => {
  return new Promise((resolve, reject) => {
    const mailOptions = {
      from: `"HealTrack Pro Support" <${email.user}>`,
      to: userEmail,
      replyTo: email.user,
      subject: "🎉 Your HealTrack Pro Profile is Approved!",
      text: `Hi Dr. ${userName},

Congratulations! 🎉

We're happy to let you know that your profile has been approved by our team.

You're officially part of HealTrack Pro now. Our team will reach out to you shortly with the next steps, including access details and onboarding information.

If you have any questions in the meantime, just reply to this email — we're here to help.

Welcome aboard!

Warm regards,
HealTrack Pro Team
`,
      html: `
<div style="font-family: Arial, Helvetica, sans-serif; color:#333; line-height:1.6; max-width:600px; margin:0 auto; padding:20px;">
  
  <div style="text-align:center; margin-bottom:24px;">
    <div style="display:inline-block; background:#10b981; color:white; padding:12px 24px; border-radius:8px; font-weight:bold; font-size:18px;">
      🎉 Profile Approved
    </div>
  </div>

  <p>Hi Dr. ${userName},</p>

  <p>
    <strong>Congratulations!</strong> We're excited to let you know that your profile has been approved by our team.
  </p>

  <p>
    You're officially part of <strong>HealTrack Pro</strong> 🎉
  </p>

  <p>
    Our team will reach out to you shortly with the next steps, including access details and onboarding information.
  </p>

  <p>
    If you have any questions in the meantime, feel free to reply to this email — we're always happy to help.
  </p>

  <p style="margin-top:24px;">
    Welcome aboard!<br/>
    <strong>HealTrack Pro Team</strong>
  </p>

  <hr style="border:none; border-top:1px solid #eaeaea; margin:24px 0;" />

  <p style="font-size:12px; color:#777;">
    This email was sent to ${userEmail} regarding your HealTrack Pro registration.
  </p>

</div>
`,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) reject(error);
      else resolve(info);
    });
  });
};

// New rejection email
const sendDoctorRejectionEmail = (userEmail, userName, data = {}) => {
  const rejectionReason =
    data.rejectionReason ||
    "Some required details need clarification or correction.";

  return new Promise((resolve, reject) => {
    const mailOptions = {
      from: `"HealTrack Pro Support" <${email.user}>`,
      to: userEmail,
      replyTo: email.user,
      subject: "Action Needed: Update Your HealTrack Pro Application",
      text: `Hi Dr. ${userName},

Thank you for applying to HealTrack Pro.

We've reviewed your application, and at the moment, we need a few updates before we can move forward.

What needs attention:
${rejectionReason}

Please update the requested details and submit the registration form again with the relevant changes.

Once updated, our team will review it again and get back to you as quickly as possible.

If you're unsure about anything, just reply to this email — we're happy to guide you.

Looking forward to your updated submission.

Warm regards,
HealTrack Pro Team
`,
      html: `
<div style="font-family: Arial, Helvetica, sans-serif; color:#333; line-height:1.6; max-width:600px; margin:0 auto; padding:20px;">
  
  <div style="text-align:center; margin-bottom:24px;">
    <div style="display:inline-block; background:#f59e0b; color:white; padding:12px 24px; border-radius:8px; font-weight:bold; font-size:18px;">
      ⚠️ Update Required
    </div>
  </div>

  <p>Hi Dr. ${userName},</p>

  <p>
    Thank you for applying to <strong>HealTrack Pro</strong>.
  </p>

  <p>
    After reviewing your application, we noticed that a few details need to be updated before we can proceed.
  </p>

  <div style="background:#fef3c7; border-left:4px solid #f59e0b; padding:16px; margin:24px 0; border-radius:4px;">
    <strong>What needs attention:</strong>
    <p style="margin-top:8px;">
      ${rejectionReason}
    </p>
  </div>

  <p>
    Please update the requested information and submit the registration form again with the relevant changes.
  </p>

  <p>
    Once resubmitted, our team will review it again and get back to you shortly.
  </p>

  <p>
    If you have any questions or need clarification, simply reply to this email — we're here to help.
  </p>

  <p style="margin-top:24px;">
    Warm regards,<br/>
    <strong>HealTrack Pro Team</strong>
  </p>

  <hr style="border:none; border-top:1px solid #eaeaea; margin:24px 0;" />

  <p style="font-size:12px; color:#777;">
    This email was sent to ${userEmail} regarding your HealTrack Pro application.
  </p>

</div>
`,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) reject(error);
      else resolve(info);
    });
  });
};

module.exports = {
  addToEmailQueue,
  sendDoctorSuccessEmail,
  sendDoctorApprovalEmail,
  sendDoctorRejectionEmail,
};
