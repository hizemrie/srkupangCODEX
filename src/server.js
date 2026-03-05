const path = require("path");
const express = require("express");
const session = require("express-session");
const dayjs = require("dayjs");
const { initializeDatabase } = require("./db/init");

const authRoutes = require("./routes/authRoutes");
const publicRoutes = require("./routes/publicRoutes");
const teacherRoutes = require("./routes/teacherRoutes");
const adminRoutes = require("./routes/adminRoutes");

initializeDatabase();

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.use(
  session({
    secret: "srk-lan-secret-please-change",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax"
    }
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.now = dayjs();
  next();
});

app.use((req, res, next) => {
  if (!req.session.user) return next();

  const now = Date.now();
  const last = req.session.lastActivity || now;
  const timeoutMs = 2 * 60 * 1000;

  if (now - last > timeoutMs) {
    return req.session.destroy(() => res.redirect("/"));
  }

  req.session.lastActivity = now;
  return next();
});

app.use(authRoutes);
app.use(publicRoutes);
app.use("/teacher", teacherRoutes);
app.use("/admin", adminRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Internal server error");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
