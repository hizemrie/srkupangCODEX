const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../db/init");

const router = express.Router();

router.get("/login/teacher", (req, res) => {
  res.render("login", { role: "teacher", error: null });
});

router.post("/login/teacher", (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'teacher'").get(username);

  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).render("login", { role: "teacher", error: "Invalid credentials" });
  }

  req.session.user = { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
  return res.redirect("/teacher/dashboard");
});

router.get("/login/admin", (req, res) => {
  res.render("login", { role: "admin", error: null });
});

router.post("/login/admin", (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin'").get(username);

  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).render("login", { role: "admin", error: "Invalid credentials" });
  }

  req.session.user = { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
  return res.redirect("/admin/dashboard");
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

module.exports = router;
