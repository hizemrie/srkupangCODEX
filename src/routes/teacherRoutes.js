const express = require("express");
const dayjs = require("dayjs");
const { db, updateDailySnapshot } = require("../db/init");
const { requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireRole("teacher"));

router.get("/dashboard", (req, res) => {
  res.render("teacher-dashboard", { user: req.session.user });
});

router.get("/reward", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  res.render("teacher-classes", { classes, mode: "reward" });
});

router.get("/reward/:classId", (req, res) => {
  const classId = Number(req.params.classId);
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!cls) return res.status(404).send("Class not found");

  const students = db
    .prepare(
      `SELECT s.id, s.nickname, s.full_name, COALESCE(SUM(pl.points), 0) AS total_points
       FROM students s
       LEFT JOIN point_logs pl ON pl.student_id = s.id
       WHERE s.class_id = ?
       GROUP BY s.id
       ORDER BY s.nickname ASC`
    )
    .all(classId);

  const reasons = db.prepare("SELECT reason FROM point_reasons ORDER BY reason ASC").all();
  res.render("teacher-reward", { cls, students, reasons, user: req.session.user, error: null });
});

router.post("/reward/award", (req, res) => {
  const pickLast = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

  const studentId = Number(pickLast(req.body.student_id));
  const classId = Number(pickLast(req.body.class_id));
  const mode = String(pickLast(req.body.point_mode) || "").trim();
  const manualPoints = Number(pickLast(req.body.manual_points) || 0);

  const points = mode === "manual" ? manualPoints : Number(mode);
  if (!Number.isInteger(points)) {
    return res.status(400).send("Points must be an integer");
  }

  const reasonBase = (req.body.reason || "").trim();
  const customReason = (req.body.custom_reason || "").trim();
  const reason = customReason || reasonBase;
  if (!reason) {
    return res.status(400).send("Reason is required");
  }

  const student = db.prepare("SELECT id FROM students WHERE id = ? AND class_id = ?").get(studentId, classId);
  if (!student) return res.status(404).send("Student not found");

  const now = dayjs().toISOString();

  if (customReason) {
    db.prepare(
      `INSERT INTO point_reasons (reason, created_by, is_custom, created_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(reason) DO NOTHING`
    ).run(customReason, req.session.user.id, now);
  }

  db.prepare(
    `INSERT INTO point_logs (student_id, class_id, points, reason, awarded_by, awarded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(studentId, classId, points, reason, req.session.user.id, now);

  updateDailySnapshot(studentId);
  res.redirect(`/teacher/reward/${classId}`);
});

router.get("/students", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  res.render("teacher-classes", { classes, mode: "students" });
});

router.get("/students/class/:classId", (req, res) => {
  const classId = Number(req.params.classId);
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!cls) return res.status(404).send("Class not found");
  const students = db.prepare("SELECT id, full_name, nickname FROM students WHERE class_id = ? ORDER BY full_name ASC").all(classId);
  res.render("student-list", { cls, students });
});

router.get("/students/:studentId", (req, res) => {
  const studentPk = Number(req.params.studentId);
  const student = db
    .prepare(
      `SELECT s.*, c.name AS class_name, COALESCE(SUM(pl.points), 0) AS total_points
       FROM students s
       JOIN classes c ON c.id = s.class_id
       LEFT JOIN point_logs pl ON pl.student_id = s.id
       WHERE s.id = ?
       GROUP BY s.id`
    )
    .get(studentPk);

  if (!student) return res.status(404).send("Student not found");

  const siblings = db
    .prepare(
      `SELECT sib.student_id, sib.full_name, sib.nickname, c.name AS class_name
       FROM student_siblings ss
       JOIN students sib ON sib.id = ss.sibling_student_pk
       JOIN classes c ON c.id = sib.class_id
       WHERE ss.student_pk = ?
       ORDER BY sib.full_name ASC`
    )
    .all(studentPk);

  res.render("student-detail", { student, siblings });
});

router.get("/calendar", (req, res) => {
  const monthQuery = (req.query.month || "").trim();
  const isMonthQueryValid = /^\d{4}-\d{2}$/.test(monthQuery);
  const monthBase = isMonthQueryValid ? dayjs(`${monthQuery}-01`) : dayjs().startOf("month");
  const monthStart = monthBase.isValid() ? monthBase.startOf("month") : dayjs().startOf("month");

  const offsetFromMonday = (monthStart.day() + 6) % 7;
  const gridStart = monthStart.subtract(offsetFromMonday, "day");
  const gridEnd = gridStart.add(41, "day");

  const eventRows = db
    .prepare(
      `SELECT ce.id, ce.title, ce.details, ce.event_date, COALESCE(ce.end_date, ce.event_date) AS end_date, ce.created_at, u.display_name AS creator_name
       FROM calendar_events ce
       JOIN users u ON u.id = ce.created_by
       WHERE ce.is_deleted = 0
         AND date(COALESCE(ce.end_date, ce.event_date)) >= date(?)
         AND date(ce.event_date) <= date(?)
       ORDER BY ce.event_date ASC, ce.created_at ASC`
    )
    .all(gridStart.format("YYYY-MM-DD"), gridEnd.format("YYYY-MM-DD"));

  const allEvents = db
    .prepare(
      `SELECT ce.id, ce.title, ce.details, ce.event_date, COALESCE(ce.end_date, ce.event_date) AS end_date, ce.created_at, u.display_name AS creator_name
       FROM calendar_events ce
       JOIN users u ON u.id = ce.created_by
       WHERE ce.is_deleted = 0
       ORDER BY ce.event_date ASC, ce.created_at DESC`
    )
    .all();

  const deletedLogs = db
    .prepare(
      `SELECT ce.id, ce.title, ce.event_date, COALESCE(ce.end_date, ce.event_date) AS end_date, ce.deleted_at, u.display_name AS deleted_by_name
       FROM calendar_events ce
       LEFT JOIN users u ON u.id = ce.deleted_by
       WHERE ce.is_deleted = 1
       ORDER BY ce.deleted_at DESC
       LIMIT 100`
    )
    .all();

  const colorPalette = ["#6aa84f", "#e0b525", "#6a4fa3", "#3f6fae", "#b33771", "#f39c12", "#2a9d8f"];
  const normalizedEvents = eventRows.map((ev) => {
    let start = dayjs(ev.event_date);
    let end = dayjs(ev.end_date || ev.event_date);
    if (end.isBefore(start, "day")) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    return {
      ...ev,
      start,
      end,
      color: colorPalette[ev.id % colorPalette.length]
    };
  });

  const weeks = [];
  for (let weekIndex = 0; weekIndex < 6; weekIndex += 1) {
    const weekStart = gridStart.add(weekIndex * 7, "day");
    const weekEnd = weekStart.add(6, "day");

    const days = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const d = weekStart.add(dayIndex, "day");
      const isoDate = d.format("YYYY-MM-DD");
      days.push({
        isoDate,
        dayOfMonth: d.format("DD"),
        isCurrentMonth: d.month() === monthStart.month(),
        isToday: isoDate === dayjs().format("YYYY-MM-DD")
      });
    }

    const weekEvents = normalizedEvents
      .filter((ev) => !(ev.end.isBefore(weekStart, "day") || ev.start.isAfter(weekEnd, "day")))
      .sort((a, b) => {
        if (a.start.isBefore(b.start, "day")) return -1;
        if (a.start.isAfter(b.start, "day")) return 1;
        return b.end.diff(b.start, "day") - a.end.diff(a.start, "day");
      });

    const laneEndByIndex = [];
    const spans = [];

    for (const ev of weekEvents) {
      const segStart = ev.start.isBefore(weekStart, "day") ? weekStart : ev.start;
      const segEnd = ev.end.isAfter(weekEnd, "day") ? weekEnd : ev.end;
      const startIdx = segStart.diff(weekStart, "day");
      const endIdx = segEnd.diff(weekStart, "day");

      let lane = laneEndByIndex.findIndex((endAt) => endAt < startIdx);
      if (lane === -1) {
        lane = laneEndByIndex.length;
        laneEndByIndex.push(endIdx);
      } else {
        laneEndByIndex[lane] = endIdx;
      }

      spans.push({
        id: ev.id,
        title: ev.title,
        details: ev.details,
        createdBy: ev.creator_name,
        color: ev.color,
        lane,
        startCol: startIdx + 1,
        endCol: endIdx + 2,
        continuesLeft: ev.start.isBefore(weekStart, "day"),
        continuesRight: ev.end.isAfter(weekEnd, "day")
      });
    }

    weeks.push({
      days,
      spans,
      laneCount: Math.max(laneEndByIndex.length, 1)
    });
  }

  res.render("teacher-calendar", {
    user: req.session.user,
    monthLabel: monthStart.format("MMMM YYYY"),
    prevMonth: monthStart.subtract(1, "month").format("YYYY-MM"),
    nextMonth: monthStart.add(1, "month").format("YYYY-MM"),
    weeks,
    allEvents,
    deletedLogs
  });
});

router.post("/calendar/add", (req, res) => {
  const title = (req.body.title || "").trim();
  const details = (req.body.details || "").trim();
  const eventDate = (req.body.event_date || "").trim();
  const endDate = (req.body.end_date || eventDate).trim();

  if (!title || !eventDate) return res.status(400).send("Title and start date are required");
  if (dayjs(endDate).isBefore(dayjs(eventDate), "day")) return res.status(400).send("End date cannot be earlier than start date");

  db.prepare(
    `INSERT INTO calendar_events (title, details, event_date, end_date, created_by, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(title, details, eventDate, endDate, req.session.user.id, dayjs().toISOString());

  const monthKey = dayjs(eventDate).format("YYYY-MM");
  res.redirect(`/teacher/calendar?month=${monthKey}`);
});

router.post("/calendar/delete/:eventId", (req, res) => {
  const eventId = Number(req.params.eventId);
  db.prepare(
    `UPDATE calendar_events
     SET is_deleted = 1, deleted_by = ?, deleted_at = ?
     WHERE id = ? AND is_deleted = 0`
  ).run(req.session.user.id, dayjs().toISOString(), eventId);

  res.redirect("/teacher/calendar");
});

router.get("/report", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  const classId = Number(req.query.classId || 0);
  const dateFrom = req.query.from || "";
  const dateTo = req.query.to || "";

  let rows = [];
  if (classId && dateFrom && dateTo) {
    rows = db
      .prepare(
        `SELECT pl.awarded_at, s.student_id, s.no_sb, s.full_name, s.nickname, pl.points, pl.reason, u.display_name AS awarded_by
         FROM point_logs pl
         JOIN students s ON s.id = pl.student_id
         JOIN users u ON u.id = pl.awarded_by
         WHERE pl.class_id = ? AND date(pl.awarded_at) BETWEEN ? AND ?
         ORDER BY pl.awarded_at DESC`
      )
      .all(classId, dateFrom, dateTo);
  }

  res.render("teacher-report", { classes, rows, classId, dateFrom, dateTo });
});

router.get("/report/export", (req, res) => {
  const classId = Number(req.query.classId || 0);
  const dateFrom = req.query.from || "";
  const dateTo = req.query.to || "";
  if (!classId || !dateFrom || !dateTo) return res.status(400).send("Missing filters");

  const rows = db
    .prepare(
      `SELECT pl.awarded_at, s.student_id, s.no_sb, s.full_name, s.nickname, pl.points, pl.reason, u.display_name AS awarded_by
       FROM point_logs pl
       JOIN students s ON s.id = pl.student_id
       JOIN users u ON u.id = pl.awarded_by
       WHERE pl.class_id = ? AND date(pl.awarded_at) BETWEEN ? AND ?
       ORDER BY pl.awarded_at DESC`
    )
    .all(classId, dateFrom, dateTo);

  const header = "awarded_at,student_id,no_sb,full_name,nickname,points,reason,awarded_by";
  const csvRows = rows.map((r) => {
    const vals = [r.awarded_at, r.student_id, r.no_sb, r.full_name, r.nickname, r.points, r.reason, r.awarded_by].map((v) => {
      const s = String(v ?? "").replace(/\"/g, '\"\"');
      return `\"${s}\"`;
    });
    return vals.join(",");
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=teacher-report-${classId}-${dateFrom}-to-${dateTo}.csv`);
  res.send([header, ...csvRows].join("\\n"));
});

module.exports = router;
