// The welcome page's first lines wait for their translation, then rise in once (welcome.css).
// If the page is not ready within 700ms they simply show, so nothing stays hidden.
document.documentElement.classList.add("m-enter");
setTimeout(() => document.documentElement.classList.add("m-enter-done"), 700);
