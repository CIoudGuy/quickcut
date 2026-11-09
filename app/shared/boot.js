// Runs before first paint (render-blocking, tiny): interface size and theme, so nothing jumps.
    (function () {
      var z = NaN, t = null;
      try { z = parseFloat(localStorage.getItem("quickcut.zoom")); t = localStorage.getItem("quickcut.theme"); } catch (e) {}
      if (!(z >= 0.7 && z <= 1.6)) z = matchMedia("(max-width: 599px)").matches ? 1 : 1.1;
      var r = document.documentElement;
      // the tab you were on: set now so the tab pill is drawn in place (no slide from Photo)
      var tools = ["photo", "video", "color"], h = location.hash.slice(1), last = null;
      try { last = localStorage.getItem("quickcut.tab"); } catch (e) {}
      r.dataset.tool = tools.indexOf(h) >= 0 ? h : tools.indexOf(last) >= 0 ? last : "photo";
      r.style.zoom = z; r.style.setProperty("--zoom", z);
      if (t === "light" || t === "dark") r.dataset.theme = t;
      else if (matchMedia("(prefers-color-scheme: light)").matches) r.dataset.theme = "light";
    })();
