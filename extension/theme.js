// Put the user's Light or Dark choice on the page before it first paints, so it never flashes in
// the other theme. The choice is saved with the settings; settings.js (applyTheme) keeps this copy
// in localStorage because chrome.storage can't be read this early. No choice = follow Windows.
try {
  const theme = localStorage.getItem("linkunzip-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // Storage blocked: the page follows Windows until the settings load.
}
