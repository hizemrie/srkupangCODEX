const express = require("express");
const dayjs = require("dayjs");
const { db, updateDailySnapshot } = require("../db/init");
const { requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireRole(["teacher", "staff"]));

function normalizeHexColor(input, fallback = "#3f6fae") {
  const raw = String(input || "").trim();
  const shortMatch = raw.match(/^#([0-9a-fA-F]{3})$/);
  if (shortMatch) {
    const m = shortMatch[1];
    return `#${m[0]}${m[0]}${m[1]}${m[1]}${m[2]}${m[2]}`.toLowerCase();
  }
  const longMatch = raw.match(/^#([0-9a-fA-F]{6})$/);
  if (longMatch) return `#${longMatch[1].toLowerCase()}`;
  return fallback;
}

function parseLabelIds(raw) {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const ids = values
    .flatMap((v) => String(v).split(","))
    .map((v) => Number(String(v).trim()))
    .filter((v) => Number.isInteger(v) && v > 0);
  return Array.from(new Set(ids));
}

function parseLabelsRaw(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  const out = [];
  for (const chunk of s.split("||")) {
    const [id, name, color, description] = chunk.split("::");
    if (!id || !name) continue;
    out.push({
      id: Number(id),
      name,
      color: normalizeHexColor(color, "#3f6fae"),
      description: description || ""
    });
  }
  return out;
}

function parseTaggedUsersRaw(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  const out = [];
  for (const chunk of s.split("||")) {
    const parts = chunk.split("::");
    if (parts.length < 4) continue;
    const id = Number(parts[0]);
    const userId = parts[1];
    const displayName = parts[2];
    const role = parts[3];
    if (!id || !userId) continue;
    out.push({ id, user_id: userId, display_name: displayName || userId, role: role || "teacher" });
  }
  return out;
}

function listStaffUsers() {
  return db
    .prepare(
      `SELECT id, username AS user_id, email, display_name, CASE WHEN role = 'teacher' AND COALESCE(user_type, 'teacher') = 'staff' THEN 'staff' ELSE role END AS role
       FROM users
       WHERE (role = 'teacher' OR role = 'staff') AND COALESCE(is_active, 1) = 1
       ORDER BY display_name ASC, username ASC`
    )
    .all();
}

function getTaggableUserSets() {
  const rows = db
    .prepare(
      `SELECT id, role, COALESCE(user_type, CASE WHEN role = 'staff' THEN 'staff' WHEN role = 'admin' THEN 'admin' ELSE 'teacher' END) AS user_type
       FROM users
       WHERE (role = 'teacher' OR role = 'staff') AND COALESCE(is_active, 1) = 1`
    )
    .all();

  const allIds = [];
  const teacherIds = [];
  const staffIds = [];

  for (const r of rows) {
    const id = Number(r.id);
    if (!id) continue;
    allIds.push(id);
    if (String(r.user_type || 'teacher') === 'staff') {
      staffIds.push(id);
    } else {
      teacherIds.push(id);
    }
  }

  return {
    allIds,
    teacherIds,
    staffIds,
    allSet: new Set(allIds),
    teacherSet: new Set(teacherIds),
    staffSet: new Set(staffIds)
  };
}

function resolveTaggedUserIds(scopeRaw, teacherRaw, staffRaw) {
  const scope = String(scopeRaw || '').trim().toLowerCase();
  const teacherPicked = parseLabelIds(teacherRaw);
  const staffPicked = parseLabelIds(staffRaw);
  const sets = getTaggableUserSets();

  if (scope === 'all') return sets.allIds;
  if (scope === 'all_teachers') return sets.teacherIds;
  if (scope === 'all_staffs') return sets.staffIds;
  if (scope === 'teachers') return teacherPicked.filter((id) => sets.teacherSet.has(id));
  if (scope === 'staffs') return staffPicked.filter((id) => sets.staffSet.has(id));
  return [];
}
function assignEventTaggedUsers(eventId, userIds) {
  const ids = Array.from(new Set((userIds || []).filter((v) => Number.isInteger(v) && v > 0)));
  const del = db.prepare("DELETE FROM calendar_event_users WHERE event_id = ?");
  const ins = db.prepare("INSERT INTO calendar_event_users (event_id, user_id) VALUES (?, ?)");

  const tx = db.transaction(() => {
    del.run(eventId);
    if (!ids.length) return;

    const placeholders = ids.map(() => "?").join(",");
    const valid = db
      .prepare(`SELECT id FROM users WHERE id IN (${placeholders}) AND role IN ('teacher','staff')`)
      .all(...ids)
      .map((r) => Number(r.id));

    for (const userId of valid) {
      ins.run(eventId, userId);
    }
  });

  tx();
}

function listCalendarLabels() {
  return db
    .prepare(
      `SELECT id, name, color, COALESCE(description, '') AS description, is_system
       FROM calendar_labels
       ORDER BY is_system DESC, name ASC`
    )
    .all()
    .map((l) => ({ ...l, color: normalizeHexColor(l.color, "#3f6fae") }));
}

function assignEventLabels(eventId, labelIds) {
  const ids = Array.from(new Set((labelIds || []).filter((v) => Number.isInteger(v) && v > 0)));
  const del = db.prepare("DELETE FROM calendar_event_labels WHERE event_id = ?");
  const ins = db.prepare("INSERT INTO calendar_event_labels (event_id, label_id) VALUES (?, ?)");

  const tx = db.transaction(() => {
    del.run(eventId);
    if (!ids.length) return;

    const placeholders = ids.map(() => "?").join(",");
    const valid = db
      .prepare(`SELECT id FROM calendar_labels WHERE id IN (${placeholders})`)
      .all(...ids)
      .map((r) => Number(r.id));

    for (const labelId of valid) {
      ins.run(eventId, labelId);
    }
  });

  tx();
}

function getCalendarRange(monthQuery) {
  const monthStr = String(monthQuery || "").trim();
  const isMonthQueryValid = /^\d{4}-\d{2}$/.test(monthStr);
  const monthBase = isMonthQueryValid ? dayjs(`${monthStr}-01`) : dayjs().startOf("month");
  const monthStart = monthBase.isValid() ? monthBase.startOf("month") : dayjs().startOf("month");

  const offsetFromMonday = (monthStart.day() + 6) % 7;
  const gridStart = monthStart.subtract(offsetFromMonday, "day");
  const gridEnd = gridStart.add(41, "day");

  return { monthStart, gridStart, gridEnd };
}

function parseStudentDobDayMonth(rawDob) {
  const dob = String(rawDob || "").trim();
  if (!dob) return null;

  let day;
  let month;

  let m = dob.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    day = Number(m[1]);
    month = Number(m[2]);
  } else {
    m = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    month = Number(m[2]);
    day = Number(m[3]);
  }

  if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  return { day, month };
}

function fetchManualEvents({ rangeStart, rangeEnd, allActive = false }) {
  const baseQuery = `
    SELECT
      ce.id,
      ce.title,
      ce.details,
      ce.event_date,
      COALESCE(ce.end_date, ce.event_date) AS end_date,
      ce.event_source,
      ce.created_at,
      u.display_name AS creator_name,
      COALESCE((
        SELECT GROUP_CONCAT(
          cl.id || '::' || cl.name || '::' || cl.color || '::' || COALESCE(cl.description, ''),
          '||'
        )
        FROM calendar_event_labels cel
        JOIN calendar_labels cl ON cl.id = cel.label_id
        WHERE cel.event_id = ce.id
      ), '') AS labels_raw,
      COALESCE((
        SELECT GROUP_CONCAT(
          usr.id || '::' || usr.username || '::' || usr.display_name || '::' || usr.role,
          '||'
        )
        FROM calendar_event_users ceu
        JOIN users usr ON usr.id = ceu.user_id
        WHERE ceu.event_id = ce.id
      ), '') AS tagged_users_raw
    FROM calendar_events ce
    JOIN users u ON u.id = ce.created_by
    WHERE ce.is_deleted = 0
      AND ce.event_source = 'manual'
      ${allActive ? "" : "AND date(COALESCE(ce.end_date, ce.event_date)) >= date(?) AND date(ce.event_date) <= date(?)"}
    ORDER BY ce.event_date ASC, ce.created_at ASC`;

  const rows = allActive
    ? db.prepare(baseQuery).all()
    : db.prepare(baseQuery).all(rangeStart.format("YYYY-MM-DD"), rangeEnd.format("YYYY-MM-DD"));

  return rows.map((ev) => ({
    ...ev,
    labels: parseLabelsRaw(ev.labels_raw),
    tagged_users: parseTaggedUsersRaw(ev.tagged_users_raw),
    is_system: false
  }));
}
function fetchBirthdayEvents({ rangeStart, rangeEnd, birthdayLabel }) {
  const label = birthdayLabel || { id: null, name: "Birthday", color: "#f1c40f", description: "Student birthday" };
  const students = db
    .prepare(
      `SELECT id, full_name, nickname, dob
       FROM students
       WHERE dob IS NOT NULL AND TRIM(dob) <> ''`
    )
    .all();

  const startYear = rangeStart.year();
  const endYear = rangeEnd.year();
  const events = [];

  for (const st of students) {
    const dm = parseStudentDobDayMonth(st.dob);
    if (!dm) continue;

    for (let y = startYear; y <= endYear; y += 1) {
      const dateStr = `${y}-${String(dm.month).padStart(2, "0")}-${String(dm.day).padStart(2, "0")}`;
      const d = dayjs(dateStr);
      if (!d.isValid()) continue;
      if (d.isBefore(rangeStart, "day") || d.isAfter(rangeEnd, "day")) continue;

      const displayName = String(st.nickname || st.full_name || "Student").trim();
      events.push({
        id: `birthday-${st.id}-${y}`,
        title: `Birthday: ${displayName}`,
        details: `Auto-generated from student DOB (${st.dob})`,
        event_date: d.format("YYYY-MM-DD"),
        end_date: d.format("YYYY-MM-DD"),
        event_source: "system_birthday",
        created_at: "",
        creator_name: "System",
        labels: [label],
        tagged_users: [],
        is_system: true,
        source_student_id: st.id
      });
    }
  }

  events.sort((a, b) => {
    if (a.event_date < b.event_date) return -1;
    if (a.event_date > b.event_date) return 1;
    return String(a.title).localeCompare(String(b.title));
  });

  return events;
}

function buildCalendarWeeks(monthStart, eventsForGrid) {
  const offsetFromMonday = (monthStart.day() + 6) % 7;
  const gridStart = monthStart.subtract(offsetFromMonday, "day");
  const colorPalette = ["#6aa84f", "#e0b525", "#6a4fa3", "#3f6fae", "#b33771", "#f39c12", "#2a9d8f"];

  const normalizedEvents = eventsForGrid.map((ev, idx) => {
    let start = dayjs(ev.event_date);
    let end = dayjs(ev.end_date || ev.event_date);
    if (end.isBefore(start, "day")) {
      const t = start;
      start = end;
      end = t;
    }

    const primaryLabel = ev.labels && ev.labels.length ? ev.labels[0] : null;
    const fallbackColor = colorPalette[idx % colorPalette.length];
    return {
      ...ev,
      start,
      end,
      color: primaryLabel ? normalizeHexColor(primaryLabel.color, fallbackColor) : fallbackColor
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
        labels: ev.labels || [],
        taggedUsers: ev.tagged_users || [],
        isSystem: !!ev.is_system,
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

  return weeks;
}

router.get("/dashboard", (req, res) => {
  res.render("teacher-dashboard", { user: req.session.user });
});

router.get("/reward", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  res.render("teacher-classes", { classes, mode: "reward" });
});

router.get("/reward/:classId", (req, res) => {
  const classId = Number(req.params.classId);
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!cls) return res.status(404).send("Class not found");

  const students = db
    .prepare(
      `SELECT s.id, s.nickname, s.full_name, COALESCE(NULLIF(s.photo_path, ''), NULLIF(s.photo_url, '')) AS photo_src, COALESCE(SUM(pl.points), 0) AS total_points
       FROM students s
       LEFT JOIN point_logs pl ON pl.student_id = s.id
       WHERE s.class_id = ?
       GROUP BY s.id
       ORDER BY s.nickname ASC`
    )
    .all(classId);

  const reasons = db.prepare("SELECT id, reason, reason_type, is_custom FROM point_reasons ORDER BY reason_type ASC, reason ASC").all();
  const customReasons = reasons.filter((r) => Number(r.is_custom) === 1);
  res.render("teacher-reward", {
    cls,
    classes,
    students,
    reasons,
    customReasons,
    user: req.session.user,
    error: req.query.error || null,
    success: req.query.success || null
  });
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
  if (points === 0) {
    return res.status(400).send("Points cannot be zero");
  }

  const reasonType = points > 0 ? "positive" : "negative";
  const reasonBase = (req.body.reason || "").trim();
  const customReason = (req.body.custom_reason || "").trim();
  const reason = customReason || reasonBase;
  if (!reason) {
    return res.status(400).send("Reason is required");
  }

  const student = db.prepare("SELECT id FROM students WHERE id = ? AND class_id = ?").get(studentId, classId);
  if (!student) return res.status(404).send("Student not found");

  const now = dayjs().toISOString();

  if (reasonBase && !customReason) {
    const selectedReason = db.prepare("SELECT reason_type FROM point_reasons WHERE reason = ?").get(reasonBase);
    if (!selectedReason) {
      return res.status(400).send("Selected reason not found");
    }
    const selectedType = String(selectedReason.reason_type || "positive").toLowerCase();
    if (selectedType !== reasonType) {
      return res.status(400).send("Selected reason type does not match points sign");
    }
  }

  if (customReason) {
    const existingReason = db.prepare("SELECT id, reason_type FROM point_reasons WHERE reason = ?").get(customReason);
    if (existingReason) {
      const existingType = String(existingReason.reason_type || "positive").toLowerCase();
      if (existingType !== reasonType) {
        return res.status(400).send("Custom reason already exists with opposite type. Use a different reason text.");
      }
    } else {
      db.prepare(
        `INSERT INTO point_reasons (reason, reason_type, created_by, is_custom, created_at)
         VALUES (?, ?, ?, 1, ?)`
      ).run(customReason, reasonType, req.session.user.id, now);
    }
  }

  db.prepare(
    `INSERT INTO point_logs (student_id, class_id, points, reason, awarded_by, awarded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(studentId, classId, points, reason, req.session.user.id, now);

  updateDailySnapshot(studentId);
  res.redirect(`/teacher/reward/${classId}`);
});

router.post("/reasons/manage", (req, res) => {
  const classId = Number(req.body.class_id || 0);
  const reasonId = Number(req.body.reason_id || 0);
  const operation = String(req.body.operation || "").trim().toLowerCase();
  const newReason = String(req.body.new_reason || "").trim();

  const redirectBase = classId ? `/teacher/reward/${classId}` : "/teacher/reward";
  if (!reasonId) {
    return res.redirect(`${redirectBase}?error=${encodeURIComponent("Select a custom reason first")}`);
  }
  if (!["edit", "delete"].includes(operation)) {
    return res.redirect(`${redirectBase}?error=${encodeURIComponent("Invalid reason action")}`);
  }

  const target = db.prepare("SELECT id, reason, reason_type, is_custom FROM point_reasons WHERE id = ?").get(reasonId);
  if (!target || Number(target.is_custom) !== 1) {
    return res.redirect(`${redirectBase}?error=${encodeURIComponent("Only custom reasons can be managed")}`);
  }

  if (operation === "edit") {
    if (!newReason) {
      return res.redirect(`${redirectBase}?error=${encodeURIComponent("New reason text is required for edit")}`);
    }
    if (newReason === target.reason) {
      return res.redirect(`${redirectBase}?success=${encodeURIComponent("No changes applied")}`);
    }

    const existing = db.prepare("SELECT id FROM point_reasons WHERE reason = ? AND id <> ?").get(newReason, reasonId);
    if (existing) {
      return res.redirect(`${redirectBase}?error=${encodeURIComponent("Reason already exists")}`);
    }

    const tx = db.transaction(() => {
      db.prepare("UPDATE point_reasons SET reason = ? WHERE id = ? AND is_custom = 1").run(newReason, reasonId);
      db.prepare("UPDATE point_logs SET reason = ? WHERE reason = ?").run(newReason, target.reason);
    });
    tx();

    return res.redirect(`${redirectBase}?success=${encodeURIComponent("Custom reason updated")}`);
  }

  const usage = db.prepare("SELECT COUNT(*) AS total FROM point_logs WHERE reason = ?").get(target.reason);
  if (Number((usage || {}).total || 0) > 0) {
    return res.redirect(
      `${redirectBase}?error=${encodeURIComponent("Cannot delete: this reason is already used in point history. Edit it instead.")}`
    );
  }

  db.prepare("DELETE FROM point_reasons WHERE id = ? AND is_custom = 1").run(reasonId);
  return res.redirect(`${redirectBase}?success=${encodeURIComponent("Custom reason deleted")}`);
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
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
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
      `SELECT sib.id, sib.student_id, sib.full_name, sib.nickname, c.name AS class_name
       FROM student_siblings ss
       JOIN students sib ON sib.id = ss.sibling_student_pk
       JOIN classes c ON c.id = sib.class_id
       WHERE ss.student_pk = ?
       ORDER BY sib.full_name ASC`
    )
    .all(studentPk);

  res.render("student-detail", { student, siblings, classes });
});

router.get("/students/code/:externalStudentId", (req, res) => {
  const externalStudentId = String(req.params.externalStudentId || "").trim();
  if (!externalStudentId) return res.status(404).send("Student not found");

  const student = db.prepare("SELECT id FROM students WHERE student_id = ?").get(externalStudentId);
  if (!student) return res.status(404).send("Student not found");

  return res.redirect(`/teacher/students/${student.id}`);
});

router.get("/calendar/labels", (req, res) => {
  res.json({ labels: listCalendarLabels() });
});

router.post("/calendar/labels/add", (req, res) => {
  const name = String(req.body.label_name || "").trim();
  const color = normalizeHexColor(req.body.label_color, "#3f6fae");
  const description = String(req.body.label_description || "").trim();
  const redirectMonth = String(req.body.redirect_month || "").trim();

  if (!name) {
    return res.redirect(`/teacher/calendar?error=${encodeURIComponent("Label name is required")}${redirectMonth ? `&month=${encodeURIComponent(redirectMonth)}` : ""}`);
  }

  try {
    db.prepare(
      `INSERT INTO calendar_labels (name, color, description, created_by, is_system, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    ).run(name, color, description || null, req.session.user.id, dayjs().toISOString());

    return res.redirect(`/teacher/calendar?success=${encodeURIComponent("Label created")}${redirectMonth ? `&month=${encodeURIComponent(redirectMonth)}` : ""}`);
  } catch (err) {
    return res.redirect(`/teacher/calendar?error=${encodeURIComponent(`Label creation failed: ${err.message}`)}${redirectMonth ? `&month=${encodeURIComponent(redirectMonth)}` : ""}`);
  }
});


router.get("/calendar/staff", (req, res) => {
  const all = listStaffUsers();
  res.json({
    all,
    teachers: all.filter((u) => u.role === "teacher"),
    staffs: all.filter((u) => u.role === "staff")
  });
});

router.get("/calendar/events", (req, res) => {
  const { monthStart, gridStart, gridEnd } = getCalendarRange(req.query.month);
  const labels = listCalendarLabels();
  const birthdayLabel = labels.find((l) => l.name === "Birthday");

  const manual = fetchManualEvents({ rangeStart: gridStart, rangeEnd: gridEnd, allActive: false });
  const birthdays = fetchBirthdayEvents({ rangeStart: gridStart, rangeEnd: gridEnd, birthdayLabel });
  const events = [...manual, ...birthdays].sort((a, b) => {
    if (a.event_date < b.event_date) return -1;
    if (a.event_date > b.event_date) return 1;
    return String(a.title).localeCompare(String(b.title));
  });

  res.json({
    month: monthStart.format("YYYY-MM"),
    range: { start: gridStart.format("YYYY-MM-DD"), end: gridEnd.format("YYYY-MM-DD") },
    labels,
    events
  });
});

router.get("/calendar", (req, res) => {
  const { monthStart, gridStart, gridEnd } = getCalendarRange(req.query.month);
  const labels = listCalendarLabels();
  const birthdayLabel = labels.find((l) => l.name === "Birthday");

  const manualRangeEvents = fetchManualEvents({ rangeStart: gridStart, rangeEnd: gridEnd, allActive: false });
  const birthdayRangeEvents = fetchBirthdayEvents({ rangeStart: gridStart, rangeEnd: gridEnd, birthdayLabel });
  const eventsForGrid = [...manualRangeEvents, ...birthdayRangeEvents].sort((a, b) => {
    if (a.event_date < b.event_date) return -1;
    if (a.event_date > b.event_date) return 1;
    return String(a.title).localeCompare(String(b.title));
  });

    const allManualEvents = fetchManualEvents({ rangeStart: gridStart, rangeEnd: gridEnd, allActive: true });
  const allTaggableUsers = listStaffUsers();
  const teacherUsers = allTaggableUsers.filter((u) => u.role === "teacher");
  const supportUsers = allTaggableUsers.filter((u) => u.role === "staff");

  const teacherIdSet = new Set(teacherUsers.map((u) => Number(u.id)));
  const staffIdSet = new Set(supportUsers.map((u) => Number(u.id)));

  const allEvents = [...allManualEvents, ...birthdayRangeEvents]
    .map((ev) => {
      const tagged = ev.tagged_users || [];
      const taggedIds = tagged.map((u) => Number(u.id));
      const teacherTagged = taggedIds.filter((id) => teacherIdSet.has(id));
      const staffTagged = taggedIds.filter((id) => staffIdSet.has(id));

      let tag_scope = "";
      if (taggedIds.length) {
        if (taggedIds.length === allTaggableUsers.length) {
          tag_scope = "all";
        } else if (teacherTagged.length && !staffTagged.length && teacherTagged.length === teacherUsers.length) {
          tag_scope = "all_teachers";
        } else if (staffTagged.length && !teacherTagged.length && staffTagged.length === supportUsers.length) {
          tag_scope = "all_staffs";
        } else if (teacherTagged.length && !staffTagged.length) {
          tag_scope = "teachers";
        } else if (staffTagged.length && !teacherTagged.length) {
          tag_scope = "staffs";
        } else {
          tag_scope = "all";
        }
      }

      return {
        ...ev,
        canEdit: !ev.is_system,
        canDelete: false,
        tag_scope,
        tagged_teacher_ids: teacherTagged,
        tagged_staff_ids: staffTagged
      };
    })
    .sort((a, b) => {
      if (a.event_date < b.event_date) return -1;
      if (a.event_date > b.event_date) return 1;
      return String(a.title).localeCompare(String(b.title));
    });

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

  const weeks = buildCalendarWeeks(monthStart, eventsForGrid);

  res.render("teacher-calendar", {
    user: req.session.user,
    monthLabel: monthStart.format("MMMM YYYY"),
    monthKey: monthStart.format("YYYY-MM"),
    prevMonth: monthStart.subtract(1, "month").format("YYYY-MM"),
    nextMonth: monthStart.add(1, "month").format("YYYY-MM"),
    weeks,
    allEvents,
    deletedLogs,
    labels,
    teacherUsers,
    staffUsers: supportUsers,
    allTaggableUsers,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.post("/calendar/add", (req, res) => {
  const title = (req.body.title || "").trim();
  const details = (req.body.details || "").trim();
  const eventDate = (req.body.event_date || "").trim();
  const endDate = (req.body.end_date || eventDate).trim();
  const labelIds = parseLabelIds(req.body.label_ids);
  const tagScope = String(req.body.tag_scope || "").trim().toLowerCase();
  const taggedUserIds = resolveTaggedUserIds(tagScope, req.body.tag_teacher_ids, req.body.tag_staff_ids);

  if (!title || !eventDate) return res.status(400).send("Title and start date are required");
  if (dayjs(endDate).isBefore(dayjs(eventDate), "day")) return res.status(400).send("End date cannot be earlier than start date");

  const now = dayjs().toISOString();
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO calendar_events (title, details, event_date, end_date, event_source, created_by, created_at, is_deleted)
         VALUES (?, ?, ?, ?, 'manual', ?, ?, 0)`
      )
      .run(title, details, eventDate, endDate, req.session.user.id, now);

    const eventId = Number(info.lastInsertRowid);
    assignEventLabels(eventId, labelIds);
    assignEventTaggedUsers(eventId, taggedUserIds);
  });

  tx();
  const monthKey = dayjs(eventDate).format("YYYY-MM");
  res.redirect(`/teacher/calendar?month=${monthKey}&success=${encodeURIComponent("Event created")}`);
});

router.post("/calendar/update/:eventId", (req, res) => {
  const eventId = Number(req.params.eventId);
  const title = (req.body.title || "").trim();
  const details = (req.body.details || "").trim();
  const eventDate = (req.body.event_date || "").trim();
  const endDate = (req.body.end_date || eventDate).trim();
  const labelIds = parseLabelIds(req.body.label_ids);
  const tagScope = String(req.body.tag_scope || "").trim().toLowerCase();
  const taggedUserIds = resolveTaggedUserIds(tagScope, req.body.tag_teacher_ids, req.body.tag_staff_ids);

  if (!eventId || !title || !eventDate) {
    return res.status(400).send("Event ID, title and start date are required");
  }
  if (dayjs(endDate).isBefore(dayjs(eventDate), "day")) {
    return res.status(400).send("End date cannot be earlier than start date");
  }

  const target = db
    .prepare("SELECT id FROM calendar_events WHERE id = ? AND is_deleted = 0 AND event_source = 'manual'")
    .get(eventId);
  if (!target) return res.status(404).send("Event not found or not editable");

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE calendar_events
       SET title = ?, details = ?, event_date = ?, end_date = ?
       WHERE id = ? AND is_deleted = 0 AND event_source = 'manual'`
    ).run(title, details, eventDate, endDate, eventId);

    assignEventLabels(eventId, labelIds);
    assignEventTaggedUsers(eventId, taggedUserIds);
  });

  tx();
  const monthKey = dayjs(eventDate).format("YYYY-MM");
  return res.redirect(`/teacher/calendar?month=${monthKey}&success=${encodeURIComponent("Event updated")}`);
});

router.post("/calendar/delete/:eventId", (_req, res) => {
  return res.status(403).send("Only admin can delete events");
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
























