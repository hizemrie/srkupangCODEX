(function () {
  var timeoutMs = 2 * 60 * 1000;
  var timer;

  function ping() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var form = document.createElement("form");
      form.method = "POST";
      form.action = "/logout";
      document.body.appendChild(form);
      form.submit();
    }, timeoutMs);
  }

  ["mousemove", "mousedown", "keydown", "touchstart", "scroll"].forEach(function (eventName) {
    document.addEventListener(eventName, ping, true);
  });

  ping();
})();
