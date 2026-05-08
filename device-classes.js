  (function () {
    var u = navigator.userAgent || "";
    var mob =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(u);
    var ipad =
      !mob &&
      navigator.platform === "MacIntel" &&
      navigator.maxTouchPoints > 1;
    var isTablet =
      /iPad/i.test(u) ||
      ipad ||
      (/Android/i.test(u) && !/Mobile/i.test(u));
    if (mob || ipad) document.documentElement.classList.add("mobile-adapt");
    if (isTablet) document.documentElement.classList.add("tablet-adapt");
  })();
