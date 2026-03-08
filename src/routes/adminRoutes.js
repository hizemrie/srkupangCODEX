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
const uploadMemory = multer({ storage: multer.memoryStorage() });

const STUDENT_UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "students");
if (!fs.existsSync(STUDENT_UPLOAD_DIR)) {
  fs.mkdirSync(STUDENT_UPLOAD_DIR, { recursive: true });
}

const photoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, STUDENT_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safeId = String(req.body.student_id || "student").replace(/[^a-zA-Z0-9_-]/g, "_");
    cb(null, `${safeId}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || "").startsWith("image/")) return cb(null, true);
    return cb(new Error("Only image files are allowed"));
  }
});

function normalizePhotoPath(file) {
  if (!file) return "";
  const rel = path.join("uploads", "students", file.filename).replace(/\\/g, "/");
  return `/${rel}`;
}

function removeManagedPhotoIfExists(photoPath) {
  const rel = String(photoPath || "").trim();
  if (!rel || !rel.startsWith("/uploads/students/")) return;
  const abs = path.join(__dirname, "..", "..", "public", rel.replace(/^\//, ""));
  if (fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (_) {}
  }
}

const BACKUP_TABLES = {
  users: ["id", "username", "display_name", "role", "user_type", "password_hash", "is_active", "created_at"],
  classes: ["id", "name"],
  students: [
    "id",
    "student_id",
    "family_id",
    "no_sb",
    "student_code",
    "full_name",
    "nickname",
    "dob",
    "gender",
    "address",
    "student_status",
    "notes",
    "photo_url",
    "photo_path",
    "emergency_contact",
    "siblings_json",
    "class_id",
    "created_at"
  ],
  student_siblings: ["id", "student_pk", "sibling_student_pk", "created_at"],
  point_reasons: ["id", "reason", "reason_type", "created_by", "is_custom", "created_at"],
  point_logs: ["id", "student_id", "class_id", "points", "reason", "awarded_by", "awarded_at"],
  daily_points: ["id", "snapshot_date", "student_id", "total_points", "last_updated_at"],
  calendar_events: ["id", "title", "details", "event_date", "end_date", "event_source", "created_by", "created_at", "deleted_by", "deleted_at", "is_deleted"],
  calendar_labels: ["id", "name", "color", "description", "created_by", "is_system", "created_at"],
  calendar_event_labels: ["event_id", "label_id"],
  calendar_event_users: ["event_id", "user_id"]
};

router.use(requireRole("admin"));

function makeBackupSnapshot() {
  const data = {};
  for (const [table, columns] of Object.entries(BACKUP_TABLES)) {
    const orderBy = columns.includes("id") ? "id ASC" : columns.map((c) => `${c} ASC`).join(", ");
    const sql = `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${orderBy}`;
    data[table] = db.prepare(sql).all();
  }

  return {
    meta: {
      app: "srkupangcodex-school-app",
      backup_version: 2,
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
    stmt.run(
      ...columns.map((c) => {
        if (Object.prototype.hasOwnProperty.call(row, c)) return row[c];
        if (table === "calendar_events" && c === "event_source") return "manual";
        if (table === "point_reasons" && c === "reason_type") return "positive";
        if (table === "users" && c === "is_active") return 1;
        if (table === "users" && c === "user_type") return row.role === "admin" ? "admin" : "teacher";
        return null;
      })
    );
  }
}

function syncFamilyLinks(studentPk, familyId, now, linkSibling, findByFamily) {
  const fam = String(familyId || "").trim();
  if (!fam) return;

  const members = findByFamily.all(fam);
  for (const member of members) {
    if (!member || Number(member.id) === Number(studentPk)) continue;
    linkSibling.run(studentPk, member.id, now);
    linkSibling.run(member.id, studentPk, now);
  }
}

router.get("/dashboard", (req, res) => {
  const staffUsers = db
    .prepare(
      `SELECT id, username, display_name, role,
              COALESCE(user_type, CASE WHEN role = 'admin' THEN 'admin' WHEN role = 'staff' THEN 'staff' ELSE 'teacher' END) AS user_type,
              COALESCE(is_active, 1) AS is_active,
              created_at
       FROM users
       ORDER BY id DESC`
    )
    .all();
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  const selectedClassId = Number(req.query.class_id) || (classes[0] ? classes[0].id : null);

  const studentsInClass = selectedClassId
    ? db
        .prepare(
          `SELECT id, student_id, no_sb, full_name, nickname
           FROM students
           WHERE class_id = ?
           ORDER BY nickname ASC, full_name ASC`
        )
        .all(selectedClassId)
    : [];

  const selectedStudentId = Number(req.query.student_pk) || (studentsInClass[0] ? studentsInClass[0].id : null);
  const selectedStudent = selectedStudentId
    ? db
        .prepare(
          `SELECT id, student_id, family_id, no_sb, full_name, nickname, dob, gender, address, student_status, notes, photo_url, photo_path, emergency_contact, class_id
           FROM students
           WHERE id = ? AND class_id = ?`
        )
        .get(selectedStudentId, selectedClassId)
    : null;

  const activeEvents = db
    .prepare(
      `SELECT ce.id, ce.title, ce.event_date, COALESCE(ce.end_date, ce.event_date) AS end_date, ce.event_source, ce.created_at, u.display_name AS creator_name
       FROM calendar_events ce
       LEFT JOIN users u ON u.id = ce.created_by
       WHERE ce.is_deleted = 0
       ORDER BY ce.event_date ASC, ce.created_at DESC`
    )
    .all();

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
    staffUsers,
    classes,
    selectedClassId,
    studentsInClass,
    selectedStudentId,
    selectedStudent,
    activeEvents,
    deletedEvents,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.get("/staff/template", (_req, res) => {
  const templatePath = path.join(__dirname, "..", "..", "public", "templates", "staff-import-template.csv");
  if (!fs.existsSync(templatePath)) {
    return res.status(404).send("Template not found");
  }
  return res.download(templatePath, "staff-import-template.csv");
});

function parseRoleAndType(roleRaw, userTypeRaw) {
  const roleNorm = String(roleRaw || "teacher").trim().toLowerCase();
  const role = ["admin", "teacher", "staff"].includes(roleNorm) ? roleNorm : "teacher";
  const typeNorm = String(userTypeRaw || role).trim().toLowerCase();
  const userType = ["admin", "teacher", "staff"].includes(typeNorm)
    ? typeNorm
    : (role === "admin" ? "admin" : (role === "staff" ? "staff" : "teacher"));
  return { role, userType };
}

function addUserHandler(req, res) {
  const username = (req.body.username || "").trim();
  const displayName = (req.body.display_name || "").trim();
  const password = req.body.password || "";
  const { role, userType } = parseRoleAndType(req.body.role, req.body.user_type);
  const isActive = String(req.body.is_active || "1") === "1" ? 1 : 0;

  if (!username || !displayName || !password) {
    return res.status(400).send("user_id, display name and password required");
  }
  if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
    return res.redirect("/admin/dashboard?error=USER+ID+already+exists");
  }

  db.prepare(
    `INSERT INTO users (username, display_name, role, user_type, password_hash, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(username, displayName, role, userType, bcrypt.hashSync(password, 10), isActive, dayjs().toISOString());

  return res.redirect("/admin/dashboard?success=User+account+added");
}

router.post("/users/add", addUserHandler);
router.post("/teachers/add", addUserHandler);

router.post("/teachers/reset-password", (req, res) => {
  const userId = Number(req.body.teacher_id || req.body.user_id);
  const newPassword = req.body.new_password || "";
  if (!userId || !newPassword) return res.status(400).send("user_id and new_password required");

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(newPassword, 10), userId);
  res.redirect("/admin/dashboard?success=Password+reset");
});

