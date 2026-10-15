const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/Authroutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes"); // added

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/subscriptions", subscriptionRoutes); // added

module.exports = app;