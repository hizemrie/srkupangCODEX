(function () {
  var table = document.getElementById("leaderboardTable");
  if (!table) return;

  var classId = table.getAttribute("data-class-id");
  var rowsContainer = document.getElementById("leaderboardRows");
  var lastUpdated = document.getElementById("lastUpdated");

  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      var pa = Number(a.total_points || 0);
      var pb = Number(b.total_points || 0);
      if (pb !== pa) return pb - pa;
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
        nickname: String(row.nickname || "?"),
        total_points: pts,
        rank: rank
      };
    });
  }

  function rowMarkup(row) {
    var rankClass = row.rank <= 3 ? "rank-" + row.rank : "rank-0";
    var firstChar = row.nickname.charAt(0).toUpperCase() || "?";
    var points = Number(row.total_points || 0).toLocaleString();

    return (
      '<article class="leaderboard-row ' + rankClass + '">' +
        '<div class="avatar-dot">' + firstChar + '</div>' +
        '<div class="name-block">' +
          '<div class="name-text">' + row.nickname + '</div>' +
          '<div class="points-text">' + points + ' points</div>' +
        '</div>' +
        '<div class="rank-badge">' + row.rank + '</div>' +
      '</article>'
    );
  }

  function refresh() {
    fetch("/api/leaderboard/" + classId)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var ordered = sortRows(data.rows || []);
        var ranked = withRanks(ordered);
        rowsContainer.innerHTML = ranked.map(rowMarkup).join("");
        if (lastUpdated) {
          lastUpdated.textContent = "Last updated: " + new Date(data.timestamp).toLocaleString();
        }
      })
      .catch(function () {});
  }

  setInterval(refresh, 3000);
})();
