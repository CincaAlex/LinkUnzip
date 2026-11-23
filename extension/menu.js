// A small popup menu: a button and a list of commands in a native popover (Chrome 114+), with
// the keys menus have: ArrowDown/ArrowUp/Home/End move, Escape and Tab close, focus goes back to
// the button. Newer platform pieces (commandfor, focusgroup, anchor positioning) need Chrome 125
// to 135; this works from the extension's minimum (116), so it sets the roles and keys itself and
// places the menu next to its button with a few lines of script.

import { h } from "./dom.js";

let next = 0;

/** `items`: [{ label, onSelect }]. Returns the button; the menu follows it in the DOM. */
export function menu(label, items) {
  const id = `menu-${++next}`;
  const btn = h("button", { type: "button", class: "link small menu-btn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": id }, label);
  const list = h("div", { id, class: "menu", popover: "auto", role: "menu", "aria-label": label });
  const entries = items.filter(Boolean).map((item) =>
    h(
      "button",
      {
        type: "button",
        role: "menuitem",
        tabindex: "-1",
        onclick: () => {
          list.hidePopover();
          item.onSelect();
        },
      },
      item.label,
    ),
  );
  list.append(...entries);

  let viaKeys = false;
  const focusItem = (i) => entries[(i + entries.length) % entries.length]?.focus();
  const place = () => {
    // Above the button when there is room (it sits at the bottom of the file list), right-aligned.
    const b = btn.getBoundingClientRect();
    const m = list.getBoundingClientRect();
    const top = b.top - m.height - 4 >= 0 ? b.top - m.height - 4 : Math.min(b.bottom + 4, innerHeight - m.height);
    const left = Math.max(4, Math.min(b.right - m.width, innerWidth - m.width - 4));
    list.style.top = `${Math.round(top)}px`;
    list.style.left = `${Math.round(left)}px`;
  };
  const open = (keys) => {
    viaKeys = keys;
    if (!list.matches(":popover-open")) list.showPopover();
  };

  btn.addEventListener("click", (e) => {
    if (list.matches(":popover-open")) return list.hidePopover();
    open(e.detail === 0); // detail 0: Enter or Space, not a pointer
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    open(true);
    focusItem(e.key === "ArrowDown" ? 0 : -1);
  });
  list.addEventListener("toggle", (e) => {
    const isOpen = e.newState === "open";
    btn.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) {
      place();
      if (viaKeys) focusItem(0);
    } else if (list.contains(document.activeElement) || document.activeElement === document.body) {
      btn.focus();
    }
  });
  list.addEventListener("keydown", (e) => {
    const at = entries.indexOf(document.activeElement);
    const keys = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: -1 };
    if (e.key in keys) {
      e.preventDefault();
      focusItem(keys[e.key]);
    } else if (e.key === "Tab") {
      // Tab leaves the menu: back on its button, so the next Tab goes on from there.
      e.preventDefault();
      list.hidePopover();
      btn.focus();
    }
  });
  // Pointer over an item focuses it, so hover and keyboard agree on one item.
  list.addEventListener("pointermove", (e) => {
    const item = e.target.closest('[role="menuitem"]');
    if (item && document.activeElement !== item) item.focus({ focusVisible: false });
  });
  return h("span", { class: "menu-wrap" }, btn, list);
}
