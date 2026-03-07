(function () {
  var table = document.getElementById("leaderboardTable");
  if (!table) return;

  var classId = table.getAttribute("data-class-id");
  var rowsContainer = document.getElementById("leaderboardRows");
  var podiumContainer = document.getElementById("leaderboardPodium");
  var lastUpdated = document.getElementById("lastUpdated");
  var initialRowsEl = document.getElementById("leaderboardInitialRows");
  var menuBtn = document.getElementById("leaderboardMenuBtn");
  var menuPanel = document.getElementById("leaderboardMenuPanel");
  var sortMenuItems = Array.prototype.slice.call(document.querySelectorAll("[data-sort-mode]"));

  var sortMode = "desc";
  var latestRows = [];

  function parseInitialRows() {
    if (!initialRowsEl) return [];
    try {
      return JSON.parse(initialRowsEl.textContent || "[]");
    } catch (_) {
      return [];
    }
  }

  function avatarFromRow(row) {
    var photo = String(row.photo_url || "").trim();
    if (photo) return photo;
    var seed = encodeURIComponent(String(row.nickname || "student"));
    return "https://api.dicebear.com/7.x/adventurer/svg?seed=" + seed;
  }

  function sortRows(rows, mode) {
    return rows.slice().sort(function (a, b) {
      var pa = Number(a.total_points || 0);
      var pb = Number(b.total_points || 0);
      if (pa !== pb) return mode === "asc" ? pa - pb : pb - pa;
      var na = String(a.nickname || "").toLowerCase();
      var nb = String(b.nickname || "").toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    });
  }

  function withRanks(rows) {
    var prevPts = null;
    var prevRank = 0;
    return rows.map(function (row, index) {
      var pts = Number(row.total_points || 0);
      var rank = (prevPts !== null && pts === prevPts) ? prevRank : (index + 1);
      prevPts = pts;
      prevRank = rank;
      return {
        id: row.id,
        nickname: String(row.nickname || "?"),
        photo_url: avatarFromRow(row),
        total_points: pts,
        rank: rank,
        last_awarded_at: row.last_awarded_at || "",
        last_reason: row.last_reason || ""
      };
    });
  }

  function ordinal(rank) {
    var n = Number(rank);
    var mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return n + "th";
    var mod10 = n % 10;
    if (mod10 === 1) return n + "st";
    if (mod10 === 2) return n + "nd";
    if (mod10 === 3) return n + "rd";
    return n + "th";
  }

  function shortDate(iso) {
    if (!iso) return "-";
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleDateString();
  }

  function safeReason(reason) {
    var text = String(reason || "").trim();
    return text || "-";
  }

  function podiumCard(row, slotClass) {
    return (
      '<article class="podium-card ' + slotClass + '">' +
        '<div class="wreath-badge">' + ordinal(row.rank) + '</div>' +
        '<img class="podium-photo" src="' + row.photo_url + '" alt="' + row.nickname + '" />' +
        '<div class="podium-name">' + row.nickname + '</div>' +
        '<div class="podium-points">' + row.total_points.toLocaleString() + '</div>' +
        '<div class="podium-meta">' +
          '<div class="podium-last-date">Last awarded: ' + shortDate(row.last_awarded_at) + '</div>' +
          '<div class="podium-last-reason">Reason: ' + safeReason(row.last_reason) + '</div>' +
        '</div>' +
      '</article>'
    );
  }

  function listRow(row) {
    return (
      '<article class="leaderboard-row layout-ref rank-' + (row.rank <= 3 ? row.rank : 0) + '">' +
        '<div class="row-left">' +
          '<img class="avatar-photo" src="' + row.photo_url + '" alt="' + row.nickname + '" />' +
          '<div class="name-block">' +
            '<div class="name-text">' + row.nickname + '</div>' +
            '<div class="points-text">' + row.total_points.toLocaleString() + ' points</div>' +
          '</div>' +
        '</div>' +
        '<div class="row-mid">' +
          '<div class="mid-line">Last awarded: ' + shortDate(row.last_awarded_at) + '</div>' +
          '<div class="mid-line">Reason: ' + safeReason(row.last_reason) + '</div>' +
        '</div>' +
        '<div class="row-right">' +
          '<span class="wreath-badge small clean">' + ordinal(row.rank) + '</span>' +
        '</div>' +
      '</article>'
    );
  }

  function render(rows) {
    var ordered = sortRows(rows, sortMode);
    var ranked = withRanks(ordered);

    var top = ranked.slice(0, 3);
    var rest = ranked.slice(3);

    var arrangedTop = [top[1], top[0], top[2]].filter(Boolean);
    var slotByRank = { 1: "first", 2: "second", 3: "third" };

    podiumContainer.innerHTML = arrangedTop.map(function (r) { return podiumCard(r, slotByRank[r.rank] || ""); }).join("");
    rowsContainer.innerHTML = rest.map(listRow).join("");
  }

  function setSortMode(nextMode) {
    sortMode = nextMode;
    sortMenuItems.forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-sort-mode") === sortMode);
    });
    render(latestRows);
  }

  function refresh() {
    fetch("/api/leaderboard/" + classId)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        latestRows = data.rows || [];
        render(latestRows);
        if (lastUpdated) lastUpdated.textContent = "Last updated: " + new Date(data.timestamp).toLocaleString();
      })
      .catch(function () {});
  }

  if (menuBtn && menuPanel) {
    menuBtn.addEventListener("click", function () {
      var isOpen = !menuPanel.classList.contains("hidden");
      menuPanel.classList.toggle("hidden", isOpen);
      menuBtn.setAttribute("aria-expanded", String(!isOpen));
    });

    document.addEventListener("click", function (e) {
      if (!menuPanel.classList.contains("hidden") && !menuPanel.contains(e.target) && !menuBtn.contains(e.target)) {
        menuPanel.classList.add("hidden");
        menuBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  sortMenuItems.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setSortMode(btn.getAttribute("data-sort-mode") || "desc");
      if (menuPanel) menuPanel.classList.add("hidden");
      if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
    });
  });

  latestRows = parseInitialRows();
  render(latestRows);
  setInterval(refresh, 3000);
})();
