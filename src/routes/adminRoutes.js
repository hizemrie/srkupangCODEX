const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const dayjs = require("dayjs");
const fs = require("fs");
const path = require("path");
const { db } = require("../db/init");
const { requireRole } = require("../middleware/auth");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const BACKUP_TABLES = {
  users: ["id", "username", "display_name", "role", "password_hash", "created_at"],
  classes: ["id", "name"],
  students: ["id", "student_id", "no_sb", "student_code", "full_name", "nickname", "dob", "photo_url", "emergency_contact", "siblings_json", "class_id", "created_at"],
  student_siblings: ["id", "student_pk", "sibling_student_pk", "created_at"],
  point_reasons: ["id", "reason", "created_by", "is_custom", "created_at"],
  point_logs: ["id", "student_id", "class_id", "points", "reason", "awarded_by", "awarded_at"],
  daily_points: ["id", "snapshot_date", "student_id", "total_points", "last_updated_at"],
  calendar_events: ["id", "title", "details", "event_date", "end_date", "created_by", "created_at", "deleted_by", "deleted_at", "is_deleted"]
};

router.use(requireRole("admin"));

function makeBackupSnapshot() {
  const data = {};
  for (const [table, columns] of Object.entries(BACKUP_TABLES)) {
    const sql = `SELECT ${columns.join(", ")} FROM ${table} ORDER BY id ASC`;
    data[table] = db.prepare(sql).all();
  }

  return {
    meta: {
      app: "srkupangcodex-school-app",
      backup_version: 1,
      created_at: dayjs().toISOString()
    },
    data
  };
}

function ensureValidBackupPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!payload.data || typeof payload.data !== "object") return false;
  return Object.keys(BACKUP_TABLES).every((table) => Array.isArray(payload.data[table]));
}

function insertRows(table, columns, rows) {
  if (!rows.length) return;
  const placeholders = columns.map(() => "?").join(", ");
  const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
  for (const row of rows) {
    stmt.run(...columns.map((c) => (Object.prototype.hasOwnProperty.call(row, c) ? row[c] : null)));
  }
}

