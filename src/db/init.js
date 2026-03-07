const bcrypt = require("bcryptjs");
const dayjs = require("dayjs");
const db = require("./database");

function getColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','teacher','staff')),
      user_type TEXT NOT NULL DEFAULT 'teacher',
      password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT,
      family_id TEXT,
      no_sb TEXT,
      student_code TEXT,
      full_name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      dob TEXT NOT NULL,
      gender TEXT,
      address TEXT,
      student_status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      photo_url TEXT,
      photo_path TEXT,
      emergency_contact TEXT NOT NULL,
      siblings_json TEXT,
      class_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (class_id) REFERENCES classes(id)
    );

    CREATE TABLE IF NOT EXISTS student_siblings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_pk INTEGER NOT NULL,
      sibling_student_pk INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(student_pk, sibling_student_pk),
      FOREIGN KEY (student_pk) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (sibling_student_pk) REFERENCES students(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS point_reasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT UNIQUE NOT NULL,
      created_by INTEGER,
      is_custom INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS point_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      points INTEGER NOT NULL,
      reason TEXT NOT NULL,
      awarded_by INTEGER NOT NULL,
      awarded_at TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (class_id) REFERENCES classes(id),
      FOREIGN KEY (awarded_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS daily_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      student_id INTEGER NOT NULL,
      total_points INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      UNIQUE(snapshot_date, student_id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      details TEXT,
      event_date TEXT NOT NULL,
      end_date TEXT,
      event_source TEXT NOT NULL DEFAULT 'manual',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by INTEGER,
      deleted_at TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (deleted_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS calendar_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      color TEXT NOT NULL,
      description TEXT,
      created_by INTEGER,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS calendar_event_labels (
      event_id INTEGER NOT NULL,
      label_id INTEGER NOT NULL,
      PRIMARY KEY (event_id, label_id),
      FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
      FOREIGN KEY (label_id) REFERENCES calendar_labels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS calendar_event_users (
      event_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (event_id, user_id),
      FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}
function migrateUsersTable() {
  const cols = getColumns("users");

  if (!cols.includes("is_active")) {
    db.exec("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.includes("user_type")) {
    db.exec("ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'teacher'");
  }

  db.exec("UPDATE users SET is_active = 1 WHERE is_active IS NULL");
  db.exec("UPDATE users SET user_type = CASE WHEN role = 'admin' THEN 'admin' WHEN role = 'staff' THEN 'staff' ELSE 'teacher' END WHERE user_type IS NULL OR TRIM(user_type) = ''");
}
function migrateStudentsTable() {
  const cols = getColumns("students");

  if (!cols.includes("student_id")) {
    db.exec("ALTER TABLE students ADD COLUMN student_id TEXT");
  }
  if (!cols.includes("family_id")) {
    db.exec("ALTER TABLE students ADD COLUMN family_id TEXT");
  }
  if (!cols.includes("no_sb")) {
    db.exec("ALTER TABLE students ADD COLUMN no_sb TEXT");
  }
  if (!cols.includes("gender")) {
    db.exec("ALTER TABLE students ADD COLUMN gender TEXT");
  }
  if (!cols.includes("address")) {
    db.exec("ALTER TABLE students ADD COLUMN address TEXT");
  }
  if (!cols.includes("student_status")) {
    db.exec("ALTER TABLE students ADD COLUMN student_status TEXT");
  }
  if (!cols.includes("notes")) {
    db.exec("ALTER TABLE students ADD COLUMN notes TEXT");
  }
  if (!cols.includes("photo_path")) {
    db.exec("ALTER TABLE students ADD COLUMN photo_path TEXT");
  }

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_students_student_id ON students(student_id)");

  const hasStudentCode = getColumns("students").includes("student_code");
  if (hasStudentCode) {
    db.exec("UPDATE students SET student_id = COALESCE(student_id, student_code) WHERE student_id IS NULL OR student_id = ''");
  }

  const missing = db.prepare("SELECT id FROM students WHERE student_id IS NULL OR student_id = '' ORDER BY id ASC").all();
  const setStudentId = db.prepare("UPDATE students SET student_id = ? WHERE id = ?");
  const setNoSb = db.prepare("UPDATE students SET no_sb = ? WHERE id = ?");

  for (const row of missing) {
    setStudentId.run(`STU${String(row.id).padStart(4, "0")}`, row.id);
  }

  const noSbMissing = db.prepare("SELECT id FROM students WHERE no_sb IS NULL OR no_sb = '' ORDER BY id ASC").all();
  for (const row of noSbMissing) {
    setNoSb.run(`NSB${String(row.id).padStart(4, "0")}`, row.id);
  }

  db.exec("UPDATE students SET student_status = 'active' WHERE student_status IS NULL OR TRIM(student_status) = ''");
}

function migrateCalendarEventsTable() {
  const cols = getColumns("calendar_events");
  if (!cols.includes("end_date")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN end_date TEXT");
  }
  if (!cols.includes("event_source")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN event_source TEXT");
  }
  db.exec("UPDATE calendar_events SET event_source = 'manual' WHERE event_source IS NULL OR TRIM(event_source) = ''");
  db.exec("UPDATE calendar_events SET end_date = event_date WHERE end_date IS NULL OR TRIM(end_date) = ''");
}

function seedCalendarLabels() {
  const now = dayjs().toISOString();
  const defaults = [
    { name: "Public Holiday", color: "#e74c3c", description: "National/public holiday" },
    { name: "Cuti Penggal", color: "#f39c12", description: "School term break" },
    { name: "Birthday", color: "#f1c40f", description: "Student birthday" },
    { name: "PD", color: "#2ecc71", description: "Professional development" },
    { name: "Meeting", color: "#3498db", description: "Meeting" },
    { name: "Taklimat", color: "#9b59b6", description: "Briefing / Taklimat" },
    { name: "School Event", color: "#1abc9c", description: "School event" },
    { name: "Assessment", color: "#e67e22", description: "Assessment" },
    { name: "Dateline", color: "#e84393", description: "Deadline / dateline" }
  ];

  const insert = db.prepare(
    `INSERT INTO calendar_labels (name, color, description, created_by, is_system, created_at)
     VALUES (?, ?, ?, NULL, 1, ?)
     ON CONFLICT(name) DO UPDATE SET color = excluded.color, description = excluded.description`
  );

  for (const label of defaults) {
    insert.run(label.name, label.color, label.description, now);
  }
}

function migrateSiblingsToRelation() {
  const relationCount = db.prepare("SELECT COUNT(*) AS count FROM student_siblings").get().count;
  if (relationCount > 0) return;

  const rows = db.prepare("SELECT id, class_id, siblings_json FROM students WHERE siblings_json IS NOT NULL AND TRIM(siblings_json) <> ''").all();
  const findByName = db.prepare("SELECT id FROM students WHERE full_name = ? LIMIT 1");
  const findByNameClass = db.prepare("SELECT id FROM students WHERE full_name = ? AND class_id = ? LIMIT 1");
  const insertRel = db.prepare(
    `INSERT INTO student_siblings (student_pk, sibling_student_pk, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(student_pk, sibling_student_pk) DO NOTHING`
  );
  const now = dayjs().toISOString();

  for (const row of rows) {
    let parsed = [];
    try {
      parsed = JSON.parse(row.siblings_json);
    } catch {
      parsed = [];
    }
    for (const s of parsed) {
      if (!s || !s.name) continue;
      const target = findByNameClass.get(s.name, row.class_id) || findByName.get(s.name);
      if (!target || target.id === row.id) continue;
      insertRel.run(row.id, target.id, now);
      insertRel.run(target.id, row.id, now);
    }
  }
}

function migrateClassNames() {
  const desired = ["PRA", "YEAR 1", "YEAR 2", "YEAR 3", "YEAR 4", "YEAR 5", "YEAR 6"];
  const byName = db.prepare("SELECT id, name FROM classes WHERE name = ?");
  const rename = db.prepare("UPDATE classes SET name = ? WHERE id = ?");
  const reassignStudents = db.prepare("UPDATE students SET class_id = ? WHERE class_id = ?");
  const removeClass = db.prepare("DELETE FROM classes WHERE id = ?");

  const legacyMap = {
    "Year 1 Amanah": "YEAR 1",
    "Year 2 Bestari": "YEAR 2",
    "Year 3 Cemerlang": "YEAR 3",
    "Year 4 Dinamik": "YEAR 4"
  };

  for (const [oldName, newName] of Object.entries(legacyMap)) {
    const oldClass = byName.get(oldName);
    if (!oldClass) continue;

    const targetClass = byName.get(newName);
    if (targetClass) {
      reassignStudents.run(targetClass.id, oldClass.id);
      removeClass.run(oldClass.id);
    } else {
      rename.run(newName, oldClass.id);
    }
  }

  const regexYear = /^Year\s+([1-6])\b/i;
  const classes = db.prepare("SELECT id, name FROM classes").all();
  for (const c of classes) {
    const match = String(c.name || "").match(regexYear);
    if (!match) continue;
    const targetName = "YEAR " + match[1];
    if (!desired.includes(targetName)) continue;

    const target = byName.get(targetName);
    if (target && target.id !== c.id) {
      reassignStudents.run(target.id, c.id);
      removeClass.run(c.id);
    } else if (!target) {
      rename.run(targetName, c.id);
    }
  }

  const insertClass = db.prepare("INSERT OR IGNORE INTO classes (name) VALUES (?)");
  desired.forEach((name) => insertClass.run(name));
}
function seedDefaults() {
  const now = dayjs().toISOString();

  const hasUsers = db.prepare("SELECT COUNT(*) as count FROM users").get().count > 0;
  if (!hasUsers) {
    const insertUser = db.prepare(
      "INSERT INTO users (username, display_name, role, user_type, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    insertUser.run("admin", "School Admin", "admin", "admin", bcrypt.hashSync("117911Zam", 10), 1, now);
    insertUser.run("hizemrie", "hizemrie", "teacher", "teacher", bcrypt.hashSync("eirmezih", 10), 1, now);
  }

  const classNames = ["PRA", "YEAR 1", "YEAR 2", "YEAR 3", "YEAR 4", "YEAR 5", "YEAR 6"];
  const insertClass = db.prepare("INSERT OR IGNORE INTO classes (name) VALUES (?)");
  classNames.forEach((name) => insertClass.run(name));

  const hasReasons = db.prepare("SELECT COUNT(*) as count FROM point_reasons").get().count > 0;
  if (!hasReasons) {
    const insertReason = db.prepare(
      "INSERT INTO point_reasons (reason, created_by, is_custom, created_at) VALUES (?, NULL, 0, ?)"
    );
    ["Homework completed", "Good behavior", "Helped classmate", "Late submission", "Class disruption"].forEach((reason) => {
      insertReason.run(reason, now);
    });
  }

  const shouldSeedMockStudents = process.env.SEED_MOCK_STUDENTS === "1";
  const hasStudents = db.prepare("SELECT COUNT(*) as count FROM students").get().count > 0;
  if (shouldSeedMockStudents && !hasStudents) {
    const classes = db.prepare("SELECT id, name FROM classes ORDER BY id").all();
    const insertStudent = db.prepare(
      `INSERT INTO students
       (student_id, family_id, no_sb, student_code, full_name, nickname, dob, gender, address, student_status, notes, photo_url, photo_path, emergency_contact, siblings_json, class_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const first = ["Aiman", "Siti", "Nur", "Amir", "Haziq", "Nadia", "Faris", "Izzah", "Danish", "Alya"];
    const last = ["Ahmad", "Brahim", "Jamil", "Kassim", "Rahman", "Salleh", "Yusof", "Hakim", "Razak", "Musa"];

    let counter = 1;
    for (const c of classes) {
      for (let i = 0; i < 12; i += 1) {
        const fullName = `${first[i % first.length]} ${last[(i + c.id) % last.length]}`;
        const nickname = `${first[i % first.length]}${counter}`;
        const externalStudentId = `STU${String(counter).padStart(4, "0")}`;
        const noSb = `NSB${String(counter).padStart(4, "0")}`;
        const dob = dayjs("2017-01-01").add(counter % 1500, "day").format("YYYY-MM-DD");
        insertStudent.run(
          externalStudentId,
          `FAM${String(Math.ceil(counter / 2)).padStart(3, "0")}`,
          noSb,
          externalStudentId,
          fullName,
          nickname,
          dob,
          counter % 2 === 0 ? "Male" : "Female",
          `Kg. Mock ${((counter - 1) % 7) + 1}, Tutong`,
          "active",
          "",
          `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(nickname)}`,
          null,
          `+673-8${String(100000 + counter).slice(-6)}`,
          "[]",
          c.id,
          now
        );
        counter += 1;
      }
    }
  }

  const shouldSeedMockEvents = process.env.SEED_MOCK_EVENTS === "1";
  const hasEvents = db.prepare("SELECT COUNT(*) as count FROM calendar_events").get().count > 0;
  if (shouldSeedMockEvents && !hasEvents) {
    const teacher = db.prepare("SELECT id FROM users WHERE username = ?").get("hizemrie");
    const insertEvent = db.prepare(
      `INSERT INTO calendar_events
       (title, details, event_date, end_date, created_by, created_at, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    );
    [
      { title: "Assembly Briefing", details: "Morning updates", offset: 0, span: 1 },
      { title: "Homework Deadline", details: "Math workbook", offset: 1, span: 1 },
      { title: "Sports Practice", details: "Field session", offset: 3, span: 2 },
      { title: "Reading Assessment", details: "Library room", offset: 5, span: 1 },
      { title: "Parent Check-in", details: "Phone call round", offset: 7, span: 1 }
    ].forEach((e) => {
      const start = dayjs().add(e.offset, "day");
      insertEvent.run(
        e.title,
        e.details,
        start.format("YYYY-MM-DD"),
        start.add(e.span - 1, "day").format("YYYY-MM-DD"),
        teacher.id,
        now
      );
    });
  }
}

function updateDailySnapshot(studentId) {
  const snapshotDate = dayjs().format("YYYY-MM-DD");
  const totalPoints = db
    .prepare("SELECT COALESCE(SUM(points), 0) AS total FROM point_logs WHERE student_id = ?")
    .get(studentId).total;

  db.prepare(
    `INSERT INTO daily_points (snapshot_date, student_id, total_points, last_updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(snapshot_date, student_id)
     DO UPDATE SET total_points = excluded.total_points, last_updated_at = excluded.last_updated_at`
  ).run(snapshotDate, studentId, totalPoints, dayjs().toISOString());
}

function initializeDatabase() {
  createTables();
  migrateUsersTable();
  migrateStudentsTable();
  migrateCalendarEventsTable();
  migrateClassNames();
  migrateSiblingsToRelation();
  seedDefaults();
  seedCalendarLabels();
}

module.exports = {
  db,
  initializeDatabase,
  updateDailySnapshot
};





















