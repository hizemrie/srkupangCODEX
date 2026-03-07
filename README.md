# SRK Kupang LAN School App

LAN-only web app for:
- Teacher login
- Reward System
- Student details
- Calendar/events
- Leaderboard (live refresh)
- Admin teacher/student management
- CSV student import
- Teacher report export (CSV spreadsheet)

## Default credentials
- Teacher: `hizemrie` / `eirmezih`
- Admin: `admin` / `117911Zam`

## Run
```bash
npm install
npm start
```

Open: `http://<your-lan-ip>:3000`

## CSV import format (Admin)
Headers required:
`class_name,No.SB,student_id,familyID,full_name,nickname,dob,photo_url,emergency_contact`

- `class_name` must match existing class names.
- `familyID` links students in the same family.

## Notes
- Session cookie is browser-session scoped (logout when browser closes).
- Inactivity timeout is 2 minutes (server + client side).
- Daily points snapshots are stored in `daily_points`.

