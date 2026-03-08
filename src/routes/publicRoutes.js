const express = require("express");
const dayjs = require("dayjs");
const { db } = require("../db/init");
const { upcomingRange } = require("../utils/time");

const router = express.Router();

const leaderboardQuery = `
  SELECT
    s.id,
    s.nickname,
    COALESCE(NULLIF(s.photo_path, ''), NULLIF(s.photo_url, '')) AS photo_url,
    COALESCE(SUM(pl.points), 0) AS total_points,
    last_log.awarded_at AS last_awarded_at,
    last_log.reason AS last_reason
  FROM students s
  LEFT JOIN point_logs pl ON pl.student_id = s.id
  LEFT JOIN (
    SELECT x.student_id, x.awarded_at, x.reason
    FROM point_logs x
    JOIN (
      SELECT student_id, MAX(awarded_at) AS max_awarded_at
      FROM point_logs
      GROUP BY student_id
    ) m ON m.student_id = x.student_id AND m.max_awarded_at = x.awarded_at
  ) last_log ON last_log.student_id = s.id
  WHERE s.class_id = ?
  GROUP BY s.id, s.nickname, s.photo_path, s.photo_url, last_log.awarded_at, last_log.reason
  ORDER BY total_points DESC, s.nickname ASC
`;

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
  const schoolTop10 = db
    .prepare(
      `SELECT
         s.id,
         s.nickname,
         COALESCE(NULLIF(s.photo_path, ''), NULLIF(s.photo_url, '')) AS photo_url,
         COALESCE(SUM(pl.points), 0) AS total_points,
         last_log.awarded_at AS last_awarded_at,
         last_log.reason AS last_reason
       FROM students s
       LEFT JOIN point_logs pl ON pl.student_id = s.id
       LEFT JOIN (
         SELECT x.student_id, x.awarded_at, x.reason
         FROM point_logs x
         JOIN (
           SELECT student_id, MAX(awarded_at) AS max_awarded_at
           FROM point_logs
           GROUP BY student_id
         ) m ON m.student_id = x.student_id AND m.max_awarded_at = x.awarded_at
       ) last_log ON last_log.student_id = s.id
       GROUP BY s.id, s.nickname, s.photo_path, s.photo_url, last_log.awarded_at, last_log.reason
       ORDER BY total_points DESC, s.nickname ASC
       LIMIT 10`
    )
    .all();

  res.render("leaderboard-classes", { classes, schoolTop10 });
});

router.get("/leaderboard/:classId", (req, res) => {
  const classId = Number(req.params.classId);
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!cls) return res.status(404).send("Class not found");

  const rows = db.prepare(leaderboardQuery).all(classId);

  res.render("leaderboard", { cls, rows, generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});

router.get("/api/leaderboard/:classId", (req, res) => {
  const classId = Number(req.params.classId);
  const rows = db.prepare(leaderboardQuery).all(classId);

  res.json({ rows, timestamp: dayjs().toISOString() });
});

module.exports = router;
