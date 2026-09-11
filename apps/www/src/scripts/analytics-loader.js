(function () {
  var loader = document.currentScript;
  if (
    !(loader instanceof HTMLScriptElement) ||
    window.location.hostname !== loader.dataset.analyticsHost
  )
    return;

  window.addEventListener(
    "load",
    function () {
      if (document.querySelector("script[data-cf-beacon]")) return;

      var beacon = document.createElement("script");
      beacon.async = true;
      beacon.src = "https://static.cloudflareinsights.com/beacon.min.js";
      beacon.dataset.cfBeacon = JSON.stringify({
        token: loader.dataset.analyticsToken,
      });
      document.head.append(beacon);
    },
    { once: true },
  );
})();
