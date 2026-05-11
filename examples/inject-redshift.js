// paw eval @inject-redshift.js
// — slowly drift the page hue, demo of file-injection power
(() => {
  if (window.__redshift) {
    clearInterval(window.__redshift);
    document.body.style.filter = "";
    delete window.__redshift;
    return "stopped";
  }
  let h = 0;
  window.__redshift = setInterval(() => {
    h = (h + 5) % 360;
    document.body.style.filter = `hue-rotate(${h}deg)`;
  }, 50);
  return "started — run again to stop";
})();