router.post("/staff/set-active", (req, res) => {
  const userId = Number(req.body.user_id || 0);
  const isActive = String(req.body.is_active || "1") === "1" ? 1 : 0;
  if (!userId) return res.redirect("/admin/dashboard?error=Invalid+user+ID");

  const sessionUserId = Number((req.session.user || {}).id || 0);
  if (userId === sessionUserId && isActive !== 1) {
    return res.redirect("/admin/dashboard?error=Cannot+deactivate+your+own+account");
  }

  db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(isActive, userId);
  return res.redirect("/admin/dashboard?success=User+status+updated");
});

router.post("/users/update", (req, res) => {
  const userId = Number(req.body.user_id || 0);
  const username = String(req.body.username || "").trim();
  const displayName = String(req.body.display_name || "").trim();
  const { role, userType } = parseRoleAndType(req.body.role, req.body.user_type);
  const isActive = String(req.body.is_active || "1") === "1" ? 1 : 0;

  if (!userId || !username || !displayName) {
    return res.redirect("/admin/dashboard?error=Invalid+user+update+data");
  }

  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!existing) return res.redirect("/admin/dashboard?error=User+not+found");
  const duplicate = db.prepare("SELECT id FROM users WHERE username = ? AND id <> ?").get(username, userId);
  if (duplicate) return res.redirect("/admin/dashboard?error=USER+ID+already+used+by+another+account");

  const sessionUserId = Number((req.session.user || {}).id || 0);
  if (userId === sessionUserId && role !== "admin") {
    return res.redirect("/admin/dashboard?error=Cannot+change+your+own+admin+role");
  }
  if (userId === sessionUserId && isActive !== 1) {
    return res.redirect("/admin/dashboard?error=Cannot+deactivate+your+own+account");
  }

  db.prepare(
    `UPDATE users
     SET username = ?, display_name = ?, role = ?, user_type = ?, is_active = ?
     WHERE id = ?`
  ).run(username, displayName, role, userType, isActive, userId);

  return res.redirect("/admin/dashboard?success=User+account+updated");
});

