const crypto = require("crypto");

const verifyRazorpayPayment = (req, res, next) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ msg: "Missing Razorpay payment details." });
  }

  const secret = process.env.RAZORPAY_SECRET;

  const generated_signature = crypto
    .createHmac("sha256", secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");
  console.log("here");
  if (generated_signature !== razorpay_signature) {
    return res.status(400).json({ msg: "Invalid payment signature." });
  }

  // If verified, allow request to proceed
  next();
};

module.exports = verifyRazorpayPayment;
