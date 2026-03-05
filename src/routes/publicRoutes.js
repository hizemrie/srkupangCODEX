const express = require("express");
const dayjs = require("dayjs");
const { db } = require("../db/init");
const { upcomingRange } = require("../utils/time");

const router = express.Router();

router.get("/", (req, res) => {
  const range = upcomingRange();
  const events = db
    .prepare(
      `SELECT ce.id, ce.title, ce.details, ce.event_date
       FROM calendar_events ce
       WHERE ce.is_deleted = 0 AND ce.event_date BETWEEN ? AND ?
       ORDER BY ce.event_date ASC`
    )
    .all(range.start, range.end);

  res.render("home", { events });
});

router.get("/leaderboard", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  res.render("leaderboard-classes", { classes });
});

router.get("/leaderboard/:classId", (req, res) => {
  const classId = Number(req.params.classId);
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!cls) return res.status(404).send("Class not found");

  const rows = db
    .prepare(
      `SELECT s.id, s.nickname, COALESCE(SUM(pl.points), 0) AS total_points
       FROM students s
       LEFT JOIN point_logs pl ON pl.student_id = s.id
       WHERE s.class_id = ?
       GROUP BY s.id, s.nickname
       ORDER BY total_points DESC, s.nickname ASC`
    )
    .all(classId);

  res.render("leaderboard", { cls, rows, generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});

router.get("/api/leaderboard/:classId", (req, res) => {
  const classId = Number(req.params.classId);
  const rows = db
    .prepare(
      `SELECT s.id, s.nickname, COALESCE(SUM(pl.points), 0) AS total_points
       FROM students s
       LEFT JOIN point_logs pl ON pl.student_id = s.id
       WHERE s.class_id = ?
       GROUP BY s.id, s.nickname
       ORDER BY total_points DESC, s.nickname ASC`
    )
    .all(classId);
  res.json({ rows, timestamp: dayjs().toISOString() });
});

module.exports = router;