router.get("/dashboard", (req, res) => {
  const teachers = db.prepare("SELECT id, username, display_name, created_at FROM users WHERE role='teacher' ORDER BY id DESC").all();
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  const deletedEvents = db
    .prepare(
      `SELECT ce.id, ce.title, ce.event_date, COALESCE(ce.end_date, ce.event_date) AS end_date, ce.deleted_at, u.display_name AS deleted_by_name
       FROM calendar_events ce
       LEFT JOIN users u ON u.id = ce.deleted_by
       WHERE ce.is_deleted = 1
       ORDER BY ce.deleted_at DESC`
    )
    .all();

  res.render("admin-dashboard", {
    teachers,
    classes,
    deletedEvents,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.post("/teachers/add", (req, res) => {
  const username = (req.body.username || "").trim();
  const displayName = (req.body.display_name || "").trim();
  const password = req.body.password || "";

  if (!username || !displayName || !password) {
    return res.status(400).send("username, display name and password required");
  }

  db.prepare(
    `INSERT INTO users (username, display_name, role, password_hash, created_at)
     VALUES (?, ?, 'teacher', ?, ?)`
  ).run(username, displayName, bcrypt.hashSync(password, 10), dayjs().toISOString());

  res.redirect("/admin/dashboard?success=Teacher+added");
});

router.post("/teachers/reset-password", (req, res) => {
  const teacherId = Number(req.body.teacher_id);
  const newPassword = req.body.new_password || "";
  if (!teacherId || !newPassword) return res.status(400).send("teacher_id and new_password required");

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND role='teacher'").run(bcrypt.hashSync(newPassword, 10), teacherId);
  res.redirect("/admin/dashboard?success=Teacher+password+reset");
});

router.post("/students/add", (req, res) => {
  const classId = Number(req.body.class_id);
  const studentId = (req.body.student_id || "").trim();
  const noSb = (req.body.no_sb || "").trim();
  const fullName = (req.body.full_name || "").trim();
  const nickname = (req.body.nickname || "").trim();
  const dob = req.body.dob;
  const photoUrl = (req.body.photo_url || "").trim();
  const emergencyContact = (req.body.emergency_contact || "").trim();
  const siblingsRaw = (req.body.siblings_student_ids || "").trim();

  if (!classId || !studentId || !noSb || !fullName || !nickname || !dob || !emergencyContact) {
    return res.status(400).send("Required fields missing");
  }

  const now = dayjs().toISOString();

  const info = db.prepare(
    `INSERT INTO students
     (student_id, no_sb, student_code, full_name, nickname, dob, photo_url, emergency_contact, siblings_json, class_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(studentId, noSb, studentId, fullName, nickname, dob, photoUrl, emergencyContact, "[]", classId, now);

  const newStudentPk = Number(info.lastInsertRowid);
  const siblingIds = siblingsRaw.split(";").map((s) => s.trim()).filter(Boolean);
  const findPkByStudentId = db.prepare("SELECT id FROM students WHERE student_id = ?");
  const linkSibling = db.prepare(
    `INSERT INTO student_siblings (student_pk, sibling_student_pk, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(student_pk, sibling_student_pk) DO NOTHING`
  );

  for (const sid of siblingIds) {
    const sibling = findPkByStudentId.get(sid);
    if (!sibling || sibling.id === newStudentPk) continue;
    linkSibling.run(newStudentPk, sibling.id, now);
    linkSibling.run(sibling.id, newStudentPk, now);
  }

  res.redirect("/admin/dashboard?success=Student+added");
});

router.post("/students/import", upload.single("students_csv"), (req, res) => {
  if (!req.file) return res.status(400).send("CSV file required");

  const content = req.file.buffer.toString("utf8");
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });

  const insert = db.prepare(
    `INSERT INTO students
     (student_id, no_sb, student_code, full_name, nickname, dob, photo_url, emergency_contact, siblings_json, class_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const findClass = db.prepare("SELECT id FROM classes WHERE name = ?");
  const findPkByStudentId = db.prepare("SELECT id FROM students WHERE student_id = ?");
  const linkSibling = db.prepare(
    `INSERT INTO student_siblings (student_pk, sibling_student_pk, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(student_pk, sibling_student_pk) DO NOTHING`
  );

  const now = dayjs().toISOString();

  const tx = db.transaction((rows) => {
    const pendingLinks = [];

    for (const row of rows) {
      const className = row.class_name || row.Class || row.class;
      const cls = findClass.get(className);
      if (!cls) continue;

      const externalStudentId = (row.student_id || "").trim();
      const noSb = (row["No.SB"] || row.no_sb || "").trim();
      if (!externalStudentId || !noSb) continue;

      insert.run(
        externalStudentId,
        noSb,
        externalStudentId,
        row.full_name,
        row.nickname,
        row.dob,
        row.photo_url || "",
        row.emergency_contact,
        "[]",
        cls.id,
        now
      );

      const siblingIds = (row.siblings_student_ids || "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      pendingLinks.push({ studentId: externalStudentId, siblingIds });
    }

    for (const pending of pendingLinks) {
      const source = findPkByStudentId.get(pending.studentId);
      if (!source) continue;
      for (const siblingStudentId of pending.siblingIds) {
        const target = findPkByStudentId.get(siblingStudentId);
        if (!target || target.id === source.id) continue;
        linkSibling.run(source.id, target.id, now);
        linkSibling.run(target.id, source.id, now);
      }
    }
  });

  tx(records);
  res.redirect("/admin/dashboard?success=Students+imported");
});

router.get("/backup/download", (req, res) => {
  const payload = makeBackupSnapshot();
  const fileName = `srkupang-backup-${dayjs().format("YYYYMMDD-HHmmss")}.json`;

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
  res.send(JSON.stringify(payload, null, 2));
});

router.post("/backup/save-path", (req, res) => {
  try {
    const destinationPath = (req.body.destination_path || "").trim();
    if (!destinationPath) {
      return res.redirect("/admin/dashboard?error=Destination+path+is+required");
    }

    if (!fs.existsSync(destinationPath) || !fs.statSync(destinationPath).isDirectory()) {
      return res.redirect("/admin/dashboard?error=Destination+path+must+be+an+existing+folder");
    }

    const payload = makeBackupSnapshot();
    const fileName = `srkupang-backup-${dayjs().format("YYYYMMDD-HHmmss")}.json`;
    const filePath = path.join(destinationPath, fileName);

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return res.redirect(`/admin/dashboard?success=Backup+saved+to+${encodeURIComponent(filePath)}`);
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Backup failed: ${err.message}`)}`);
  }
});

router.post("/backup/restore", upload.single("backup_file"), (req, res) => {
  try {
    if (!req.file) {
      return res.redirect("/admin/dashboard?error=Backup+file+is+required");
    }

    const payload = JSON.parse(req.file.buffer.toString("utf8"));
    if (!ensureValidBackupPayload(payload)) {
      return res.redirect("/admin/dashboard?error=Invalid+backup+file+format");
    }

    const tx = db.transaction((backupData) => {
      db.pragma("foreign_keys = OFF");

      db.exec("DELETE FROM point_logs");
      db.exec("DELETE FROM daily_points");
      db.exec("DELETE FROM student_siblings");
      db.exec("DELETE FROM students");
      db.exec("DELETE FROM point_reasons");
      db.exec("DELETE FROM calendar_events");
      db.exec("DELETE FROM classes");
      db.exec("DELETE FROM users");

      insertRows("users", BACKUP_TABLES.users, backupData.users);
      insertRows("classes", BACKUP_TABLES.classes, backupData.classes);
      insertRows("students", BACKUP_TABLES.students, backupData.students);
      insertRows("student_siblings", BACKUP_TABLES.student_siblings, backupData.student_siblings);
      insertRows("point_reasons", BACKUP_TABLES.point_reasons, backupData.point_reasons);
      insertRows("point_logs", BACKUP_TABLES.point_logs, backupData.point_logs);
      insertRows("daily_points", BACKUP_TABLES.daily_points, backupData.daily_points);
      insertRows("calendar_events", BACKUP_TABLES.calendar_events, backupData.calendar_events);

      db.exec("DELETE FROM sqlite_sequence");
      for (const [table, rows] of Object.entries(backupData)) {
        const maxId = rows.reduce((max, r) => Math.max(max, Number(r.id || 0)), 0);
        if (maxId > 0) {
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, maxId);
        }
      }

      db.pragma("foreign_keys = ON");
    });

    tx(payload.data);

    req.session.destroy(() => {
      res.redirect("/login/admin");
    });
  } catch (err) {
    res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Restore failed: ${err.message}`)}`);
  }
});

router.post("/events/purge/:eventId", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.redirect("/admin/dashboard?error=Invalid+event+ID");

  db.prepare("DELETE FROM calendar_events WHERE id = ? AND is_deleted = 1").run(eventId);
  return res.redirect("/admin/dashboard?success=Deleted+event+removed+permanently");
});

module.exports = router;
