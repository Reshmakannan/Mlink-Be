require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const authRoutes = require("./src/routes/Authroutes");
const subscriptionRoutes = require("./src/routes/subscriptionRoutes");
const profileRoutes = require("./src/routes/profileRoutes"); // added
const razorpayController = require("./src/controllers/razorpayController");
const razorpayRoutes = require("./src/routes/razorpayRoutes");

const app = express();

// helmet's default blocks images loaded from another origin (React on :3000
// loading photos from :5000), so allow cross-origin for resources.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } })); // added
app.use(cors());
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), razorpayController.webhook);

app.use(express.json({ limit: "10kb" })); 

// Serves uploaded profile photos (added)
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    index: false,
    dotfiles: "deny",
    setHeaders: (res) => res.set("X-Content-Type-Options", "nosniff"),
  })
);

app.use("/api/auth", authRoutes);
app.use("/api/subscriptions", razorpayRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/profile", profileRoutes); // added
app.use("/api/public", require("./src/routes/publicRoutes")); // added — no auth, serves published pages

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});