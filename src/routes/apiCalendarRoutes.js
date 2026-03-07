const express = require("express");
const multer = require("multer");
const dayjs = require("dayjs");
const { db } = require("../db/init");
const { requireRole } = require("../middleware/auth");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(requireRole("admin"));

function toBool(value) {
  if (typeof value === "boolean") return value;
  const s = String(value || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function parsePayload(req) {
  if (Array.isArray(req.body)) return req.body;

  if (Array.isArray(req.body.events)) return req.body.events;

  if (typeof req.body.events_json === "string" && req.body.events_json.trim()) {
    const parsed = JSON.parse(req.body.events_json);
    if (!Array.isArray(parsed)) throw new Error("events_json must be a JSON array");
    return parsed;
  }

  if (typeof req.body.json_text === "string" && req.body.json_text.trim()) {
    const parsed = JSON.parse(req.body.json_text);
    if (!Array.isArray(parsed)) throw new Error("json_text must be a JSON array");
    return parsed;
  }

  if (req.file && req.file.buffer) {
    const parsed = JSON.parse(req.file.buffer.toString("utf8"));
    if (!Array.isArray(parsed)) throw new Error("uploaded file must contain a JSON array");
    return parsed;
  }

  throw new Error("No event array provided");
}

function normalizeLabelName(name) {
  return String(name || "").trim();
}

function colorFromLabelName(name) {
  const s = String(name || "Label");
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = s.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

router.post("/import", upload.single("events_file"), (req, res) => {
  let events;
  try {
    events = parsePayload(req);
  } catch (err) {
    return res.status(400).json({
      inserted: 0,
      skipped: 0,
      errors: [String(err.message || err)]
    });
  }

  const now = dayjs().toISOString();
  const createdBy = req.session.user.id;

  const findDup = db.prepare(
    `SELECT id
     FROM calendar_events
     WHERE is_deleted = 0 AND title = ? AND event_date = ?
     LIMIT 1`
  );
  const insertEvent = db.prepare(
    `INSERT INTO calendar_events
     (title, details, event_date, end_date, event_source, created_by, created_at, is_deleted)
     VALUES (?, ?, ?, ?, 'manual', ?, ?, 0)`
  );
  const findLabel = db.prepare("SELECT id FROM calendar_labels WHERE name = ?");
  const insertLabel = db.prepare(
    `INSERT INTO calendar_labels (name, color, description, created_by, is_system, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  );
  const insertEventLabel = db.prepare(
    `INSERT OR IGNORE INTO calendar_event_labels (event_id, label_id)
     VALUES (?, ?)`
  );

  let inserted = 0;
  let skipped = 0;
  const errors = [];

  const tx = db.transaction((rows) => {
    rows.forEach((raw, index) => {
      const rowNo = index + 1;
      const title = String(raw.title || "").trim();
      const startDate = String(raw.start_date || "").trim();
      const endDateRaw = String(raw.end_date || "").trim();
      const endDate = endDateRaw || startDate;
      const description = String(raw.description || raw.details || "").trim();
      const _allDay = toBool(raw.all_day);

      if (!title || !startDate) {
        skipped += 1;
        errors.push(`Row ${rowNo}: missing required title/start_date`);
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !dayjs(startDate).isValid()) {
        skipped += 1;
        errors.push(`Row ${rowNo}: invalid start_date (${startDate})`);
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !dayjs(endDate).isValid()) {
        skipped += 1;
        errors.push(`Row ${rowNo}: invalid end_date (${endDate})`);
        return;
      }
      if (dayjs(endDate).isBefore(dayjs(startDate), "day")) {
        skipped += 1;
        errors.push(`Row ${rowNo}: end_date before start_date`);
        return;
      }

      const dup = findDup.get(title, startDate);
      if (dup) {
        skipped += 1;
        return;
      }

      const info = insertEvent.run(title, description, startDate, endDate, createdBy, now);
      const eventId = Number(info.lastInsertRowid);

      const labels = Array.isArray(raw.labels) ? raw.labels : [];
      labels
        .map(normalizeLabelName)
        .filter(Boolean)
        .forEach((labelName) => {
          let label = findLabel.get(labelName);
          if (!label) {
            insertLabel.run(labelName, colorFromLabelName(labelName), null, createdBy, now);
            label = findLabel.get(labelName);
          }
          if (label) {
            insertEventLabel.run(eventId, label.id);
          }
        });

      inserted += 1;
    });
  });

  try {
    tx(events);
  } catch (err) {
    return res.status(500).json({
      inserted,
      skipped,
      errors: [...errors, `Import failed: ${String(err.message || err)}`]
    });
  }

  return res.json({
    inserted,
    skipped,
    errors
  });
});

module.exports = router;