router.post("/staff/import", uploadMemory.single("staff_csv"), (req, res) => {
  if (!req.file) return res.redirect("/admin/dashboard?error=CSV+file+required");

  let records;
  try {
    records = parse(req.file.buffer.toString("utf8"), { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`CSV parse failed: ${err.message}`)}`);
  }

  const findExisting = db.prepare("SELECT id FROM users WHERE username = ?");
  const insertUser = db.prepare(
    `INSERT INTO users (username, display_name, role, user_type, password_hash, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const summary = { inserted: 0, skipped: 0, failed: 0, errors: [] };
  const now = dayjs().toISOString();

  const tx = db.transaction((rows) => {
    for (let i = 0; i < rows.length; i += 1) {
      const rowNum = i + 2;
      const row = rows[i] || {};

      const userId = String(row.user_id || row.username || "").trim();
      const fullName = String(row.full_name || row.display_name || "").trim();
      const password = String(row.password || "");
      const roleRaw = String(row.role || "teacher").trim().toLowerCase();
      const role = ["admin", "teacher", "staff"].includes(roleRaw) ? roleRaw : "teacher";
      const userTypeRaw = String(row.user_type || row.member_type || roleRaw || "teacher").trim().toLowerCase();
      const userType = ["admin", "teacher", "staff"].includes(userTypeRaw)
        ? userTypeRaw
        : (role === "admin" ? "admin" : (role === "staff" ? "staff" : "teacher"));
      const isActive = String(row.is_active || "true").trim().toLowerCase();
      const isActiveFlag = ["1", "true", "yes", "y"].includes(isActive) ? 1 : 0;

      if (!userId || !fullName || !password) {
        summary.failed += 1;
        summary.errors.push(`Row ${rowNum}: required fields user_id, full_name, password`);
        continue;
      }

      if (findExisting.get(userId)) {
        summary.skipped += 1;
        summary.errors.push(`Row ${rowNum}: duplicate USER ID (${userId}) skipped`);
        continue;
      }

      try {
        insertUser.run(userId, fullName, role, userType, bcrypt.hashSync(password, 10), isActiveFlag, now);
        summary.inserted += 1;
      } catch (err) {
        summary.failed += 1;
        summary.errors.push(`Row ${rowNum}: ${err.message}`);
      }
    }
  });

  try {
    tx(records);
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Staff import failed: ${err.message}`)}`);
  }

  const errorText = summary.errors.slice(0, 6).join(" | ");
  const msg = `Staff import complete. Inserted: ${summary.inserted}. Skipped: ${summary.skipped}. Failed: ${summary.failed}${errorText ? `. ${errorText}` : ""}`;
  return res.redirect(`/admin/dashboard?success=${encodeURIComponent(msg)}`);
});

router.post("/students/add", photoUpload.single("photo_file"), (req, res) => {
  const classId = Number(req.body.class_id);
  const studentId = (req.body.student_id || "").trim();
  const familyId = (req.body.familyID || req.body.family_id || "").trim();
  const noSb = (req.body.no_sb || "").trim();
  const fullName = (req.body.full_name || "").trim();
  const nickname = (req.body.nickname || "").trim();
  const dob = req.body.dob;
  const gender = (req.body.gender || "").trim();
  const address = (req.body.address || "").trim();
  const studentStatus = (req.body.student_status || "active").trim().toLowerCase();
  const notes = (req.body.notes || "").trim();
  const photoUrl = (req.body.photo_url || "").trim();
  const photoPath = normalizePhotoPath(req.file);
  const emergencyContact = (req.body.emergency_contact || "").trim();

  if (!classId || !studentId || !noSb || !fullName || !nickname || !dob || !emergencyContact) {
    return res.status(400).send("Required fields missing");
  }

  const now = dayjs().toISOString();

  const info = db.prepare(
    `INSERT INTO students
     (student_id, family_id, no_sb, student_code, full_name, nickname, dob, gender, address, student_status, notes, photo_url, photo_path, emergency_contact, siblings_json, class_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    studentId,
    familyId || null,
    noSb,
    studentId,
    fullName,
    nickname,
    dob,
    gender || null,
    address || null,
    studentStatus || "active",
    notes || null,
    photoUrl,
    photoPath || null,
    emergencyContact,
    "[]",
    classId,
    now
  );

  const newStudentPk = Number(info.lastInsertRowid);
  const linkSibling = db.prepare(
    `INSERT INTO student_siblings (student_pk, sibling_student_pk, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(student_pk, sibling_student_pk) DO NOTHING`
  );
  const findByFamily = db.prepare("SELECT id FROM students WHERE family_id = ?");

  syncFamilyLinks(newStudentPk, familyId, now, linkSibling, findByFamily);

  res.redirect("/admin/dashboard?success=Student+added");
});

router.post("/students/import", uploadMemory.single("students_csv"), (req, res) => {
  if (!req.file) return res.status(400).send("CSV file required");

  const content = req.file.buffer.toString("utf8");
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });

  const insertIgnore = db.prepare(
    `INSERT OR IGNORE INTO students
     (student_id, family_id, no_sb, student_code, full_name, nickname, dob, gender, address, student_status, notes, photo_url, photo_path, emergency_contact, siblings_json, class_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateByStudentId = db.prepare(
    `UPDATE students
     SET family_id = ?, no_sb = ?, student_code = ?, full_name = ?, nickname = ?, dob = ?, gender = ?, address = ?, student_status = ?, notes = ?, photo_url = ?, photo_path = ?, emergency_contact = ?, class_id = ?
     WHERE student_id = ?`
  );

  const findClass = db.prepare("SELECT id FROM classes WHERE name = ?");
  const findPkByStudentId = db.prepare("SELECT id FROM students WHERE student_id = ?");
  const linkSibling = db.prepare(
    `INSERT INTO student_siblings (student_pk, sibling_student_pk, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(student_pk, sibling_student_pk) DO NOTHING`
  );
  const findByFamily = db.prepare("SELECT id FROM students WHERE family_id = ?");

  const now = dayjs().toISOString();

  const tx = db.transaction((rows) => {
    const pendingLinks = [];
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const className = (row.class_name || row.Class || row.class || "").trim();
      const cls = findClass.get(className);
      if (!cls) {
        skipped += 1;
        continue;
      }

      const externalStudentId = (row.student_id || "").trim();
      const familyId = (row.familyID || row.family_id || "").trim();
      if (!externalStudentId) {
        skipped += 1;
        continue;
      }

      const noSb = (row["No.SB"] || row.no_sb || externalStudentId).trim();
      const fullName = (row.full_name || externalStudentId).trim();
      const nickname = (row.nickname || externalStudentId).trim();
      const dob = (row.dob || "2017-01-01").trim();
      const emergencyContact = (row.emergency_contact || "-").trim();
      const csvPhotoPath = (row.photo_path || "").trim();

      const insertResult = insertIgnore.run(
        externalStudentId,
        familyId || null,
        noSb,
        externalStudentId,
        fullName,
        nickname,
        dob,
        (row.gender || "").trim() || null,
        (row.address || "").trim() || null,
        ((row.student_status || "active").trim().toLowerCase()) || "active",
        (row.notes || "").trim() || null,
        row.photo_url || "",
        csvPhotoPath || null,
        emergencyContact,
        "[]",
        cls.id,
        now
      );

      if (insertResult.changes === 0) {
        updateByStudentId.run(
          familyId || null,
          noSb,
          externalStudentId,
          fullName,
          nickname,
          dob,
          (row.gender || "").trim() || null,
          (row.address || "").trim() || null,
          ((row.student_status || "active").trim().toLowerCase()) || "active",
          (row.notes || "").trim() || null,
          row.photo_url || "",
          csvPhotoPath || null,
          emergencyContact,
          cls.id,
          externalStudentId
        );
        updated += 1;
      } else {
        imported += 1;
      }

      pendingLinks.push({ studentId: externalStudentId, familyId });
    }

    for (const pending of pendingLinks) {
      const source = findPkByStudentId.get(pending.studentId);
      if (!source) continue;
      syncFamilyLinks(source.id, pending.familyId, now, linkSibling, findByFamily);
    }

    return { imported, updated, skipped };
  });

  try {
    const result = tx(records);
    const msg = `Students imported: ${result.imported}. Updated: ${result.updated}. Skipped: ${result.skipped}`;
    res.redirect(`/admin/dashboard?success=${encodeURIComponent(msg)}`);
  } catch (err) {
    res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Import failed: ${err.message}`)}`);
  }
});

router.post("/students/update/:studentPk", photoUpload.single("photo_file"), (req, res) => {
  try {
    const studentPk = Number(req.params.studentPk);
    const classId = Number(req.body.class_id);
    const studentId = (req.body.student_id || "").trim();
    const familyId = (req.body.familyID || req.body.family_id || "").trim();
    const noSb = (req.body.no_sb || "").trim();
    const fullName = (req.body.full_name || "").trim();
    const nickname = (req.body.nickname || "").trim();
    const dob = (req.body.dob || "").trim();
    const gender = (req.body.gender || "").trim();
    const address = (req.body.address || "").trim();
    const studentStatus = (req.body.student_status || "active").trim().toLowerCase();
    const notes = (req.body.notes || "").trim();
    const photoUrl = (req.body.photo_url || "").trim();
    const emergencyContact = (req.body.emergency_contact || "").trim();
    const uploadedPhotoPath = normalizePhotoPath(req.file);

    if (!studentPk || !classId || !studentId || !noSb || !fullName || !nickname || !dob || !emergencyContact) {
      return res.redirect(`/admin/dashboard?error=Required+fields+missing&class_id=${classId || ""}&student_pk=${studentPk || ""}`);
    }

    const existing = db.prepare("SELECT id, photo_path FROM students WHERE id = ?").get(studentPk);
    if (!existing) {
      return res.redirect("/admin/dashboard?error=Student+not+found");
    }

    const now = dayjs().toISOString();
    const classNameRow = db.prepare("SELECT name FROM classes WHERE id = ?").get(classId);
    const updateStudent = db.prepare(
      `UPDATE students
       SET class_id = ?, student_id = ?, family_id = ?, student_code = ?, no_sb = ?, full_name = ?, nickname = ?, dob = ?, gender = ?, address = ?, student_status = ?, notes = ?, photo_url = ?, photo_path = ?, emergency_contact = ?
       WHERE id = ?`
    );
    const deleteSiblingLinks = db.prepare("DELETE FROM student_siblings WHERE student_pk = ? OR sibling_student_pk = ?");
    const linkSibling = db.prepare(
      `INSERT INTO student_siblings (student_pk, sibling_student_pk, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(student_pk, sibling_student_pk) DO NOTHING`
    );
    const findByFamily = db.prepare("SELECT id FROM students WHERE family_id = ?");

    const finalPhotoPath = uploadedPhotoPath || (req.body.existing_photo_path || "").trim() || null;

    const tx = db.transaction(() => {
      updateStudent.run(
        classId,
        studentId,
        familyId || null,
        studentId,
        noSb,
        fullName,
        nickname,
        dob,
        gender || null,
        address || null,
        studentStatus || "active",
        notes || null,
        photoUrl,
        finalPhotoPath,
        emergencyContact,
        studentPk
      );

      if (uploadedPhotoPath && existing.photo_path && existing.photo_path !== uploadedPhotoPath) {
        removeManagedPhotoIfExists(existing.photo_path);
      }

      deleteSiblingLinks.run(studentPk, studentPk);
      syncFamilyLinks(studentPk, familyId, now, linkSibling, findByFamily);
    });

    tx();
    const className = classNameRow ? classNameRow.name : `Class ${classId}`;
    const successMsg = `Student updated: ${nickname} (${fullName}) in ${className}`;
    return res.redirect(
      `/admin/dashboard?success=${encodeURIComponent(successMsg)}&class_id=${encodeURIComponent(classId)}&student_pk=${encodeURIComponent(
        studentPk
      )}`
    );
  } catch (err) {
    const studentPk = Number(req.params.studentPk) || "";
    const classId = Number(req.body.class_id) || "";
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Update failed: ${err.message}`)}&class_id=${classId}&student_pk=${studentPk}`);
  }
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

router.post("/backup/restore", uploadMemory.single("backup_file"), (req, res) => {
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
      db.exec("DELETE FROM calendar_event_users");
      db.exec("DELETE FROM calendar_event_labels");
      db.exec("DELETE FROM calendar_labels");
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
      insertRows("calendar_labels", BACKUP_TABLES.calendar_labels, backupData.calendar_labels || []);
      insertRows("calendar_event_labels", BACKUP_TABLES.calendar_event_labels, backupData.calendar_event_labels || []);
      insertRows("calendar_event_users", BACKUP_TABLES.calendar_event_users, backupData.calendar_event_users || []);

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

router.post("/calendar/delete/:eventId", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.redirect("/admin/dashboard?error=Invalid+event+ID");

  const target = db.prepare("SELECT id, event_source FROM calendar_events WHERE id = ? AND is_deleted = 0").get(eventId);
  if (!target) return res.redirect("/admin/dashboard?error=Event+not+found");
  if ((target.event_source || "manual") !== "manual") {
    return res.redirect("/admin/dashboard?error=System+events+cannot+be+deleted");
  }

  db.prepare(
    `UPDATE calendar_events
     SET is_deleted = 1, deleted_by = ?, deleted_at = ?
     WHERE id = ? AND is_deleted = 0`
  ).run(req.session.user.id, dayjs().toISOString(), eventId);

  return res.redirect("/admin/dashboard?success=Event+deleted");
});
router.post("/events/purge/:eventId", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.redirect("/admin/dashboard?error=Invalid+event+ID");

  db.prepare("DELETE FROM calendar_events WHERE id = ? AND is_deleted = 1").run(eventId);
  return res.redirect("/admin/dashboard?success=Deleted+event+removed+permanently");
});

function isValidIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function buildInClause(values) {
  const placeholders = values.map(() => "?").join(", ");
  return `(${placeholders})`;
}

router.post("/points/reset", (req, res) => {
  try {
    const selectedClassId = Number(req.body.class_id || 0);
    const includeAllStudents = String(req.body.scope_all_students || "") === "1";
    const includeWholeClassRaw = String(req.body.scope_whole_class || "") === "1";
    const includeSelectedStudentsRaw = String(req.body.scope_selected_students || "") === "1";
    const includeWholeClass = !includeAllStudents && includeWholeClassRaw;
    const includeSelectedStudents = !includeAllStudents && includeSelectedStudentsRaw;
    const selectedStudentsRaw = req.body.selected_students;
    const includeAllTime = String(req.body.filter_all_time || "") === "1";
    const includeSpecificDate = String(req.body.filter_specific_date || "") === "1";
    const includeDateRange = String(req.body.filter_date_range || "") === "1";
    const selectedDate = String(req.body.selected_date || "").trim();
    let rangeStart = String(req.body.range_start || "").trim();
    let rangeEnd = String(req.body.range_end || "").trim();

    if (!includeAllStudents && !includeWholeClass && !includeSelectedStudents) {
      return res.redirect("/admin/dashboard?error=Select+at+least+one+target+scope");
    }
    if ((includeWholeClass || includeSelectedStudents) && !selectedClassId) {
      return res.redirect("/admin/dashboard?error=Class+is+required+for+point+reset");
    }
    if (!includeAllTime && !includeSpecificDate && !includeDateRange) {
      return res.redirect("/admin/dashboard?error=Select+at+least+one+time+filter");
    }

    const targetStudentIds = new Set();
    if (includeAllStudents) {
      const allStudents = db.prepare("SELECT id FROM students").all();
      allStudents.forEach((s) => targetStudentIds.add(Number(s.id)));
    }
    if (includeWholeClass) {
      const classStudents = db.prepare("SELECT id FROM students WHERE class_id = ?").all(selectedClassId);
      classStudents.forEach((s) => targetStudentIds.add(Number(s.id)));
    }
    if (includeSelectedStudents) {
      const normalized = Array.isArray(selectedStudentsRaw)
        ? selectedStudentsRaw
        : (selectedStudentsRaw ? [selectedStudentsRaw] : []);
      const isStudentInClass = db.prepare("SELECT id FROM students WHERE id = ? AND class_id = ? LIMIT 1");
      normalized
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0)
        .forEach((v) => {
          if (includeAllStudents || isStudentInClass.get(v, selectedClassId)) {
            targetStudentIds.add(v);
          }
        });
    }

    const targetIds = Array.from(targetStudentIds);
    if (!targetIds.length) {
      return res.redirect("/admin/dashboard?error=No+students+matched+the+selected+scope");
    }

    const studentWhere = `student_id IN ${buildInClause(targetIds)}`;
    const timeConditions = [];
    const timeArgs = [];

    if (includeSpecificDate) {
      if (!isValidIsoDate(selectedDate)) {
        return res.redirect("/admin/dashboard?error=Valid+specific+date+is+required+%28YYYY-MM-DD%29");
      }
      timeConditions.push("date(awarded_at) = ?");
      timeArgs.push(selectedDate);
    }
    if (includeDateRange) {
      if (!isValidIsoDate(rangeStart) || !isValidIsoDate(rangeEnd)) {
        return res.redirect("/admin/dashboard?error=Valid+date+range+is+required+%28YYYY-MM-DD%29");
      }
      if (rangeStart > rangeEnd) {
        const temp = rangeStart;
        rangeStart = rangeEnd;
        rangeEnd = temp;
      }
      timeConditions.push("date(awarded_at) BETWEEN ? AND ?");
      timeArgs.push(rangeStart, rangeEnd);
    }

    const whereSql = includeAllTime
      ? studentWhere
      : `${studentWhere} AND (${timeConditions.join(" OR ")})`;
    const whereArgs = includeAllTime ? [...targetIds] : [...targetIds, ...timeArgs];

    const selectAffectedStudents = db.prepare(`SELECT DISTINCT student_id FROM point_logs WHERE ${whereSql}`);
    const countTargetLogs = db.prepare(`SELECT COUNT(*) AS total FROM point_logs WHERE ${whereSql}`);
    const deleteTargetLogs = db.prepare(`DELETE FROM point_logs WHERE ${whereSql}`);
    const deleteDailyForStudents = db.prepare(`DELETE FROM daily_points WHERE student_id IN ${buildInClause(targetIds)}`);
    const rebuildDailyForStudents = db.prepare(
      `INSERT INTO daily_points (snapshot_date, student_id, total_points, last_updated_at)
       SELECT date(awarded_at) AS snapshot_date, student_id, SUM(points) AS total_points, ? AS last_updated_at
       FROM point_logs
       WHERE student_id IN ${buildInClause(targetIds)}
       GROUP BY date(awarded_at), student_id`
    );

    const nowIso = dayjs().toISOString();
    const tx = db.transaction(() => {
      const beforeCount = Number(countTargetLogs.get(...whereArgs).total || 0);
      const affectedStudents = selectAffectedStudents.all(...whereArgs).map((r) => Number(r.student_id));
      deleteTargetLogs.run(...whereArgs);
      deleteDailyForStudents.run(...targetIds);
      rebuildDailyForStudents.run(nowIso, ...targetIds);
      return { beforeCount, affectedStudentCount: affectedStudents.length };
    });

    const result = tx();
    const selectedScopes = [
      includeAllStudents ? "all students" : null,
      includeWholeClass ? `class ${selectedClassId}` : null,
      includeSelectedStudents ? "selected students" : null
    ].filter(Boolean).join(", ");
    const selectedTime = includeAllTime
      ? "all time"
      : [
          includeSpecificDate ? `date ${selectedDate}` : null,
          includeDateRange ? `range ${rangeStart} to ${rangeEnd}` : null
        ].filter(Boolean).join(" OR ");
    const success = `Points reset complete. Deleted ${result.beforeCount} log entries for ${result.affectedStudentCount} student(s). Scope: ${selectedScopes}. Time: ${selectedTime}.`;
    return res.redirect(`/admin/dashboard?success=${encodeURIComponent(success)}&class_id=${encodeURIComponent(selectedClassId)}`);
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Point reset failed: ${err.message}`)}`);
  }
});
router.use((err, req, res, next) => {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    return res.redirect("/admin/dashboard?error=" + encodeURIComponent("Upload failed: " + err.message));
  }
  if (String(err.message || "").includes("Only image files are allowed")) {
    return res.redirect("/admin/dashboard?error=" + encodeURIComponent("Upload failed: only image files are allowed"));
  }

  return next(err);
});
module.exports = router;






















